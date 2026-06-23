# fred — MVP Fases 1, 2 y 3

Analizador de repositorios TypeScript que deduce la lógica de negocio de un repo y la vuelve consultable por arquitectos de software. El nombre es un homenaje a Fred Brooks, arquitecto del IBM System/360 y pionero de la arquitectura de software.

- **Fase 1 (determinística, sin IA):** parsea el repo con el compilador real de TypeScript (vía `ts-morph`), extrae símbolos, documentación y el grafo de llamadas, y lo guarda en SQLite.
- **Fase 2 (elevación semántica):** recorre el grafo de llamadas de hoja a raíz y resume con Claude la *regla de negocio* de cada función (usando los resúmenes de sus callees como contexto), luego cada módulo y cada dominio. Genera embeddings de los resúmenes con Voyage AI.
- **Fase 3 (capa de consulta RAG):** un agente con Claude responde preguntas de arquitecto ("¿dónde está la regla X?", "¿qué se rompe si cambio Y?") combinando búsqueda vectorial sobre los resúmenes y SQL de solo lectura sobre el grafo, citando siempre `archivo:línea`. Disponible como comando `ask` y como endpoint HTTP (`serve`).
- **Artefacto sellado (`.fdb`):** el `.db` SQLite puede empaquetarse en un `.fdb` cifrado (`HEADER` en claro + `PAYLOAD` AES-256-GCM + firma HMAC-SHA256). El header lleva los metadatos no sensibles (repo, schema, contadores) para validarse sin descifrar; el contenido se descifra **solo en memoria, nunca a disco**. Es el formato pensado para viajar entre el CI y el hub multi-repo (`../fred-hub`). El comando `build` corre el pipeline completo y entrega un `.fdb` en un solo paso.

## Requisitos

- Node.js >= 22 (usa el SQLite nativo de Node, sin compilación de binarios)

## Instalación

Requisito único: Node.js >= 22. Para instalar el comando `fred` en cualquier equipo, directo desde GitHub (no hace falta clonar):

```bash
npm install -g git+https://github.com/sarjonaws/code-busisness-analizer.git
fred --help
```

Desde una copia local del repo:

```bash
npm install
npm install -g .    # o `npm link` durante el desarrollo
fred --help
```

Para desarrollo sin instalar, todos los comandos funcionan igual con `npx tsx src/cli.ts` en lugar de `fred`:

```bash
npm install
npx tsx src/cli.ts --help
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

# 5. Consultas RAG (Fase 3 — si faltan las claves o la base, el CLI las pide al iniciar)
npx tsx src/cli.ts ask "¿Dónde está la regla de descuentos y qué se rompe si la cambio?" --db repo.db
npx tsx src/cli.ts tui --db repo.db                 # interfaz interactiva TUI (recomendada)
npx tsx src/cli.ts chat --db repo.db                # REPL simple (funciona también con stdin por pipe)
npx tsx src/cli.ts serve --db repo.db --port 3000   # endpoint de chat HTTP

# 6. Artefacto cifrado .fdb (empaquetado para distribución / hub multi-repo)
npx tsx src/cli.ts build ./ruta/al/repo --out repo.fdb --passphrase <p>   # analyze → summarize → embed → seal en un paso
npx tsx src/cli.ts wizard --db repo.db --out repo.fdb                     # asistente interactivo: prepara la base y la sella
npx tsx src/cli.ts seal repo.db --out repo.fdb --passphrase <p>           # cifra un .db existente en .fdb
npx tsx src/cli.ts open repo.fdb --passphrase <p>                         # descifra, verifica firma y muestra el header (sin escribir a disco)

# ask/chat/tui aceptan directamente un .fdb (lo descifran en memoria)
npx tsx src/cli.ts ask "¿Dónde está la regla de descuentos?" --db repo.fdb --passphrase <p>
npx tsx src/cli.ts tui --db repo.fdb --passphrase <p>
```

La passphrase puede pasarse con `--passphrase` o por la variable de entorno `FRED_FDB_PASSPHRASE`; `build` y `seal` también la piden por teclado (oculta, con confirmación) si hay terminal interactiva. En entornos sin TTY (CI) la passphrase debe venir por flag o env. **La passphrase es la única forma de abrir el `.fdb`: si se pierde, el contenido es irrecuperable.**

`ask`, `chat` y `tui` preparan la sesión antes de empezar: si falta `ANTHROPIC_API_KEY` o `VOYAGE_API_KEY` las piden por teclado (entrada oculta) y ofrecen guardarlas en `~/.fred/credentials.json` para no pedirlas en cada sesión (las variables de entorno, si existen, tienen prioridad). Si la base de `--db` no existe ofrecen las `.db` del directorio actual o construyen una nueva pidiendo la ruta del proyecto (analyze → summarize → embed, requiere las claves). Si la base existe pero le faltan resúmenes o embeddings, completan solo lo pendiente. En entornos sin terminal interactiva (pipes, CI) no preguntan nada: validan y fallan con un mensaje accionable.

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
- `meta` — metadatos del artefacto (schema v2): `schema_version`, `repo_name`, `repo_remote`, `commit_sha`, `branch`, `generated_at`, `fred_version`. Las bases legacy sin `meta` (v1) se toleran en toda la CLI.

## Formato `.fdb` (artefacto sellado)

El `.fdb` es el sucesor cifrado del `.db`. Su layout (todo little-endian) es:

```
HEADER  (texto plano, no sensible)  → magic FRED01, schema_version, repo_name,
                                       generated_at, fingerprint de clave, contadores
                                       n_summaries / n_embeddings, longitudes de cada zona
PAYLOAD (cifrado AES-256-GCM)        → el .db SQLite completo (salt + iv + ciphertext + auth_tag)
FIRMA   (HMAC-SHA256)                → cubre header + payload; detecta manipulación
```

La clave se deriva de la passphrase con `scrypt` y una salt aleatoria por archivo. El header existe para que el hub valide el artefacto (repo, versión, completitud) **sin descifrar nada**. Ver `docs/fred-fdb-implementacion.md` para el contexto y las decisiones de diseño completas, y `docs/fred-modelo-negocio.md` para cómo encaja el `.fdb` en los planes de suscripción.

## Tests

```bash
npx tsx --test src/fdb.test.ts   # spec binario del header .fdb (round-trip, validaciones)
```

## Decisiones de diseño

- **ts-morph en vez de tree-sitter:** para TypeScript, el type-checker del compilador resuelve a qué declaración apunta cada llamada (incluso a través de imports), cosa que un parser sintáctico no puede hacer. Eso vuelve confiable el análisis de impacto.
- **JSDoc como materia prima:** la columna `doc` ya captura la intención escrita por los devs; en la Fase 2 el LLM la combina con el cuerpo de la función para producir el resumen de regla de negocio.
- **SQLite:** cero infraestructura; el .db es portable y la capa RAG lo consulta directo.

## Roadmap

- **Fase 2 — Elevación semántica:** ✅ completa y validada con un repo real (`summarize` + `embed`).
- **Fase 3 — Capa de consulta:** ✅ implementada (`ask` + `serve`): agente con búsqueda vectorial sobre resúmenes y SQL de solo lectura sobre el grafo, con citas `archivo:línea` y sesiones multi-turno.
- **Artefacto `.fdb` y multi-repo:** ✅ formato cifrado `.fdb` (`build` / `seal` / `open` / `wizard`) y habilitadores multi-repo (tabla `meta`, `RagAgent` federado, hub hermano `../fred-hub`).
- **Post-validación:** GitHub App + webhooks para análisis incremental, paso de CI que publique el `.fdb` como artefacto, gestión de claves vía KMS (BYOK), y enlace con el grafo de infraestructura (Terraform) de la herramienta hermana.

## Limitaciones conocidas del MVP

- No registra llamadas dentro de callbacks anónimos no asignados a variable.
- Re-exportaciones en barril (`export * from`) pueden dejar llamadas sin resolver.
- Análisis batch: re-analizar el repo completo en cada corrida (incremental viene después).
