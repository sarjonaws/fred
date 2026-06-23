# fred — Modelo de negocio y planes de suscripción

> Documento de estrategia comercial. Recoge las decisiones tomadas sobre tiers,
> seguridad, costos operativos y go-to-market para el producto fred / fred-hub.

---

## 1. El problema que resuelve fred

fred ataca el problema del **conocimiento tácito atrapado en personas** dentro de
organizaciones de software. En muchas empresas:

- La documentación es caótica o está desactualizada.
- El conocimiento de cómo funcionan realmente los sistemas vive en la cabeza de
  ciertos desarrolladores, no en documentos.
- Las decisiones de arquitectura se toman con información incompleta.
- Las estimaciones de viabilidad técnica son inexactas porque nadie tiene el mapa
  completo del sistema.
- El conocimiento se va con cada renuncia (problema de *bus factor*).

fred convierte el código en producción —no la documentación— en la fuente de verdad,
y permite hacer preguntas en lenguaje natural sobre uno o varios repositorios, con
**citas precisas a nivel `repo/archivo:línea`**.

### Diferenciador central

A diferencia de un LLM genérico al que se le pega código, fred ofrece:

1. **Citas precisas** `repo/archivo:línea` que apuntan al código real.
2. **Artefactos precomputados por CI** (`.fdb`): el trabajo costoso (embeddings,
   summaries) se hace una vez en el pipeline, no en cada consulta.
3. **El código fuente nunca sale de la infraestructura del cliente** (ver sección 3).

---

## 2. Estrategia de adopción: Product-Led Growth

El vector de entrada es el **desarrollador individual**, no el comprador corporativo.
El dev descarga la CLI, genera su `.fdb` y empieza a consultar su propio repo sin
fricción ni tarjeta de crédito. Cuando descubre el valor, se convierte en el vendedor
interno hacia su arquitecto o CTO.

### El funnel

```
Plan Developer (gratis)
    1 repo · 1 .fdb · CLI local
        │  genera y consulta .fdb
        ▼
Momento de expansión
    "esto le serviría a mi equipo"
        │  lo muestra a su arquitecto / CTO
        ▼
Plan Cloud ($199/mes)
    hasta 10 repos · UI web · cifrado TLS
        │  datos sensibles, más repos
        ▼
Plan Business ($599/mes)
    hasta 50 repos · BYOK · logs de auditoría
        │  compliance estricto, on-premise
        ▼
Plan Enterprise (licencia anual)
    on-premise · repos ilimitados · LLM local
```

### Requisitos para que el plan Developer funcione como gancho

1. **Útil con un solo repo.** No una demo recortada — algo que un dev use de verdad
   en su día a día. Si el valor solo aparece con múltiples repos, nunca llega al
   momento de expansión.
2. **Visibilidad de lo que se pierde.** Cuando el dev consulta algo, el hub puede
   indicar "esta lógica también existe en otro repo que no tienes cargado",
   plantando la semilla del upgrade.
3. **`.fdb` compatible hacia arriba.** Si un equipo sube a Cloud, los artefactos del
   dev ya funcionan — cero fricción de migración.

---

## 3. Principio de seguridad transversal

**En todos los planes, el código fuente nunca sale de la infraestructura del cliente.**

Lo que viaja (en los planes cloud) es el `.fdb`, que contiene embeddings (vectores
numéricos) y summaries (lenguaje natural), no el código original. Sin embargo, hay un
matiz importante:

> El `.fdb` no permite reconstruir el código fuente, pero **sí contiene lógica de
> negocio** —cómo funcionan procesos internos— que puede ser sensible. Por eso el
> cifrado del `.fdb` importa, y por eso existe el tiering de seguridad.

La diferencia entre planes es **dónde vive el `.fdb`** y **quién controla las claves
de cifrado**.

### Vectores de riesgo del `.fdb`

| Vector | Riesgo | Mitigación |
|---|---|---|
| En tránsito | Interceptación al subir al hub | TLS (todos los planes) |
| En reposo | Compromiso de tus servidores | Cifrado AES-256; BYOK en Business+ |
| En uso | Datos descifrados en memoria | Descifrado efímero, nunca a disco |

---

## 4. Planes de suscripción

### Resumen comparativo

| Característica | Developer | Cloud | Business | Enterprise |
|---|---|---|---|---|
| Precio | Gratis | $199/mes | $599/mes | Licencia anual (custom) |
| Repos | 1 | hasta 10 | hasta 50 | Ilimitados |
| `.fdb` simultáneos | 1 | varios | varios | varios |
| Interfaz | CLI local | UI web | UI web | UI web |
| Hosting del `.fdb` | Local | Tu infra | Tu infra | Infra del cliente |
| Cifrado en tránsito (TLS) | ✓ | ✓ | ✓ | ✓ |
| Cifrado en reposo (AES-256) | n/a | ✓ | ✓ | ✓ |
| Clave gestionada por cliente (BYOK) | — | — | ✓ | ✓ |
| Integración KMS (AWS / Azure) | — | — | ✓ | ✓ |
| Aislamiento de tenant | — | — | ✓ | ✓ (total) |
| Logs de auditoría | — | — | ✓ | ✓ |
| Instalación on-premise | — | — | — | ✓ |
| LLM on-premise (opcional) | — | — | — | ✓ |
| SLA + soporte dedicado | — | — | — | ✓ |
| Auditoría de seguridad | — | — | — | ✓ |

### Detalle por plan

**Developer — Gratis**
Punto de entrada de bajo costo de fricción. El dev genera y consulta un único `.fdb`
localmente. Costo absorbido por la empresa (ver sección 5), limitado por número de
consultas/mes.

**Cloud — $199/mes**
Para equipos que quieren arrancar rápido sin gestionar infraestructura. El `.fdb` vive
en tus servidores cifrado en reposo, pero tú teóricamente podrías acceder a él. Ideal
para el piloto.

**Business — $599/mes**
Para empresas con requisitos de privacidad moderados y datos sensibles. Con BYOK
(*Bring Your Own Key*), tú almacenas el `.fdb` pero **no puedes leerlo**: la clave la
gestiona el cliente vía su propio KMS. Si alguien compromete tus servidores, obtiene
archivos ilegibles. Este es el plan que vende a empresas medianas con compliance.

**Enterprise — Licencia anual (custom)**
Para organizaciones donde los datos nunca pueden salir de su red. El `.fdb` nunca llega
a tus servidores: tú provees el software, ellos operan todo. Opción de LLM on-premise
para clientes que tampoco quieren mandar las *queries* a APIs externas (banca, salud,
gobierno).

---

## 5. Costos operativos y sostenibilidad

El modelo de "tú absorbes el costo de las APIs" en el plan gratuito es sostenible
gracias al subsidio cruzado de los planes pagados.

### Supuestos de costo (precios de referencia)

- Claude Sonnet: ~$3 / M tokens entrada, ~$15 / M tokens salida.
- Embeddings (Voyage / Titan): ~$0.02 / M tokens.
- El trabajo pesado (análisis + embeddings) se hace **una vez** al generar el `.fdb`.
- Cada consulta solo recupera contexto y genera una respuesta corta → muy barata.

### Costo estimado por usuario / mes

| Tier | Análisis inicial | Embeddings | Consultas/mes | Total aprox. |
|---|---|---|---|---|
| Developer | ~$0.18 | ~$0.04 | 20 → ~$0.62 | **~$0.84** |
| Cloud | ~$1.20 | ~$0.40 | 100 → ~$3.10 | **~$4.70** |
| Business | ~$3.50 | ~$2.00 | 500 → ~$15.50 | **~$21.00** |

### Conclusión económica

- Margen Cloud: ~$194 por cliente/mes.
- Margen Business: ~$578 por cliente/mes.
- **Un solo cliente Cloud subsidia a más de 200 usuarios gratuitos del plan Developer.**
- El plan gratis es sostenible desde el primer cliente pagado.

> Nota: estos números son conservadores y deben validarse con consumo real antes de
> optimizar. El primer paso es medir el costo real por usuario gratuito.

---

## 6. Backend de IA: opciones

El proxy de IA debe diseñarse para que cambiar de backend sea trivial (el resto del
sistema no se entera de con quién habla).

| Opción | Precio/token | Facturación | Compliance | Latencia | Cuándo usarla |
|---|---|---|---|---|---|
| **API directa Anthropic** | $3/$15 por M | 2 facturas | T&C Anthropic | Más baja | Ahora, mientras validas |
| **AWS Bedrock** | $3/$15 por M | Una cuenta AWS | BAA, SOC2, ISO | +20-50ms | Al primer cliente enterprise |
| **LLM self-hosted** | $0 (GPU fija) | Solo infra | Máximo | Según hardware | Plan Enterprise que lo exija |

### Secuencia recomendada

1. **API directa de Anthropic** (lo que ya existe) mientras se valida el producto.
2. **AWS Bedrock** cuando llegue el primer cliente enterprise o se necesite el
   argumento de compliance. La migración toma 1-2 días; el código del proxy cambia
   poco porque la API de Bedrock para Claude es casi idéntica.
3. **Self-hosted** (Ollama / vLLM con Llama, Mistral o Qwen) como opción del plan
   Enterprise para clientes que no aprueban ninguna llamada externa. Baja la calidad
   respecto a Claude, pero da privacidad total.

---

## 7. Quitar la fricción de las API keys

Hoy fred depende de que el usuario tenga sus propias keys de Anthropic Console y
Voyage AI en variables de entorno. Esto es fricción crítica para el plan Developer.

### Opciones evaluadas

- **A — Tú absorbes el costo.** La CLI se autentica contra tu propio backend, que
  tiene las keys y hace de proxy. El dev no necesita ninguna cuenta externa. Mejor
  experiencia; costo controlado con límites por tier. **Recomendada a corto plazo.**
- **B — LLM local (Ollama).** Sin keys externas, todo corre en la máquina del dev.
  Menor calidad pero cero dependencia y cero costo. Resuelve también el caso
  Enterprise. **Recomendada a medio plazo como opción adicional.**
- **C — Combinación.** Local por defecto + opción de conectar keys propias para mejor
  calidad. Más flexible, más trabajo de implementación.

---

## 8. Arquitectura de control de costos (resumen)

Cada request pasa por cuatro capas antes de tocar el backend de IA:

1. **API Gateway con JWT** — valida el `fred-token` y extrae `user_id` y `tier`.
2. **Quota checker con Redis** — consulta el contador del tier; si está agotado,
   devuelve `429` inmediatamente con costo cero.
3. **Proxy IA** — único componente que conoce las keys; mide tokens consumidos.
4. **Actualización del contador** — escribe el uso en Redis (tiempo real) y en la DB
   (historial de facturación).

Protecciones adicionales de costo:

- **Spending alert** (CloudWatch) si el gasto diario supera un umbral.
- **Hard cap** en la cuenta AWS que limita el gasto máximo absoluto.

Stack sugerido: API Gateway de AWS, ElastiCache Redis, Lambda/Express para el proxy,
DynamoDB o Postgres para el historial.

---

## 9. Próximos pasos sugeridos

1. Validar con 5-10 contactos técnicos si el dolor es real y cuánto cuesta hoy.
2. Pulir el plan Developer hasta que sea genuinamente útil con un repo.
3. Implementar la Opción A (backend propio con keys) con límites por tier.
4. Construir la UI web mínima que consuma los endpoints del hub.
5. Medir el costo real por usuario gratuito antes de optimizar.
6. Conseguir el primer piloto pagado (Cloud) para validar la economía completa.
