# fred — Backend de autenticación y throttling

> Documento técnico. Describe cómo se implementa el backend que autentica a los
> usuarios, controla el consumo por tier, y protege los costos de las APIs de IA.
> Esta es la pieza más crítica del producto: si el throttling falla, un usuario del
> plan gratuito puede vaciar la cuenta de AWS.

---

## 1. Objetivo

El backend tiene que cumplir tres funciones, en orden de prioridad:

1. **Proteger los costos.** Ninguna request debe llegar al backend de IA sin haber
   pasado por un control de cuota. Un usuario gratuito no puede generar gasto
   ilimitado.
2. **Autenticar y autorizar.** Identificar quién hace cada request y a qué tier
   pertenece, sin exponer nunca las API keys del proveedor de IA al cliente.
3. **Contabilizar el consumo.** Medir tokens usados por usuario para throttling en
   tiempo real y para facturación.

---

## 2. Principio central

> El cliente (CLI o hub) **nunca** conoce las API keys del backend de IA. Solo el
> proxy interno las tiene. Toda llamada a IA pasa por el backend, que es el único
> componente que habla con Anthropic / Bedrock / Ollama.

Esto significa que comprometer la CLI de un usuario no expone las keys del proveedor,
y que se puede cambiar de backend de IA sin tocar el cliente.

---

## 3. Arquitectura: cuatro capas

Cada request de IA atraviesa cuatro capas antes de tocar el backend de IA. Ninguna es
opcional.

```
   fred CLI / hub
        │  fred-token (JWT)
        ▼
┌───────────────────────────┐
│ 1. API Gateway            │  valida JWT · identifica tenant
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐         ┌──────────────┐
│ 2. Quota checker          │ ◄─────► │ Redis        │
│    lee límites del tier   │         │ counters     │
└───────────────────────────┘         └──────────────┘
        │  dentro de cuota          │ cuota agotada
        ▼                           ▼
┌───────────────────────────┐    [ 429 rechazado ]
│ 3. Proxy IA               │    inyecta keys · mide tokens
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│    AWS Bedrock / Anthropic │
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 4. Actualiza contador      │  tokens usados → Redis + DB
└───────────────────────────┘
```

---

## 4. Capa 1 — API Gateway con JWT

### Registro y emisión del token

La CLI se autentica **una sola vez** al registrarse (email + password, OAuth, o un
device code para la CLI) y recibe un `fred-token`, que es un JWT firmado. Ese token
viaja en cada request posterior en el header `Authorization: Bearer <token>`.

### Contenido del JWT

El payload del JWT incluye, como mínimo:

```json
{
  "sub": "user_abc123",
  "tenant": "tenant_xyz",
  "tier": "developer",
  "iat": 1718400000,
  "exp": 1718403600
}
```

- `sub` — identificador del usuario.
- `tenant` — organización a la que pertenece (relevante para aislamiento en
  Business/Enterprise).
- `tier` — plan actual; determina los límites de cuota.
- `exp` — expiración corta; se renueva con un refresh token.

### Qué hace el gateway

1. Verifica la firma del JWT (rechaza si es inválida o expiró).
2. Extrae `sub`, `tenant` y `tier`.
3. Pasa esos valores a la siguiente capa.

> Sin un JWT válido, la request muere aquí. El backend de IA nunca se entera.

---

## 5. Capa 2 — Quota checker con Redis

Antes de cualquier llamada a IA, se consulta un contador en Redis. Redis es crítico
aquí porque las operaciones son **atómicas** y de latencia muy baja; una base de datos
SQL sería demasiado lenta para este check síncrono en el camino de cada request.

### Estructura de claves en Redis

```
quota:user:{user_id}:month     → consultas usadas este mes
quota:user:{user_id}:tokens    → tokens consumidos este mes (opcional)
quota:user:{user_id}:reset     → timestamp de reinicio del periodo
```

### Límites por tier

| Tier | Consultas / mes | Notas |
|---|---|---|
| Developer | 20 | Límite duro; subsidiado |
| Cloud | 100 | |
| Business | 500 | |
| Enterprise | sin límite | Self-hosted o cuota negociada |

### Lógica del check (pseudocódigo)

```
limit = LIMITS[tier]
used  = INCR quota:user:{id}:month      // atómico

if (limit != UNLIMITED && used > limit) {
    DECR quota:user:{id}:month          // revertir el incremento
    return 429 "cuota agotada"
}
// dentro de cuota → continuar
```

> Nota: usar `INCR` y revertir si se excede mantiene la atomicidad. Alternativamente,
> un patrón `GET` + comparación + `INCR` dentro de un script Lua de Redis evita la
> condición de carrera entre el chequeo y el incremento.

### Reinicio del periodo

Un job programado (o TTL sobre las claves) reinicia los contadores al inicio de cada
periodo de facturación. Para cuotas mensuales basta con setear un TTL hasta el fin del
mes o ejecutar un reset programado.

### Rate limiting de ráfaga (opcional pero recomendado)

Además del límite mensual, conviene un límite de ráfaga (p. ej. N requests por minuto)
para evitar abuso puntual. Se implementa con una segunda clave de ventana corta:

```
ratelimit:user:{id}:minute   → con TTL de 60s
```

---

## 6. Capa 3 — Proxy IA

Este es el único componente que conoce las API keys del backend de IA. La CLI nunca
las ve.

### Responsabilidades

1. **Inyectar las keys** del proveedor (Anthropic / Bedrock / Ollama) en la llamada.
2. **Traducir** la request al formato del backend activo (la interfaz interna debe ser
   agnóstica del proveedor; ver sección 9).
3. **Medir los tokens consumidos** en la respuesta (entrada + salida) para
   contabilizarlos.
4. **Devolver** la respuesta al cliente.

### Abstracción del backend

El proxy expone una interfaz interna estable. Cambiar de Anthropic directo a Bedrock o
a Ollama no debe afectar al resto del sistema — solo se cambia la implementación detrás
de la interfaz.

```
interface AIBackend {
  complete(prompt, options) -> { text, tokensIn, tokensOut }
  embed(texts) -> { vectors, tokens }
}
```

---

## 7. Capa 4 — Actualización del contador

Después de cada respuesta del backend de IA:

1. Los **tokens reales consumidos** se escriben de vuelta en Redis (para throttling en
   tiempo real, especialmente si se limita por tokens y no solo por consultas).
2. El consumo se persiste en la **base de datos principal** (DynamoDB o Postgres) como
   historial inmutable para facturación y auditoría.

> Redis es la fuente de verdad para el throttling en caliente. La DB es la fuente de
> verdad para el historial y la facturación. Los dos se actualizan tras cada request.

---

## 8. Protecciones de costo adicionales

Más allá del throttling por usuario, hay dos salvaguardas a nivel de cuenta:

- **Spending alert (CloudWatch).** Una alarma que avisa por email si el gasto diario
  supera un umbral, antes de que se convierta en un problema.
- **Hard cap en la cuenta AWS.** Un límite de gasto máximo absoluto a nivel de cuenta
  que detiene el consumo sin importar qué pase en el código de la aplicación. Es la
  última línea de defensa.

---

## 9. Stack sugerido

| Capa | Componente | Tecnología sugerida |
|---|---|---|
| 1 | API Gateway | AWS API Gateway |
| 2 | Quota checker | ElastiCache Redis |
| 3 | Proxy IA | Lambda o servicio Node/Express |
| 4 | Historial | DynamoDB o Postgres |
| — | Alertas | CloudWatch |
| — | Backend IA | Anthropic directo → Bedrock → Ollama |

Todo dentro de la misma cuenta AWS, con facturación unificada.

---

## 10. Esquema de datos (borrador)

Las tablas mínimas para soportar usuarios, tiers y consumo:

### `users`

| Campo | Tipo | Notas |
|---|---|---|
| `user_id` | string (PK) | |
| `email` | string | único |
| `tenant_id` | string | FK a `tenants` |
| `tier` | enum | developer / cloud / business / enterprise |
| `created_at` | timestamp | |

### `tenants`

| Campo | Tipo | Notas |
|---|---|---|
| `tenant_id` | string (PK) | |
| `name` | string | |
| `plan` | enum | |
| `kms_key_ref` | string | referencia a la clave del cliente (BYOK) |

### `usage_log`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string (PK) | |
| `user_id` | string | FK |
| `timestamp` | timestamp | |
| `operation` | enum | analyze / embed / query |
| `tokens_in` | int | |
| `tokens_out` | int | |
| `cost_estimate` | decimal | calculado al momento |

> El `usage_log` es append-only: nunca se actualiza ni se borra, solo se inserta.
> Es la base para facturación, auditoría y para medir el costo real por usuario.

---

## 11. Flujo completo (resumen end-to-end)

```
1. Usuario se registra → recibe fred-token (JWT)
2. CLI hace una consulta → envía Authorization: Bearer <token>
3. API Gateway valida el JWT → extrae user_id, tenant, tier
4. Quota checker consulta Redis:
     - si cuota agotada → 429, fin (costo cero)
     - si dentro de cuota → continúa
5. Proxy IA inyecta keys, llama al backend de IA, mide tokens
6. Backend de IA responde
7. Se actualiza el contador en Redis + se inserta en usage_log
8. La respuesta vuelve al usuario
```

---

## 12. Decisiones pendientes

1. **Método de autenticación de la CLI.** Device code flow (recomendado para CLIs) vs
   email/password vs OAuth con un proveedor.
2. **Throttling por consultas vs por tokens.** Empezar por consultas (más simple); si
   el consumo varía mucho por consulta, migrar a límite por tokens.
3. **Duración del JWT y estrategia de refresh.** Tokens cortos + refresh token, o
   tokens largos con revocación. El primero es más seguro.
4. **Manejo de upgrades de tier en caliente.** Cuando un usuario sube de plan, el JWT
   viejo aún dice el tier anterior hasta que expira. Definir si se fuerza re-emisión o
   se consulta el tier en la DB en cada request.
5. **Aislamiento multi-tenant.** En Business/Enterprise, garantizar que un tenant
   nunca pueda acceder a datos o cuota de otro.

---

## 13. Próximos pasos de implementación

1. Definir el método de autenticación de la CLI y el formato exacto del JWT.
2. Implementar el endpoint de registro y emisión de tokens.
3. Montar Redis y definir el esquema de claves de cuota.
4. Implementar el quota checker como middleware (con script Lua para atomicidad).
5. Implementar el proxy IA con la interfaz `AIBackend` agnóstica del proveedor.
6. Implementar la escritura de `usage_log` y la actualización de contadores.
7. Configurar las alertas de CloudWatch y el hard cap de la cuenta AWS.
8. Tests de carga para verificar que el throttling aguanta concurrencia.
