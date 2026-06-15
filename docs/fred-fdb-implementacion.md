# fred — Formato `.fdb`: contexto e implementación

> Documento técnico. Recoge el contexto y las decisiones de diseño para implementar
> el formato propietario cifrado `.fdb`, sucesor del `.db` (SQLite) que fred usa hoy.

---

## 1. Punto de partida: el `.db` actual

Hoy fred produce un artefacto `.db` que es una base de datos **SQLite portable**.
Contiene el resultado de correr `analyze + summarize + embed` sobre un repositorio:

- Tabla `meta` (`repo_name`, `commit_sha`, `branch`, `generated_at`, `schema_version`).
- `summaries` — resúmenes en lenguaje natural generados por Claude.
- `embeddings` — vectores generados por Voyage.
- Grafo de llamadas internas del repo.

El hub (`fred-hub`) escanea estos `.db` en modo lectura, valida su `meta`, y construye
un `RagAgent` que sirve consultas. **El hub nunca recomputa nada**: todo el trabajo
costoso ya está dentro del `.db`.

### Problema con el `.db` tal cual

1. **Sin cifrado.** Cualquiera que intercepte el archivo lee summaries y embeddings.
2. **Lógica de negocio expuesta.** Aunque no se reconstruye el código fuente, los
   summaries describen *cómo funcionan los procesos*, lo cual puede ser sensible.
3. **Formato abierto y conocido.** SQLite es trivialmente inspeccionable.

---

## 2. Objetivo del `.fdb`

Un formato propietario y cifrado donde **solo fred (como visor autorizado) pueda
acceder al contenido**, dada la clave correcta. Beneficios buscados:

- **Confidencialidad**: el payload va cifrado con AES-256-GCM.
- **Integridad**: firma que detecta manipulación en tránsito o reposo.
- **Control del spec**: formato propio que puede evolucionar con features que un
  SQLite estándar no permite.
- **Narrativa comercial**: "archivo sellado que solo fred puede leer" — ventaja
  diferencial frente a competidores.

### Alternativas descartadas y por qué

- **SQLCipher** (SQLite + AES página por página): rápido de implementar (~1 semana),
  resuelve ~80% del problema. **Pero** es un formato conocido y auditable, y no da
  control del spec. Sirve como paso intermedio para Cloud/Business, no como destino.
- **DuckDB**: columnar y eficiente para queries analíticas sobre embeddings, pero sin
  cifrado nativo robusto.

> Decisión: construir el formato propietario `.fdb`. SQLCipher puede usarse como
> implementación puente si se necesita cifrado antes de tener el `.fdb` listo.

---

## 3. Estructura del archivo `.fdb`

El archivo se divide en tres zonas: header en claro, payload cifrado, y firma.

```
┌─────────────────────────────────────────┐
│ HEADER  (texto plano, no sensible)        │
│   magic bytes: FRED01                     │
│   schema_version                          │
│   repo_name                               │
│   generated_at                            │
│   public_key_fingerprint                  │
├─────────────────────────────────────────┤
│ PAYLOAD (cifrado AES-256-GCM)             │
│   iv + auth_tag                           │
│   → summaries                             │
│   → embeddings                            │
│   → meta tables                           │
│   → grafo de llamadas                     │
├─────────────────────────────────────────┤
│ FIRMA (texto plano)                       │
│   HMAC-SHA256 del payload cifrado         │
│   (o firma con clave privada del CI)      │
└─────────────────────────────────────────┘
```

### Por qué esta separación

- **El header en claro** permite que el hub valide el archivo (nombre de repo,
  versión de schema, fingerprint de la clave) **sin descifrar nada**. Esto es clave
  para rechazar rápido artefactos incompatibles o duplicados.
- **El payload cifrado** contiene todo lo sensible. Solo se descifra en memoria,
  cuando se va a operar, y nunca se escribe descifrado a disco.
- **La firma** garantiza integridad: si el archivo fue manipulado en tránsito o en
  reposo, la verificación falla y el hub lo rechaza. Resuelve confidencialidad *e*
  integridad en un solo formato.

---

## 4. Flujo de generación (lado CI del cliente)

```
1. fred corre analyze + summarize + embed sobre el repo
2. Se construye el payload en memoria (summaries, embeddings, meta, grafo)
3. Se cifra el payload con AES-256-GCM usando la clave del cliente
4. Se calcula la firma (HMAC-SHA256 o firma con clave privada del CI)
5. Se ensambla: HEADER (claro) + PAYLOAD (cifrado) + FIRMA
6. Se escribe el archivo .fdb
```

La clave de cifrado **solo la posee el cliente**. En los planes con BYOK, esa clave
vive en el KMS del cliente (AWS KMS, Azure Key Vault) y nunca se persiste en la
infraestructura del proveedor.

---

## 5. Flujo de lectura (lado fred / hub)

```
1. Leer el HEADER en claro
2. Validar: magic bytes, schema_version <= SCHEMA_VERSION soportado,
   repo_name no duplicado, fingerprint de clave reconocido
3. Verificar la FIRMA contra el payload cifrado
   → si falla: rechazar el archivo (integridad comprometida)
4. Obtener la clave (del KMS del cliente o de la sesión, según el plan)
5. Descifrar el PAYLOAD en memoria
6. Operar (queries del RagAgent) sobre los datos en memoria
7. Descartar los datos descifrados al terminar — nunca a disco
```

> Regla dura: **los datos descifrados nunca tocan el disco**. Solo viven en memoria
> durante la operación y se descartan después.

---

## 6. Validaciones (heredadas del registry actual)

Las reglas de validación que hoy viven en `registry.ts` deben adaptarse al `.fdb`,
operando sobre el **header en claro** siempre que sea posible:

- **Schema más nuevo** que el `SCHEMA_VERSION` soportado → **excluido** (el hub
  necesita actualizarse).
- **Faltan summaries o embeddings** → **excluido** (el CI no terminó su pipeline).
  *(Nota: esto requiere descifrar para contar; ver sección 8 sobre metadatos en el
  header.)*
- **Sin tabla `meta`** (legacy `.db`) → **aceptado con warning**, filename como
  nombre de repo. Aplica solo a `.db`, no a `.fdb`.
- **Nombres de repo duplicados** → **error duro** (desambiguar con
  `fred analyze --repo`).

---

## 7. Plan Developer: `.fdb` único

El plan Developer opera con **un solo `.fdb` a la vez**, generado y consultado
localmente vía CLI. Requisitos:

1. La CLI genera el `.fdb` con `fred analyze` (o equivalente).
2. La CLI consulta ese `.fdb` directamente, sin hub.
3. El `.fdb` generado debe ser **compatible hacia arriba**: si el equipo sube a Cloud,
   el mismo artefacto funciona en el hub sin regenerarse.

Esto último implica que el formato del `.fdb` del plan Developer y el de los planes
cloud debe ser **idéntico** — la única diferencia es dónde se almacena y cómo se
gestiona la clave.

---

## 8. Decisiones de diseño pendientes

Puntos a resolver durante la implementación:

1. **¿Qué metadatos van en el header en claro?**
   El header debe tener lo mínimo para validar sin descifrar. Si la validación de
   "faltan summaries/embeddings" debe hacerse sin descifrar, hay que incluir contadores
   (`n_summaries`, `n_embeddings`) en el header. Tradeoff: el header revela el *tamaño*
   del análisis, aunque no su contenido.

2. **Firma: HMAC vs firma asimétrica.**
   - HMAC-SHA256: simple, requiere clave compartida.
   - Firma con clave privada del CI + verificación con clave pública: permite que el
     hub verifique sin conocer la clave secreta. Mejor para BYOK. El
     `public_key_fingerprint` del header apunta a esto.

3. **Gestión de la clave en runtime (planes cloud).**
   El hub necesita la clave para descifrar. Opciones:
   - Cliente la envía en cada sesión.
   - KMS externo (AWS KMS / Azure Key Vault) donde el proveedor nunca ve la clave.
   La segunda es la indicada para Business/Enterprise.

4. **Compatibilidad con el `.db` legacy.**
   Durante la transición, el hub probablemente deba soportar ambos: `.db` (SQLite, sin
   cifrar, con warning) y `.fdb` (cifrado). Definir hasta cuándo se mantiene el `.db`.

5. **`SCHEMA_VERSION` y `readMeta`.**
   El `@sarjonaws/fred` está pinneado a un tarball de GitHub release. Cualquier cambio
   de schema debe sincronizarse entre el tarball y la validación del registry que
   espeja el schema de fred.

---

## 9. Relación con el resto del sistema

- **`fred-hub`** sigue siendo glue: escanea artefactos, valida headers, construye el
  `RagAgent`, expone los endpoints. El cambio es que ahora descifra el payload en
  memoria antes de pasárselo al agente.
- **Modelo de reload** (`POST /reload`) se mantiene: re-escanea, construye un nuevo
  agente, lo intercambia, cierra el viejo. Fail-safe.
- **Constraint de Windows**: el hub mantiene los `.fdb` abiertos; Windows los bloquea.
  En Linux (deployment real) `cp` + `POST /reload` funciona.

---

## 10. Pasos de implementación sugeridos

1. Definir el spec binario exacto del header (offsets, encoding, magic bytes).
2. Implementar el serializador/deserializador del payload (lo que hoy es SQLite →
   estructura cifrable).
3. Implementar cifrado/descifrado AES-256-GCM con manejo de IV y auth_tag.
4. Implementar firma y verificación (decidir HMAC vs asimétrica — sección 8.2).
5. Adaptar `registry.ts` para leer y validar el header en claro del `.fdb`.
6. Adaptar el flujo de lectura del hub para descifrar en memoria.
7. Mantener soporte de lectura del `.db` legacy durante la transición.
8. Implementar la CLI del plan Developer (generar + consultar un `.fdb`).
9. Tests unitarios para serialización, cifrado, firma y validación de header.
10. Integrar gestión de claves vía KMS para los planes Business/Enterprise.
