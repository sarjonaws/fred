# biz-analyzer — MVP Fases 1, 2 y 3

Analizador de repositorios TypeScript que deduce la lógica de negocio de un repo y la vuelve consultable por arquitectos de software.

- **Fase 1 (determinística, sin IA):** parsea el repo con el compilador real de TypeScript (vía `ts-morph`), extrae símbolos, documentación y el grafo de llamadas, y lo guarda en SQLite.
- **Fase 2 (elevación semántica):** recorre el grafo de llamadas de hoja a raíz y resume con Claude la *regla de negocio* de cada función (usando los resúmenes de sus callees como contexto), luego cada módulo y cada dominio. Genera embeddings de los resúmenes con Voyage AI.
- **Fase 3 (capa de consulta RAG):** un agente con Claude responde preguntas de arquitecto ("¿dónde está la regla X?", "¿qué se rompe si cambio Y?") combinando búsqueda vectorial sobre los resúmenes y SQL de solo lectura sobre el grafo, citando siempre `archivo:línea`. Disponible como comando `ask` y como endpoint HTTP (`serve`).

## Requisitos

- Node.js >= 22 (usa el SQLite nativo de Node, sin compilación de binarios)

## Instalación

```bash
npm install
```

## Uso

```bash
# 1. Analizar un repositorio (genera el archivo SQLite)
npx tsx src/cli.ts analyze ./ruta/al/repo --db repo.db

# 2. Consultas de arquitecto
npx tsx src/cli.ts stats --db repo.db                  # panorama general + símbolos más llamados
npx tsx src/cli.ts who-calls applyDiscount --db repo.db # ¿quién depende de esta función?
npx tsx src/cli.ts calls-of createOrder --db repo.db    # ¿qué orquesta esta función?
npx tsx src/cli.ts search descuento --db repo.db        # buscar en nombres y JSDoc
npx tsx src/cli.ts impact roundMoney --db repo.db       # radio de impacto transitivo (BFS inverso)

# 3. Elevación semántica (Fase 2, requiere ANTHROPIC_API_KEY)
npx tsx src/cli.ts summarize ./ruta/al/repo --db repo.db            # resúmenes función → módulo → dominio
npx tsx src/cli.ts summarize ./ruta/al/repo --db repo.db --dry-run  # ver el plan sin gastar tokens
npx tsx src/cli.ts summaries applyDiscount --db repo.db             # inspeccionar resúmenes generados

# 4. Embeddings de los resúmenes (requiere VOYAGE_API_KEY)
npx tsx src/cli.ts embed --db repo.db

# 5. Consultas RAG (Fase 3, requiere ambas claves)
npx tsx src/cli.ts ask "¿Dónde está la regla de descuentos y qué se rompe si la cambio?" --db repo.db
npx tsx src/cli.ts tui --db repo.db                 # interfaz interactiva TUI (recomendada)
npx tsx src/cli.ts chat --db repo.db                # REPL simple (funciona también con stdin por pipe)
npx tsx src/cli.ts serve --db repo.db --port 3000   # endpoint de chat HTTP
```

El comando `tui` abre la interfaz interactiva (Ink): markdown renderizado a colores, spinner, respuestas en streaming, herramientas visibles mientras el agente trabaja, contexto multi-turno y comandos `/nueva` (reiniciar sesión), `/uso` (costo acumulado) y `/salir`. Lo que escribas mientras responde se encola como siguiente pregunta. `chat` es la versión sin dependencias de UI (solo `node:readline`), útil para pipes y entornos sin TTY.

Cada respuesta de `ask` termina con un bloque de uso: llamadas y tokens por proveedor (Claude y Voyage) y costo estimado en USD según la tarifa del modelo. El endpoint `/chat` devuelve lo mismo en el campo `usage`.

El endpoint de chat mantiene sesiones en memoria para conversaciones multi-turno:

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"question": "¿dónde está la regla de descuentos?"}'
# -> { "answer": "...", "session_id": "...", "usage": { ... } }
# turnos siguientes: incluir "session_id" en el body
```

`summarize` es idempotente: hashea el cuerpo de cada función y solo re-resume lo que cambió (control de costos). Los niveles módulo y dominio se re-generan solo si cambiaron los resúmenes de los que dependen.

Incluye un repo de ejemplo (`sample-shop/`) con lógica de negocio realista (tiers de cliente, descuentos, reglas de envío) para probar de inmediato:

```bash
npx tsx src/cli.ts analyze ./sample-shop --db shop.db
npx tsx src/cli.ts impact roundMoney --db shop.db
```

## Esquema de la base

- `files` — archivos del repo y su tamaño
- `symbols` — funciones, métodos, clases, interfaces, types, enums; con líneas, firma, JSDoc y si son exportados
- `calls` — grafo de llamadas: caller → callee, con resolución real de símbolos del compilador (incluye alias de imports); las llamadas a librerías externas quedan registradas con `callee_id NULL`
- `imports` — dependencias entre módulos
- `summaries` — resúmenes jerárquicos (Fase 2): nivel `function` (ligado a `symbol_id`), `module` (a `file_id`) y `domain` (carpeta); con `body_hash` para idempotencia y `model` usado
- `embeddings` — un vector por resumen (`Float32` little-endian en BLOB), con hash del texto embebido y modelo

## Decisiones de diseño

- **ts-morph en vez de tree-sitter:** para TypeScript, el type-checker del compilador resuelve a qué declaración apunta cada llamada (incluso a través de imports), cosa que un parser sintáctico no puede hacer. Eso vuelve confiable el análisis de impacto.
- **JSDoc como materia prima:** la columna `doc` ya captura la intención escrita por los devs; en la Fase 2 el LLM la combina con el cuerpo de la función para producir el resumen de regla de negocio.
- **SQLite:** cero infraestructura; el .db es portable y la capa RAG lo consulta directo.

## Roadmap

- **Fase 2 — Elevación semántica:** ✅ completa y validada con un repo real (`summarize` + `embed`).
- **Fase 3 — Capa de consulta:** ✅ implementada (`ask` + `serve`): agente con búsqueda vectorial sobre resúmenes y SQL de solo lectura sobre el grafo, con citas `archivo:línea` y sesiones multi-turno.
- **Post-validación:** GitHub App + webhooks para análisis incremental, grafo de conocimiento formal, y enlace con el grafo de infraestructura (Terraform) de la herramienta hermana.

## Limitaciones conocidas del MVP

- No registra llamadas dentro de callbacks anónimos no asignados a variable.
- Re-exportaciones en barril (`export * from`) pueden dejar llamadas sin resolver.
- Análisis batch: re-analizar el repo completo en cada corrida (incremental viene después).
