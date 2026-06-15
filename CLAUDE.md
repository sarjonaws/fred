# CLAUDE.md — fred

Contexto del proyecto para Claude Code. Léelo completo antes de hacer cambios.

## Visión del producto

Estamos construyendo una plataforma de consulta arquitectónica con dos herramientas hermanas:

1. **fred (este repo):** deduce la lógica de negocio de un repositorio de código. Pipeline: conectar repo → parsear → extraer estructura → resumir semánticamente con LLM → embeddings → memoria RAG consultable. El usuario final es un arquitecto de software que pregunta cosas como "¿dónde está implementada la regla de descuentos?" o "¿qué se rompe si cambio el modelo de Usuario?".
2. **Herramienta de infraestructura (futura):** parsea IaC (Terraform) y construye un grafo de la infraestructura empresarial. Ambos grafos (negocio + infra) se enlazarán para responder consultas de viabilidad: "¿es viable esta solución dada nuestra infraestructura, políticas y costos?".

**Principio rector:** la lógica de negocio no vive en ningún archivo — está implícita y dispersa. Por eso el pipeline separa la extracción estructural determinística (Fase 1, sin IA) de la elevación semántica (Fase 2, con LLM resumiendo jerárquicamente: función → módulo → dominio).

## Estado actual: Fases 1 y 2 completas y validadas; Fase 3 implementada; habilitadores multi-repo hechos

CLI que analiza repos TypeScript y guarda el esqueleto estructural en SQLite (Fase 1, determinístico), más la elevación semántica con Claude API (Fase 2: `src/summarize.ts` + `src/embed.ts`, comandos `summarize`, `summaries`, `embed`). La Fase 2 fue validada (2026-06-10) contra un repo real (`back-appcore-api`, 56 archivos, 74 funciones): los resúmenes capturan reglas de negocio fieles confirmadas por el dueño del código, y todos tienen embedding generado (Voyage AI `voyage-3.5`, 1024 dims). La Fase 3 (`src/rag.ts` + `src/server.ts`, comandos `ask` y `serve`) está implementada y probada contra ese mismo repo: el agente combina búsqueda vectorial y SQL, cita `archivo:línea` y mantiene sesiones multi-turno. Desde 2026-06-11 cada `.db` es auto-descriptivo (tabla `meta`, esquema v2), `RagAgent` acepta varias fuentes federadas, fred se consume como librería (`exports` en package.json), y existe el hub multi-repo como repo hermano (`../fred-hub`).

### Stack

- Node.js >= 22 (obligatorio: usamos `node:sqlite` nativo, sin binarios compilados — NO introducir better-sqlite3 ni sqlite3)
- TypeScript + ESM (`"type": "module"` — los imports internos llevan extensión `.js`)
- `ts-morph` para parseo (NO tree-sitter: necesitamos el type-checker para resolver llamadas a través de imports)
- `commander` para el CLI
- `tsx` para ejecutar sin compilar en desarrollo
- Distribución como paquete npm: `npm run build` (tsc → `dist/`) y `bin` `fred` (`npm install -g .` o `npm link`); solo se publica `dist/`

### Estructura

```
src/
  db.ts        # Esquema SQLite y helpers (clase CodeDB) — incluye summaries, embeddings y meta (SCHEMA_VERSION, readMeta)
  git.ts       # Metadatos de git del repo analizado (SHA, rama, remote) con fallback limpio
  analyzer.ts  # Extracción: 2 pasadas (símbolos, luego grafo de llamadas) + escritura de meta
  summarize.ts # Fase 2: resúmenes jerárquicos con Claude (función → módulo → dominio)
  embed.ts     # Fase 2: embeddings de los resúmenes vía Voyage AI
  rag.ts       # Fase 3: agente RAG (search_summaries vectorial + query_graph SQL solo lectura)
  server.ts    # Fase 3: endpoint de chat Express (POST /chat, sesiones en memoria)
  setup.ts     # Fase 3: preparación interactiva de la sesión (resuelve API keys — env o ~/.fred/credentials.json — y resuelve/crea la base)
  cli.ts       # Comandos: analyze, stats, who-calls, calls-of, search, impact, summarize, summaries, embed, ask, serve
  index.ts     # Superficie de librería (la consume fred-hub): RagAgent, CodeDB, readMeta, gitInfo, etc.
sample-shop/   # Repo TypeScript de prueba con lógica de negocio realista
```

### Esquema de la base (SQLite)

- `meta(key, value)` — metadatos del artefacto (esquema v2): `schema_version`, `repo_name`, `repo_remote`, `commit_sha`, `branch`, `generated_at`, `fred_version`. Los escribe `analyze` (`--repo <name>` para forzar el nombre; default: remote de git o carpeta). Bases sin `meta` = legacy v1, toleradas en toda la CLI (`readMeta` devuelve `{}`).
- `files(id, path, loc)` — archivos relativos a la raíz del repo
- `symbols(id, file_id, name, kind, parent, start_line, end_line, signature, doc, exported)`
    - `kind`: function | method | class | interface | type | enum | arrow
    - `parent`: clase contenedora para métodos
    - `doc`: JSDoc — materia prima para los resúmenes LLM de la Fase 2
- `calls(caller_id, callee_id, callee_name, line)` — `callee_id` NULL = llamada externa no resuelta
- `imports(file_id, module, named)`

### Comandos

```bash
npx tsx src/cli.ts analyze <repo> --db out.db
npx tsx src/cli.ts stats --db out.db
npx tsx src/cli.ts who-calls <símbolo> --db out.db
npx tsx src/cli.ts calls-of <símbolo> --db out.db
npx tsx src/cli.ts search <texto> --db out.db
npx tsx src/cli.ts impact <símbolo> --db out.db --depth 3
```

Prueba de humo tras cualquier cambio en analyzer.ts o db.ts:

```bash
npx tsx src/cli.ts analyze ./sample-shop --db /tmp/shop.db
# Esperado: 5 archivos, 12 símbolos, 12 llamadas (8 resueltas)
npx tsx src/cli.ts impact roundMoney --db /tmp/shop.db
# Esperado: calculateSubtotal y applyDiscount en nivel 1; OrderService.createOrder y recalculate en nivel 2
```

## Decisiones de diseño (no revertir sin discutirlo)

1. **ts-morph sobre tree-sitter:** la resolución real de símbolos del compilador (incluyendo `getAliasedSymbol()` para imports) es lo que hace confiable `impact`. Un parser sintáctico convertiría el análisis de impacto en adivinanza.
2. **Embeddings de resúmenes, no de código crudo (Fase 2):** la búsqueda semántica debe operar sobre descripciones de reglas de negocio en lenguaje natural, vinculadas a las líneas que las implementan.
3. **Resumen jerárquico bottom-up (estilo RAPTOR):** función → clase/módulo → dominio. Cada nivel usa los resúmenes del nivel inferior como contexto.
4. **SQLite como única persistencia hasta post-validación:** cero infraestructura. Neo4j/grafo formal solo después de validar el MVP.
5. **Batch antes que incremental:** los webhooks de GitHub App vienen después de validar; no agregar esa complejidad ahora.

## Limitaciones conocidas (aceptadas en el MVP)

- Callbacks anónimos no asignados a variable no se registran como callers.
- Re-exportaciones en barril (`export * from`) pueden dejar llamadas sin resolver.
- Re-análisis completo en cada corrida (no incremental).
- Solo TypeScript/TSX; no JS plano (allowJs: false a propósito).

## Roadmap

### Fase 2 — Elevación semántica (completa y validada)

`src/summarize.ts` + comando `summarize` (modelo por defecto `claude-opus-4-8`, configurable con `--model`):

1. ✅ Símbolos function/method/arrow en orden topológico inverso (oleadas hojas-primero; ciclos agrupados en una oleada final).
2. ✅ Prompt con cuerpo + JSDoc + resúmenes de callees → 1-3 frases de regla de negocio (en español).
3. ✅ Jerarquía: función → módulo (archivo) → dominio (carpeta).
4. ✅ Tablas `summaries(symbol_id|file_id|domain, level, body_hash, text, model, created_at)` y `embeddings(summary_id, body_hash, vector BLOB, dims, model)`. Embeddings vía Voyage AI (`embed`, env `VOYAGE_API_KEY`) — la API de Claude no ofrece embeddings.
5. ✅ Idempotencia por sha256 del cuerpo+firma+JSDoc; caché por hash sobrevive re-análisis (los symbol_id cambian, el hash no). `--force` para regenerar, `--dry-run` para ver el plan sin gastar tokens.

Convenciones aplicadas: `ANTHROPIC_API_KEY` vía env; reintentos con backoff (SDK, `maxRetries: 5`); concurrencia acotada por oleada (`--concurrency`, default 4).

**Validada (2026-06-10) con `back-appcore-api`** (56 archivos, 74 funciones, 30 módulos, 15 dominios; 89s, ~119 llamadas a la API): reglas de negocio confirmadas como fieles por el dueño del código. Embeddings generados para los 119 resúmenes con `voyage-3.5` (1024 dims). Nota: cuentas de Voyage sin método de pago tienen límite de 3 RPM / 10K TPM; `embed` lo maneja respetando Retry-After.

### Fase 3 — Capa de consulta RAG (implementada)

`src/rag.ts` (agente, clase `RagAgent`) + `src/server.ts` (Express). Claude (`claude-opus-4-8`, loop agéntico manual) tiene dos herramientas: `search_summaries` (similitud coseno sobre los embeddings; la pregunta se embebe con Voyage `input_type: "query"`) y `query_graph` (SQL sobre conexión SQLite de solo lectura, un solo SELECT, máx 50 filas). Las respuestas citan `archivo:línea`. Comandos: `ask <pregunta>` (un turno, con streaming), `tui` (interfaz interactiva con Ink/React: markdown ANSI vía marked-terminal, spinner, transcript con `<Static>`, cola de entrada; requiere TTY — `src/tui.tsx`), `chat` (REPL equivalente solo con `node:readline`, funciona con stdin por pipe) y `serve --port` (POST /chat con `session_id`, historial en memoria). Excepción aceptada a "sin dependencias pesadas": ink/react/marked son la interfaz principal de consulta. Cada turno reporta su uso (`UsageReport`): llamadas/tokens de Claude y Voyage + costo estimado en USD (tabla `PRICING` en `rag.ts`; actualizarla si cambian las tarifas). Antes de abrir `ask`/`chat`/`tui`, `src/setup.ts` (`prepareSession`) resuelve las API keys (entorno → `~/.fred/credentials.json` → pedirlas por teclado con entrada oculta, ofreciendo guardarlas para futuras sesiones) y resuelve la base: confirma la existente y completa fases pendientes (resúmenes/embeddings), ofrece las `.db` del directorio, o la construye desde cero pidiendo la ruta del proyecto (analyze → summarize → embed). Sin TTY (pipes/CI) no pregunta: valida y falla con mensaje accionable. Probada contra `back-appcore-api`: combina ambas herramientas, traza radios de impacto y mantiene contexto multi-turno.

Pendiente para cerrar la fase: validación de uso real por el equipo (¿las respuestas le sirven a un arquitecto?).

### Post-validación

GitHub App + webhooks (análisis incremental por archivo cambiado, propagando re-resúmenes hacia arriba), multi-repo, y enlace con el grafo de infraestructura Terraform.

### Visión multi-repo: RAG global corporativo (habilitadores y hub MVP implementados 2026-06-11)

En un corporativo una solución real son varios repos/componentes (potencialmente en varios lenguajes). El plan: cada pipeline de CI (Jenkins) corre `fred analyze && summarize && embed` y publica su `repo.db` como artefacto; un servicio central ("fred-hub") los ingiere y expone el mismo agente RAG con alcance de solución. El `.db` es la pieza correcta porque ya lleva precalculado lo caro (resúmenes + embeddings) y la idempotencia por hash hace barato cada deploy — el hub solo recolecta e indexa, no recomputa.

Escala y decisiones:

- La búsqueda coseno por fuerza bruta de `rag.ts` aguanta el caso corporativo típico (~100 repos × ~120 resúmenes ≈ 12K vectores); no introducir base vectorial dedicada hasta que el volumen lo exija.
- **Consolidación elegida (2026-06-11): federación.** El hub abre N `.db` en conexiones read-only separadas (ni SQLite central con remapeo de ids, ni `ATTACH`): el artefacto del CI es la fuente de verdad y refrescar = reemplazar el archivo. `RagAgent` acepta `sources: { repo, dbPath }[]`; con >1 fuente las citas pasan a `repo/archivo:línea`, `query_graph` exige el parámetro `repo` y el system prompt lista los repos. Con una sola fuente el comportamiento validado queda intacto. Si los repos usan modelos de embedding distintos, se embebe la pregunta una vez por modelo y se fusiona por score.
- ✅ **Primer habilitador:** tabla `meta` en cada `.db` (esquema v2) — ver sección de esquema. Idempotente y retrocompatible.
- ✅ **Hub MVP:** repo hermano `../fred-hub` (servicio Express delgado que consume fred como librería vía `file:` dependency): escanea un directorio de artefactos (`--dbs`), tolera legacy/incompletos con warnings, y expone `GET /health`, `GET /repos`, `POST /chat` (mismo contrato que `fred serve`) y `POST /reload`. Ver su README para el contrato del artefacto. Nota Windows: el hub bloquea los `.db` abiertos (no se pueden reemplazar en caliente); en Linux el `cp` + `/reload` funciona.
- **Reto 1 — aristas entre repos:** el type-checker no ve la comunicación HTTP/colas/DB entre componentes. El `impact` global requiere elevar contratos (endpoints expuestos vs. consumidos, topics publicados vs. suscritos) vía OpenAPI/specs, heurísticas o el LLM en la fase de resumen. Es el equivalente de `imports` a nivel solución, y donde el grafo de infraestructura Terraform (herramienta hermana) es el pegamento natural.
- **Reto 2 — multi-lenguaje:** el esquema `files/symbols/calls/summaries/embeddings` es agnóstico al lenguaje y las Fases 2-3 operan sobre la base, no sobre el código; soportar otro lenguaje = escribir solo el extractor de Fase 1 que llene el mismo esquema.

Orden: (1) ✅ tabla `meta`, (2) paso de CI (Jenkins) que publique el artefacto — pendiente, ver README de fred-hub, (3) ✅ hub de solo lectura con RAG global (MVP), (4) contratos entre componentes — pendiente.

## Reglas para Claude Code

- Mantén todo el código y comentarios en el estilo existente (comentarios en español, código en inglés).
- No agregues dependencias pesadas sin justificación; preferir stdlib de Node.
- Cualquier cambio al esquema de SQLite debe ser retrocompatible o incluir migración en `CodeDB`.
- Corre la prueba de humo de arriba antes de dar por terminado un cambio.
- No implementes Fase 3 antes de que Fase 2 esté validada con un repo real.

## Anexo A — Viabilidad de Amazon Bedrock como backend de Claude (posible mejora)

Análisis (2026-06-14) de enrutar las llamadas a Claude por **Amazon Bedrock** en lugar de la API directa de Anthropic, autenticando con credenciales AWS. **Estado: propuesta, no implementada.**

**Veredicto:** viable y de bajo riesgo para las llamadas a Claude; la pieza de embeddings (Voyage) NO se mueve a Bedrock.

Bedrock es operado por AWS (no por Anthropic) pero sirve la misma forma de la Messages API. Todo lo que fred usa de Claude está soportado: `messages.create` (`summarize.ts`), `messages.stream` (`rag.ts`), `tools` cliente-side con loop agéntico manual (`search_summaries` / `query_graph`), `thinking: {type:"adaptive"}`, `stop_reason: "refusal"` / `pause_turn`, y el backoff del SDK (`maxRetries`). Lo que Bedrock NO soporta (Managed Agents, herramientas server-side de Anthropic, Task Budgets, `fallbacks` server-side) fred no lo usa, así que no hay choque.

**Punto clave — los embeddings son independientes del proveedor.** `embed.ts` y `RagAgent.searchSummaries` usan **Voyage AI**, que no vive en Bedrock; mover Claude a Bedrock no mueve Voyage. Caminos:
- **Recomendado (fase 1):** dejar Voyage tal cual; solo las llamadas a Claude van por Bedrock. Se sigue necesitando `VOYAGE_API_KEY`. Cero recálculo.
- **Más invasivo:** cambiar a un modelo de embeddings de Bedrock (Titan v2 = 1024 dims, o Cohere). Cambia el espacio vectorial → re-embeber todo, y mezcla espacios distintos entre `.db` federados (aunque `searchSummaries` ya tolera varios modelos fusionando por score). No hacerlo ahora.

**Autenticación "a través de claves":** Bedrock usa credenciales AWS (SigV4): `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (+ opcional `AWS_SESSION_TOKEN`) y `AWS_REGION`, o rol IAM / perfil. El cliente `AnthropicBedrock` (`@anthropic-ai/bedrock-sdk`) las lee del entorno o del constructor. Encaja con el patrón actual de `setup.ts` (env → `~/.fred/credentials.json` → preguntar): basta agregar estas claves a `API_KEYS` y a la resolución.

**Cambios necesarios (acotados):**
1. **Cliente:** `npm i @anthropic-ai/bedrock-sdk`. Una factory que devuelva `new Anthropic()` o `new AnthropicBedrock()`; el resto de `summarize.ts`/`rag.ts` no cambia (ambos exponen `.messages.create/.stream` idénticos).
2. **IDs de modelo:** Bedrock exige prefijo de proveedor → `anthropic.claude-opus-4-8` (a menudo inference profile regional `us.anthropic.claude-opus-4-8`). Un `claude-*` pelado da 400 en Bedrock.
3. **Tabla `PRICING` (`rag.ts`):** está indexada por `claude-opus-4-8`; con el ID de Bedrock `estimateCost` devuelve `null`. Normalizar la clave (quitar `anthropic.`/`us.`) o añadir entradas Bedrock (sus tarifas difieren un poco de la API directa).
4. **`summaries.model`:** guardaría el ID con prefijo; conviene normalizar para mantener coherente la idempotencia por hash y el reporte de uso entre proveedores.
5. **Superficie de librería (`index.ts` → fred-hub):** propagar la elección de proveedor por `RagOptions`/config para que el hub también pueda apuntar a Bedrock.

**Verificar antes de implementar:** (a) que `claude-opus-4-8` esté habilitado en la región/cuenta de Bedrock (model access) — es el bloqueante real más común; (b) cuotas de Bedrock (por región/modelo, distintas a las de la API directa).