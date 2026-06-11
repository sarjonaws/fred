# CLAUDE.md — biz-analyzer

Contexto del proyecto para Claude Code. Léelo completo antes de hacer cambios.

## Visión del producto

Estamos construyendo una plataforma de consulta arquitectónica con dos herramientas hermanas:

1. **biz-analyzer (este repo):** deduce la lógica de negocio de un repositorio de código. Pipeline: conectar repo → parsear → extraer estructura → resumir semánticamente con LLM → embeddings → memoria RAG consultable. El usuario final es un arquitecto de software que pregunta cosas como "¿dónde está implementada la regla de descuentos?" o "¿qué se rompe si cambio el modelo de Usuario?".
2. **Herramienta de infraestructura (futura):** parsea IaC (Terraform) y construye un grafo de la infraestructura empresarial. Ambos grafos (negocio + infra) se enlazarán para responder consultas de viabilidad: "¿es viable esta solución dada nuestra infraestructura, políticas y costos?".

**Principio rector:** la lógica de negocio no vive en ningún archivo — está implícita y dispersa. Por eso el pipeline separa la extracción estructural determinística (Fase 1, sin IA) de la elevación semántica (Fase 2, con LLM resumiendo jerárquicamente: función → módulo → dominio).

## Estado actual: Fases 1 y 2 completas y validadas; Fase 3 implementada

CLI que analiza repos TypeScript y guarda el esqueleto estructural en SQLite (Fase 1, determinístico), más la elevación semántica con Claude API (Fase 2: `src/summarize.ts` + `src/embed.ts`, comandos `summarize`, `summaries`, `embed`). La Fase 2 fue validada (2026-06-10) contra un repo real (`back-appcore-api`, 56 archivos, 74 funciones): los resúmenes capturan reglas de negocio fieles confirmadas por el dueño del código, y todos tienen embedding generado (Voyage AI `voyage-3.5`, 1024 dims). La Fase 3 (`src/rag.ts` + `src/server.ts`, comandos `ask` y `serve`) está implementada y probada contra ese mismo repo: el agente combina búsqueda vectorial y SQL, cita `archivo:línea` y mantiene sesiones multi-turno.

### Stack

- Node.js >= 22 (obligatorio: usamos `node:sqlite` nativo, sin binarios compilados — NO introducir better-sqlite3 ni sqlite3)
- TypeScript + ESM (`"type": "module"` — los imports internos llevan extensión `.js`)
- `ts-morph` para parseo (NO tree-sitter: necesitamos el type-checker para resolver llamadas a través de imports)
- `commander` para el CLI
- `tsx` para ejecutar sin compilar

### Estructura

```
src/
  db.ts        # Esquema SQLite y helpers (clase CodeDB) — incluye summaries y embeddings
  analyzer.ts  # Extracción: 2 pasadas (símbolos, luego grafo de llamadas)
  summarize.ts # Fase 2: resúmenes jerárquicos con Claude (función → módulo → dominio)
  embed.ts     # Fase 2: embeddings de los resúmenes vía Voyage AI
  rag.ts       # Fase 3: agente RAG (search_summaries vectorial + query_graph SQL solo lectura)
  server.ts    # Fase 3: endpoint de chat Express (POST /chat, sesiones en memoria)
  cli.ts       # Comandos: analyze, stats, who-calls, calls-of, search, impact, summarize, summaries, embed, ask, serve
sample-shop/   # Repo TypeScript de prueba con lógica de negocio realista
```

### Esquema de la base (SQLite)

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

`src/rag.ts` (agente, clase `RagAgent`) + `src/server.ts` (Express). Claude (`claude-opus-4-8`, loop agéntico manual) tiene dos herramientas: `search_summaries` (similitud coseno sobre los embeddings; la pregunta se embebe con Voyage `input_type: "query"`) y `query_graph` (SQL sobre conexión SQLite de solo lectura, un solo SELECT, máx 50 filas). Las respuestas citan `archivo:línea`. Comandos: `ask <pregunta>` (un turno, con streaming), `tui` (interfaz interactiva con Ink/React: markdown ANSI vía marked-terminal, spinner, transcript con `<Static>`, cola de entrada; requiere TTY — `src/tui.tsx`), `chat` (REPL equivalente solo con `node:readline`, funciona con stdin por pipe) y `serve --port` (POST /chat con `session_id`, historial en memoria). Excepción aceptada a "sin dependencias pesadas": ink/react/marked son la interfaz principal de consulta. Cada turno reporta su uso (`UsageReport`): llamadas/tokens de Claude y Voyage + costo estimado en USD (tabla `PRICING` en `rag.ts`; actualizarla si cambian las tarifas). Probada contra `back-appcore-api`: combina ambas herramientas, traza radios de impacto y mantiene contexto multi-turno.

Pendiente para cerrar la fase: validación de uso real por el equipo (¿las respuestas le sirven a un arquitecto?).

### Post-validación

GitHub App + webhooks (análisis incremental por archivo cambiado, propagando re-resúmenes hacia arriba), multi-repo, y enlace con el grafo de infraestructura Terraform.

## Reglas para Claude Code

- Mantén todo el código y comentarios en el estilo existente (comentarios en español, código en inglés).
- No agregues dependencias pesadas sin justificación; preferir stdlib de Node.
- Cualquier cambio al esquema de SQLite debe ser retrocompatible o incluir migración en `CodeDB`.
- Corre la prueba de humo de arriba antes de dar por terminado un cambio.
- No implementes Fase 3 antes de que Fase 2 esté validada con un repo real.