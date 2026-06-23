# fred — Algoritmo de refinamiento del `.fdb`

> Especificación técnica del pipeline que construye el `.fdb` **refinando** el
> repositorio antes de invocar al LLM, para evitar el pico de consumo de tokens en el
> arranque en frío sin perder la información que fred necesita para responder.
>
> Documento de diseño, previo a integrarse al documento de implementación del `.fdb`.

---

## 1. Problema

El enfoque ingenuo —enviar cada fragmento de código crudo al LLM para resumirlo—
genera un pico de tokens en el primer análisis (arranque en frío) que escala con el
tamaño del repo. En proyectos empresariales grandes ese pico es el costo que preocupa.

El objetivo es un algoritmo que:

1. **Acote y reduzca** el volumen enviado al LLM mediante preprocesamiento determinista
   y gratuito.
2. **Priorice** el gasto de tokens en el código que más valor aporta.
3. **Imponga un techo** de tokens al arranque en frío, predecible de antemano.
4. Produzca un `.fdb` con **data refinada pero útil** para la lectura de fred.

Principio rector: **gastar tokens de LLM solo donde aportan valor; todo lo demás se
resuelve con código local, parsing y embeddings baratos.**

---

## 2. Visión general del pipeline

```
repo
 │
 ▼  Etapa 0 — Descubrimiento y filtrado de alcance        (determinista, gratis)
 ▼  Etapa 1 — Parsing AST y chunking estructural          (determinista, gratis)
 ▼  Etapa 2 — Deduplicación por hash de contenido         (determinista, gratis)
 ▼  Etapa 3 — Scoring de valor y plan de representación   (determinista, gratis)
 ▼  Etapa 4 — Embeddings (siempre, para todo)             (barato)
 ▼  Etapa 5 — Sumarización jerárquica y selectiva         (LLM, acotada por presupuesto)
 ▼  Etapa 6 — Ensamblado del .fdb
.fdb
```

El volumen de tokens enviado al LLM se reduce en cada etapa previa, y la Etapa 5 nunca
excede un presupuesto fijado.

---

## 3. Etapa 0 — Descubrimiento y filtrado de alcance

Excluir, sin tocar el LLM, lo que no vale la pena indexar:

- dependencias vendoreadas (`node_modules`, `vendor`, `.venv`, …)
- código generado (protobufs, clientes autogenerados, migraciones)
- minificados y bundles (`*.min.js`, `dist/`, `build/`)
- lock files, assets binarios, fixtures de tests
- archivos sobre un umbral de tamaño o con baja proporción de código real

```
function scopeFilter(files, config):
    return files.filter(f =>
        not matchesAny(f.path, config.excludeGlobs) and
        f.size <= config.maxFileBytes and
        isSourceCode(f.language))
```

Es la palanca más grande: en repos empresariales puede dejar fuera la mayoría del
conteo bruto de líneas.

---

## 4. Etapa 1 — Parsing AST y chunking estructural

En lugar de cortar el texto por líneas o tamaño fijo, se parsea con un parser real
(tree-sitter, una gramática por lenguaje) y se extraen **unidades semánticas**:
funciones, métodos, clases, con sus metadatos.

```
function extractUnits(file):
    tree = parseAST(file)              # tree-sitter
    units = []
    for node in tree.functionsAndClasses():
        units.push({
            id:          hash(file.path + node.range),
            file:        file.path,
            kind:        node.kind,            # function | method | class
            name:        node.name,
            signature:   node.signature,       # params + tipos + retorno
            docstring:   node.leadingDoc,
            body:        node.bodyText,
            calls:       node.outgoingCalls(), # grafo: a quién invoca
            isExported:  node.isPublic,
            loc:         node.lineCount,
            cyclomatic:  cyclomaticComplexity(node),
            isGenerated: looksGenerated(file, node)
        })
    return units
```

De aquí sale el **esqueleto** de cada unidad —firma, nombre, doc, llamadas— que es lo
denso en semántica y barato en tokens.

---

## 5. Etapa 2 — Deduplicación por hash de contenido

Los repos repiten mucho: boilerplate copiado, CRUD generado, DTOs casi idénticos.

```
function dedupByHash(units):
    seen = {}
    for u in units:
        h = normalizedHash(u.body)        # ignora espacios, nombres locales
        if h in seen:
            u.duplicateOf = seen[h].id    # reutilizará su resumen
        else:
            seen[h] = u
    return units
```

Las unidades marcadas como duplicado **no** se resumen de nuevo: heredan el resumen de
su representante. Pagas por lo único, no por las copias.

---

## 6. Etapa 3 — Scoring de valor y plan de representación

Cada unidad recibe un puntaje de "cuánto valor aporta resumirla con el LLM". El puntaje
decide su nivel de representación.

```
function summaryValue(u):
    s = 0
    if u.isExported:          s += 3      # la API pública es lo que más importa
    s += min(u.cyclomatic, 10) * 0.4      # lógica compleja merece resumen
    s += min(u.loc / 20, 5)               # tamaño, con tope
    if u.docstring != null:   s += 1      # intención documentada vale capturarla
    if isTrivialPattern(u):   s -= 4      # getters/setters, delegaciones simples
    if u.isGenerated:         s -= 5
    return s
```

```
function decideRepresentation(u, config):
    if u.duplicateOf != null:               return REUSE
    if u.score >= config.bodyThreshold:     return SKELETON_PLUS_BODY  # rico
    if u.score >= config.skeletonThreshold: return SKELETON_ONLY       # medio
    return EMBED_ONLY                                                  # mínimo
```

Niveles de representación:

| Nivel | Qué se envía al LLM | Para qué código |
|---|---|---|
| `SKELETON_PLUS_BODY` | esqueleto + cuerpo | API pública, lógica compleja |
| `SKELETON_ONLY` | firma + doc + llamadas | código intermedio, comportamiento inferible |
| `EMBED_ONLY` | nada al LLM (solo embedding) | trivial, repetitivo, generado |
| `REUSE` | nada (hereda resumen) | duplicados |

La heurística de "qué conservar" vive aquí: el cuerpo completo solo viaja al LLM cuando
el puntaje lo justifica; lo demás se destila a esqueleto o se deja solo como embedding.

---

## 7. Etapa 4 — Embeddings (siempre, para todo)

Los embeddings son baratos (~$0.02 / M tokens), así que **toda** unidad se vectoriza,
independientemente de su nivel — eso garantiza que todo el repo sea recuperable aunque
no todo tenga resumen de LLM.

```
function embedAll(units):
    for u in units:
        u.embedding = embed(u.distilledText())   # esqueleto, no cuerpo crudo
```

Esto **desacopla** la recuperabilidad (barata) de la riqueza del resumen (cara).

---

## 8. Etapa 5 — Sumarización jerárquica y selectiva, con presupuesto

Aquí está el mecanismo que **acota el pico**: las unidades se procesan en orden de
valor descendente, gastando contra un presupuesto de tokens fijo. Al agotarse, las
unidades restantes se degradan a `EMBED_ONLY` (siguen siendo recuperables, sin resumen).

```
function summarizeWithBudget(units, config):
    queue = units.filter(u => u.plan in [SKELETON_ONLY, SKELETON_PLUS_BODY])
                 .sortByScoreDesc()
    spent = 0
    for u in queue:
        cost = estimateTokens(u)               # input + output esperados
        if spent + cost > config.tokenBudget:
            u.plan = EMBED_ONLY                # degradar: ya tiene embedding
            continue
        model = u.score >= config.premiumThreshold ? PREMIUM : CHEAP
        u.summary = llmSummarize(u.payloadForPlan(), model)
        spent += cost
    return spent
```

Tras resumir las unidades, se hace el **roll-up jerárquico** (map-reduce): los niveles
superiores operan sobre texto ya comprimido —resúmenes, no código—, por lo que su costo
es marginal.

```
function rollup(units):
    for (file, group) in units.groupByFile():
        inputs = group.map(u => u.summary ?? u.skeleton)
        fileSummary[file] = llmSummarize(join(inputs), CHEAP)
    for (mod, group) in fileSummary.groupByModule():
        moduleSummary[mod] = llmSummarize(join(group), CHEAP)
    return { fileSummary, moduleSummary }
```

Notas:

- **Caching de prompt** para unidades del mismo archivo que comparten contexto
  (cabecera, imports) reduce el input repetido.
- El roll-up por archivo/módulo da a fred resúmenes de alto nivel para responder
  preguntas arquitectónicas, a costo casi nulo porque parte de texto comprimido.

---

## 9. Etapa 6 — Ensamblado del `.fdb`

```
function assembleFDB(units, rollups, meta):
    payload = {
        units:    units.map(toRecord),     # embedding + (summary | skeleton)
        files:    rollups.fileSummary,
        modules:  rollups.moduleSummary,
        graph:    callGraph(units),
        meta:     meta                     # repo, commit, schema_version, hashes
    }
    return encrypt(serialize(payload))     # formato .fdb cifrado
```

---

## 10. Pipeline completo

```
function buildFDB(repoPath, config):
    files = scopeFilter(discover(repoPath), config)        # Etapa 0
    units = files.flatMap(extractUnits)                    # Etapa 1
    units = dedupByHash(units)                             # Etapa 2
    for u in units:                                        # Etapa 3
        u.score = summaryValue(u)
        u.plan  = decideRepresentation(u, config)
    embedAll(units)                                        # Etapa 4
    summarizeWithBudget(units, config)                     # Etapa 5
    rollups = rollup(units)
    return assembleFDB(units, rollups, buildMeta(repoPath))# Etapa 6
```

---

## 11. Control del pico de arranque en frío

Tres mecanismos garantizan que el primer análisis no se dispare:

1. **Techo duro de tokens** (`config.tokenBudget`): la Etapa 5 nunca lo excede. El costo
   máximo del arranque en frío es conocido **antes** de correr.
2. **Priorización por valor**: si el presupuesto es escaso, se gasta primero en la API
   pública y la lógica compleja; lo trivial cae a `EMBED_ONLY`.
3. **Estimación previa**: se puede contar tokens del plan y mostrar el costo estimado
   antes de ejecutar, y abortar o ajustar el presupuesto.

Para corridas posteriores, el `id` por hash de cada unidad permite **caché incremental**:
solo se re-procesan las unidades cuyo hash cambió. El pico es un evento único.

---

## 12. Parámetros configurables

| Parámetro | Efecto |
|---|---|
| `excludeGlobs`, `maxFileBytes` | agresividad del filtrado de alcance |
| `bodyThreshold`, `skeletonThreshold` | umbrales de nivel de representación |
| `premiumThreshold` | a partir de qué puntaje se usa el modelo caro |
| `tokenBudget` | techo de gasto del arranque en frío |
| `cheapModel`, `premiumModel` | qué modelos usar (nube o local) |

---

## 13. Tradeoffs y validación

- El refinamiento es **lossy por diseño**: cambia información por costo. No se deben
  tirar cuerpos a ciegas; las heurísticas de la Etapa 3 existen para conservar lo que
  importa (complejidad, visibilidad, tamaño).
- Requiere **una gramática tree-sitter por lenguaje**; es mantenimiento, pero las
  gramáticas existen para casi todos los lenguajes mayores.
- La calidad de los resúmenes desde input destilado baja un poco frente al código
  completo. **Debe evaluarse contra el codebase real** del cliente antes de fijar los
  umbrales.
- `EMBED_ONLY` mantiene la recuperabilidad pero sin resumen rico: aceptable para código
  trivial, no para lógica central —de ahí la importancia del scoring.

---

## 14. Conexión con el resto del producto

- El mismo `id` por hash habilita el modelo incremental del `.fdb` y la caché.
- Los modelos (`cheapModel`/`premiumModel`) pasan por el proxy de IA intercambiable:
  nube (Claude/Bedrock) u on-premise (vLLM), sin cambiar el algoritmo.
- A futuro, el `cheapModel` puede ser el modelo de resumen afinado y local del flywheel
  de costos: entonces el pico de arranque en frío se vuelve casi gratis.
