#!/usr/bin/env node
/**
 * CLI del MVP — Fases 1 y 2.
 *
 *   npx tsx src/cli.ts analyze ./mi-repo --db repo.db
 *   npx tsx src/cli.ts stats --db repo.db
 *   npx tsx src/cli.ts who-calls applyDiscount --db repo.db
 *   npx tsx src/cli.ts calls-of createOrder --db repo.db
 *   npx tsx src/cli.ts search descuento --db repo.db
 *   npx tsx src/cli.ts impact PricingService --db repo.db
 *   npx tsx src/cli.ts summarize ./mi-repo --db repo.db     (Fase 2, requiere ANTHROPIC_API_KEY)
 *   npx tsx src/cli.ts summaries [símbolo] --db repo.db
 *   npx tsx src/cli.ts embed --db repo.db                   (Fase 2, requiere VOYAGE_API_KEY)
 *   npx tsx src/cli.ts ask "¿dónde está X regla?" --db repo.db   (Fase 3)
 *   npx tsx src/cli.ts chat --db repo.db                         (Fase 3, sesión interactiva simple)
 *   npx tsx src/cli.ts tui --db repo.db                          (Fase 3, interfaz TUI con Ink)
 *   npx tsx src/cli.ts serve --db repo.db --port 3000            (Fase 3, endpoint de chat)
 */
import { Command } from "commander";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { analyze } from "./analyzer.js";
import { readMeta } from "./db.js";
import { summarize } from "./summarize.js";
import { embedSummaries } from "./embed.js";
import { RagAgent, formatUsage } from "./rag.js";
import { serve } from "./server.js";
import { viewer } from "./viewer.js";
import { prepareSession, prepareFdbSession, resolveApiKeys, resolveSealPassphrase } from "./setup.js";
import { sealDb, openFdb } from "./seal.js";

const program = new Command();
program
  .name("fred")
  .description("Analizador estructural de repos TypeScript (Fase 1 del MVP)")
  .version((createRequire(import.meta.url)("../package.json") as { version: string }).version);

program
  .command("analyze")
  .argument("<repo>", "ruta al repositorio TypeScript")
  .option("--db <path>", "archivo SQLite de salida", "code.db")
  .option("--repo <name>", "nombre del repo en los metadatos (default: remote de git o carpeta)")
  .action((repo, opts) => {
    console.log(`Analizando ${repo} ...`);
    const t0 = Date.now();
    const stats = analyze({ repoPath: repo, dbPath: opts.db, repoName: opts.repo });
    console.log(`Listo en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  Repo:      ${stats.repoName}${stats.commitSha ? ` @ ${stats.commitSha.slice(0, 8)}` : ""}`);
    console.log(`  Archivos:  ${stats.files}`);
    console.log(`  Símbolos:  ${stats.symbols}`);
    console.log(`  Llamadas:  ${stats.calls} (${stats.resolvedCalls} resueltas a código del repo)`);
    console.log(`  Base:      ${opts.db}`);
  });

const open = (dbPath: string) => new DatabaseSync(dbPath, { readOnly: true });

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// Errores esperables (falta de API key, ruta inexistente) sin stack trace
const run = (fn: () => Promise<void>) =>
  fn().catch((e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  });

const isFdbPath = (p: string) => /\.fdb$/i.test(p);

/**
 * Construye el agente RAG para ask/chat. Si --db apunta a un .fdb, lo descifra
 * en memoria (claves + passphrase vía prepareFdbSession); si es un .db, usa el
 * flujo interactivo de prepareSession. Devuelve también la etiqueta de la base
 * para mostrarla en la cabecera del chat.
 */
async function buildAgent(opts: { db: string; model: string; passphrase?: string }): Promise<{ agent: RagAgent; label: string }> {
  if (isFdbPath(opts.db)) {
    const db = await prepareFdbSession({ fdbPath: opts.db, passphrase: opts.passphrase });
    const repo = readMeta(db).repo_name ?? "";
    const agent = new RagAgent({ sources: [{ repo, db }], model: opts.model });
    return { agent, label: resolve(opts.db) };
  }
  const dbPath = await prepareSession({ dbPath: opts.db, model: opts.model });
  return { agent: new RagAgent({ dbPath, model: opts.model }), label: dbPath };
}

program
  .command("stats")
  .option("--db <path>", "archivo SQLite", "code.db")
  .action((opts) => {
    const db = open(opts.db);
    const meta = readMeta(db);
    if (meta.repo_name) {
      const sha = meta.commit_sha ? ` @ ${meta.commit_sha.slice(0, 8)}` : "";
      const branch = meta.branch ? ` (${meta.branch})` : "";
      console.log(`Repo: ${meta.repo_name}${sha}${branch}`);
      if (meta.generated_at) console.log(`  Analizado: ${meta.generated_at}`);
      console.log();
    }
    const byKind = db.prepare(`SELECT kind, COUNT(*) c FROM symbols GROUP BY kind ORDER BY c DESC`).all() as any[];
    console.log("Símbolos por tipo:");
    for (const r of byKind) console.log(`  ${String(r.kind).padEnd(10)} ${r.c}`);
    const hot = db.prepare(`
      SELECT s.name, s.parent, COUNT(*) n
      FROM calls c JOIN symbols s ON s.id = c.callee_id
      GROUP BY c.callee_id ORDER BY n DESC LIMIT 10
    `).all() as any[];
    console.log("\nSímbolos más llamados (candidatos a lógica de negocio central):");
    for (const r of hot) console.log(`  ${r.parent ? r.parent + "." : ""}${r.name}  ←  ${r.n} llamadas`);
  });

program
  .command("who-calls")
  .argument("<name>", "nombre del símbolo")
  .option("--db <path>", "archivo SQLite", "code.db")
  .action((name, opts) => {
    const db = open(opts.db);
    const rows = db.prepare(`
      SELECT caller.name AS caller, caller.parent AS cparent, f.path, c.line
      FROM calls c
      JOIN symbols callee ON callee.id = c.callee_id
      JOIN symbols caller ON caller.id = c.caller_id
      JOIN files f ON f.id = caller.file_id
      WHERE callee.name = ?
      ORDER BY f.path, c.line
    `).all(name) as any[];
    if (!rows.length) return console.log(`Nadie llama a "${name}" (o no se resolvió).`);
    console.log(`Llamadas a "${name}":`);
    for (const r of rows)
      console.log(`  ${r.cparent ? r.cparent + "." : ""}${r.caller}  →  ${r.path}:${r.line}`);
  });

program
  .command("calls-of")
  .argument("<name>", "nombre del símbolo")
  .option("--db <path>", "archivo SQLite", "code.db")
  .action((name, opts) => {
    const db = open(opts.db);
    const rows = db.prepare(`
      SELECT c.callee_name, callee.name AS resolved, f.path AS callee_file, c.line
      FROM calls c
      JOIN symbols caller ON caller.id = c.caller_id
      LEFT JOIN symbols callee ON callee.id = c.callee_id
      LEFT JOIN files f ON f.id = callee.file_id
      WHERE caller.name = ?
      ORDER BY c.line
    `).all(name) as any[];
    if (!rows.length) return console.log(`"${name}" no llama a nada (o no existe).`);
    console.log(`"${name}" llama a:`);
    for (const r of rows)
      console.log(`  ${r.callee_name}${r.callee_file ? `  (${r.callee_file})` : "  [externo]"}`);
  });

program
  .command("search")
  .argument("<text>", "texto a buscar en nombres y documentación")
  .option("--db <path>", "archivo SQLite", "code.db")
  .action((text, opts) => {
    const db = open(opts.db);
    const rows = db.prepare(`
      SELECT s.name, s.kind, s.parent, s.doc, f.path, s.start_line
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.name LIKE '%' || ? || '%' OR s.doc LIKE '%' || ? || '%'
      LIMIT 25
    `).all(text, text) as any[];
    if (!rows.length) return console.log("Sin resultados.");
    for (const r of rows) {
      console.log(`  [${r.kind}] ${r.parent ? r.parent + "." : ""}${r.name}  —  ${r.path}:${r.start_line}`);
      if (r.doc) console.log(`      ${String(r.doc).split("\n")[0]}`);
    }
  });

program
  .command("impact")
  .argument("<name>", "símbolo o clase a evaluar")
  .option("--db <path>", "archivo SQLite", "code.db")
  .option("--depth <n>", "profundidad del análisis", "3")
  .action((name, opts) => {
    const db = open(opts.db);
    // BFS inverso sobre el grafo de llamadas: ¿qué se rompe si cambio X?
    const seeds = db.prepare(
      `SELECT id, name, parent FROM symbols WHERE name = ? OR parent = ?`
    ).all(name, name) as any[];
    if (!seeds.length) return console.log(`No encontré "${name}".`);

    const visited = new Set<number>(seeds.map((s) => s.id));
    let frontier = seeds.map((s) => s.id);
    const impacted: any[] = [];
    const callersOf = db.prepare(`
      SELECT DISTINCT caller.id, caller.name, caller.parent, f.path
      FROM calls c JOIN symbols caller ON caller.id = c.caller_id
      JOIN files f ON f.id = caller.file_id
      WHERE c.callee_id = ?
    `);

    for (let d = 0; d < Number(opts.depth) && frontier.length; d++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const r of callersOf.all(id) as any[]) {
          if (!visited.has(r.id)) {
            visited.add(r.id);
            impacted.push({ ...r, depth: d + 1 });
            next.push(r.id);
          }
        }
      }
      frontier = next;
    }

    if (!impacted.length) return console.log(`Nada depende de "${name}" dentro del repo.`);
    console.log(`Si cambias "${name}", esto se ve afectado (radio de impacto):`);
    for (const r of impacted)
      console.log(`  ${"  ".repeat(r.depth - 1)}↳ ${r.parent ? r.parent + "." : ""}${r.name}  (${r.path})`);
  });

program
  .command("summarize")
  .argument("<repo>", "ruta al repositorio (para leer los cuerpos de las funciones)")
  .option("--db <path>", "archivo SQLite", "code.db")
  .option("--model <id>", "modelo de Claude", "claude-opus-4-8")
  .option("--concurrency <n>", "llamadas concurrentes a la API", "4")
  .option("--force", "re-resumir todo aunque los hashes no hayan cambiado")
  .option("--dry-run", "mostrar el plan sin llamar a la API")
  .action((repo, opts) => run(async () => {
    const t0 = Date.now();
    const stats = await summarize({
      repoPath: repo,
      dbPath: opts.db,
      model: opts.model,
      concurrency: Number(opts.concurrency),
      force: opts.force,
      dryRun: opts.dryRun,
    });
    console.log(`${opts.dryRun ? "Plan listo" : "Listo"} en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  Funciones: ${stats.functions.summarized} resumidas, ${stats.functions.reusedFromCache} de caché, ${stats.functions.unchanged} sin cambios`);
    console.log(`  Módulos:   ${stats.modules.summarized} resumidos, ${stats.modules.unchanged} sin cambios`);
    console.log(`  Dominios:  ${stats.domains.summarized} resumidos, ${stats.domains.unchanged} sin cambios`);
  }));

program
  .command("summaries")
  .argument("[name]", "filtrar por nombre de símbolo, archivo o carpeta")
  .option("--db <path>", "archivo SQLite", "code.db")
  .action((name, opts) => {
    const db = open(opts.db);
    const filter = name ? `%${name}%` : "%";
    const rows = db.prepare(`
      SELECT su.level, su.text, su.domain, s.name, s.parent, f.path AS file_path, sf.path AS sym_path, s.start_line
      FROM summaries su
      LEFT JOIN symbols s ON s.id = su.symbol_id
      LEFT JOIN files sf ON sf.id = s.file_id
      LEFT JOIN files f ON f.id = su.file_id
      WHERE COALESCE(s.name, f.path, su.domain) LIKE ?
      ORDER BY CASE su.level WHEN 'domain' THEN 0 WHEN 'module' THEN 1 ELSE 2 END, COALESCE(su.domain, f.path, sf.path)
    `).all(filter) as any[];
    if (!rows.length) return console.log("Sin resúmenes. Corre primero: summarize <repo> --db " + opts.db);
    for (const r of rows) {
      const target =
        r.level === "domain" ? `[dominio] ${r.domain}/`
        : r.level === "module" ? `[módulo]  ${r.file_path}`
        : `[función] ${r.parent ? r.parent + "." : ""}${r.name}  (${r.sym_path}:${r.start_line})`;
      console.log(`\n${target}`);
      console.log(`  ${String(r.text).split("\n").join("\n  ")}`);
    }
  });

program
  .command("embed")
  .option("--db <path>", "archivo SQLite", "code.db")
  .option("--model <id>", "modelo de embeddings de Voyage AI", "voyage-3.5")
  .option("--force", "re-embeber todo")
  .action((opts) => run(async () => {
    const stats = await embedSummaries({ dbPath: opts.db, model: opts.model, force: opts.force });
    console.log(`Listo: ${stats.embedded} embeddings generados, ${stats.unchanged} sin cambios.`);
  }));

program
  .command("ask")
  .argument("<question>", "pregunta en lenguaje natural sobre el repo analizado")
  .option("--db <path>", "archivo SQLite (.db) o artefacto cifrado (.fdb)", "code.db")
  .option("--model <id>", "modelo de Claude", "claude-opus-4-8")
  .option("--passphrase <p>", "passphrase si --db es un .fdb (o env FRED_FDB_PASSPHRASE)")
  .action((question, opts) => run(async () => {
    const { agent } = await buildAgent({ db: opts.db, model: opts.model, passphrase: opts.passphrase });
    const result = await agent.ask(question, [], {
      onTool: (name, input) => console.log(dim(`  → ${name} ${JSON.stringify(input)}`)),
      onText: (delta) => process.stdout.write(delta),
      onRetry: (n, ms, why) => console.error(dim(`  API saturada (${why}); reintento ${n} en ${(ms / 1000).toFixed(0)}s ...`)),
    });
    agent.close();
    console.log(`\n\n${dim("─".repeat(60))}\n${dim(formatUsage(result.usage))}`);
  }));

program
  .command("chat")
  .description("sesión interactiva de chat sobre el repo analizado (multi-turno, con streaming)")
  .option("--db <path>", "archivo SQLite (.db) o artefacto cifrado (.fdb)", "code.db")
  .option("--model <id>", "modelo de Claude", "claude-opus-4-8")
  .option("--passphrase <p>", "passphrase si --db es un .fdb (o env FRED_FDB_PASSPHRASE)")
  .action((opts) => run(async () => {
    const { agent, label: dbPath } = await buildAgent({ db: opts.db, model: opts.model, passphrase: opts.passphrase });
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    // Cola de líneas propia: lo escrito mientras el agente trabaja no se pierde,
    // se encola como siguiente pregunta (readline descarta líneas sin listener).
    const pending: string[] = [];
    const waiters: ((line: string | null) => void)[] = [];
    let stdinClosed = false;
    rl.on("line", (line) => {
      const w = waiters.shift();
      if (w) w(line);
      else pending.push(line);
    });
    rl.on("close", () => {
      stdinClosed = true;
      waiters.splice(0).forEach((w) => w(null));
    });
    const nextLine = (): Promise<string | null> => {
      if (pending.length) return Promise.resolve(pending.shift()!);
      if (stdinClosed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    };

    let history: Parameters<RagAgent["ask"]>[1] = [];
    const sessionTotal = { calls: 0, cost: 0 };

    console.log(bold(`fred chat`) + dim(`  ·  base: ${dbPath}  ·  modelo: ${opts.model}`));
    console.log(dim(`Comandos: /nueva (reiniciar sesión), /uso (acumulado), /salir (o Ctrl+C)\n`));

    while (true) {
      process.stdout.write(bold("tú › "));
      const line = await nextLine();
      if (line === null) break; // Ctrl+C / stdin cerrado
      const question = line.trim();
      if (!question) continue;
      if (question === "/salir" || question === "/exit") break;
      if (question === "/nueva") {
        history = [];
        console.log(dim("Sesión reiniciada.\n"));
        continue;
      }
      if (question === "/uso") {
        console.log(dim(`Acumulado de la sesión: ${sessionTotal.calls} llamadas a Claude, ~$${sessionTotal.cost.toFixed(4)} USD\n`));
        continue;
      }

      try {
        process.stdout.write("\n");
        const result = await agent.ask(question, history, {
          onTool: (name, input) => console.log(dim(`  → ${name} ${JSON.stringify(input)}`)),
          onText: (delta) => process.stdout.write(delta),
          onRetry: (n, ms, why) => console.error(dim(`  API saturada (${why}); reintento ${n} en ${(ms / 1000).toFixed(0)}s ...`)),
        });
        history = result.history;
        sessionTotal.calls += result.usage.claudeCalls;
        sessionTotal.cost += result.usage.estimatedCostUSD ?? 0;
        console.log(`\n${dim("─".repeat(60))}\n${dim(formatUsage(result.usage))}\n`);
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : e}\n`);
      }
    }

    rl.close();
    agent.close();
    if (sessionTotal.calls)
      console.log(dim(`\nTotal de la sesión: ${sessionTotal.calls} llamadas a Claude, ~$${sessionTotal.cost.toFixed(4)} USD`));
  }));

program
  .command("tui")
  .description("interfaz interactiva TUI (Ink): markdown renderizado, spinner, streaming")
  .option("--db <path>", "archivo SQLite (.db) o artefacto cifrado (.fdb)", "code.db")
  .option("--model <id>", "modelo de Claude", "claude-opus-4-8")
  .option("--passphrase <p>", "passphrase si --db es un .fdb (o env FRED_FDB_PASSPHRASE)")
  .action((opts) => run(async () => {
    const { agent, label } = await buildAgent({ db: opts.db, model: opts.model, passphrase: opts.passphrase });
    // Import dinámico: no cargar React/Ink para los demás comandos
    const { runTui } = await import("./tui.js");
    runTui({ agent, label, model: opts.model });
  }));

// Passphrase de cifrado: flag explícito o env. Sin TTY no preguntamos (CI-friendly).
const resolvePassphrase = (flag?: string): string => {
  const p = flag ?? process.env.FRED_FDB_PASSPHRASE;
  if (!p) {
    throw new Error(
      "falta la passphrase: usa --passphrase <p> o la variable de entorno FRED_FDB_PASSPHRASE"
    );
  }
  return p;
};

program
  .command("wizard")
  .description("asistente interactivo (como el TUI): resuelve claves y prepara la base paso a paso, y en vez de abrir el chat genera un .fdb cifrado")
  .option("--db <path>", "base intermedia / a preparar", "code.db")
  .option("--out <path>", "archivo .fdb de salida (default: junto a la base)")
  .option("--passphrase <p>", "passphrase de cifrado (o env FRED_FDB_PASSPHRASE; si falta, se pide)")
  .option("--model <id>", "modelo de Claude para los resúmenes", "claude-opus-4-8")
  .option("--keep-db", "conservar la base .db sin cifrar tras generar el .fdb")
  .action((opts) => run(async () => {
    if (!(process.stdin.isTTY && process.stdout.isTTY))
      throw new Error("El asistente requiere una terminal interactiva. Sin TTY usa: build <repo> --out <fdb> --passphrase <p>.");

    // prepareSession hace exactamente lo que el TUI antes de abrir el chat:
    // resuelve claves y deja una base completa (analyze → summarize → embed).
    const dbPath = await prepareSession({ dbPath: opts.db, model: opts.model });

    const { createInterface } = await import("node:readline/promises");
    const ask = async (q: string) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await rl.question(q)).trim(); } finally { rl.close(); }
    };

    const defaultOut = dbPath.replace(/\.db$/i, "") + ".fdb";
    const out = resolve(opts.out ?? ((await ask(`Archivo .fdb de salida ${dim(`(Enter = ${defaultOut})`)}: `)) || defaultOut));
    const passphrase = await resolveSealPassphrase(opts.passphrase);

    console.log(`Cifrando en ${bold(out)} ...`);
    const { bytesWritten, header } = sealDb(dbPath, out, passphrase);
    console.log(`\n${bold("Listo")}.`);
    console.log(`  Repo:       ${header.repoName || "(sin meta)"}`);
    console.log(`  Resúmenes:  ${header.nSummaries ?? "?"}  ·  Embeddings: ${header.nEmbeddings ?? "?"}`);
    console.log(`  Clave:      ${header.publicKeyFingerprint}`);
    console.log(`  Salida:     ${out}  (${bytesWritten.toLocaleString()} bytes)`);

    // La base .db queda SIN cifrar; ofrecer borrarla (el .fdb ya tiene todo).
    if (!opts.keepDb) {
      const del = await ask(`¿Borrar la base sin cifrar ${dim(dbPath)}? ${dim("(s/N)")}: `);
      if (/^s/i.test(del)) {
        try {
          for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
          console.log(dim("  base sin cifrar borrada."));
        } catch {
          console.error(dim(`  no se pudo borrar ${dbPath}; bórrala a mano.`));
        }
      }
    }
  }));

program
  .command("build")
  .description("pipeline completo en un paso: analyze → summarize → embed → seal, entregando un .fdb cifrado")
  .argument("<repo>", "ruta al repositorio TypeScript")
  .option("--out <path>", "archivo .fdb de salida (default: <repo>.fdb)")
  .option("--passphrase <p>", "passphrase de cifrado (o env FRED_FDB_PASSPHRASE)")
  .option("--db <path>", "ruta del .db intermedio (default: temporal; si se indica, se conserva)")
  .option("--keep-db", "conservar el .db intermedio en vez de borrarlo")
  .option("--repo <name>", "nombre del repo en los metadatos (default: remote de git o carpeta)")
  .option("--model <id>", "modelo de Claude para los resúmenes", "claude-opus-4-8")
  .option("--concurrency <n>", "llamadas concurrentes a la API en summarize", "4")
  .option("--force", "regenerar resúmenes y embeddings aunque no hayan cambiado")
  .action((repo, opts) => run(async () => {
    const passphrase = resolvePassphrase(opts.passphrase);
    await resolveApiKeys();

    const out = resolve(opts.out ?? basename(resolve(repo)) + ".fdb");
    // Indicar --db implica conservarlo (es una ruta que el usuario nombró a propósito).
    const keep = Boolean(opts.keepDb || opts.db);
    const dbPath = opts.db
      ? resolve(opts.db)
      : keep
        ? out.replace(/\.fdb$/i, "") + ".db"
        : join(tmpdir(), `fred-build-${process.pid}-${Date.now()}.db`);

    const t0 = Date.now();
    try {
      console.log(`Analizando ${repo} ...`);
      const a = analyze({ repoPath: repo, dbPath, repoName: opts.repo });
      console.log(dim(`  ${a.files} archivos, ${a.symbols} símbolos, ${a.calls} llamadas (${a.resolvedCalls} resueltas)`));

      console.log(`Resumiendo reglas de negocio con ${opts.model} ${dim("(consume tokens)")} ...`);
      const s = await summarize({ repoPath: repo, dbPath, model: opts.model, concurrency: Number(opts.concurrency), force: opts.force });
      console.log(dim(`  ${s.functions.summarized} funciones, ${s.modules.summarized} módulos, ${s.domains.summarized} dominios resumidos`));

      console.log(`Generando embeddings con Voyage ...`);
      const e = await embedSummaries({ dbPath, force: opts.force });
      console.log(dim(`  ${e.embedded} generados, ${e.unchanged} sin cambios`));

      console.log(`Cifrando en ${bold(out)} ...`);
      const { bytesWritten, header } = sealDb(dbPath, out, passphrase);

      console.log(`\nListo en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(`  Repo:       ${header.repoName || "(sin meta)"}`);
      console.log(`  Resúmenes:  ${header.nSummaries ?? "?"}  ·  Embeddings: ${header.nEmbeddings ?? "?"}`);
      console.log(`  Clave:      ${header.publicKeyFingerprint}`);
      console.log(`  Salida:     ${out}  (${bytesWritten.toLocaleString()} bytes)`);
      if (keep) console.log(dim(`  .db intermedio conservado en: ${dbPath}`));
    } finally {
      // El .db intermedio es desechable salvo que el usuario pida conservarlo.
      // Best-effort: si falla el borrado (p. ej. base bloqueada en Windows tras un
      // error a media tubería) NO debe enmascarar el error real que viene del try.
      if (!keep) {
        try {
          for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
        } catch {
          console.error(dim(`  (no se pudo borrar el .db temporal ${dbPath}; bórralo a mano)`));
        }
      }
    }
  }));

program
  .command("seal")
  .description("cifra un .db en un artefacto .fdb (HEADER claro + payload AES-256-GCM + firma HMAC)")
  .argument("<db>", "archivo .db de entrada")
  .option("--out <path>", "archivo .fdb de salida (default: <db> con extensión .fdb)")
  .option("--passphrase <p>", "passphrase de cifrado (o env FRED_FDB_PASSPHRASE)")
  .action((db, opts) => run(async () => {
    const passphrase = resolvePassphrase(opts.passphrase);
    const out = opts.out ?? db.replace(/\.db$/i, "") + ".fdb";
    const t0 = Date.now();
    const { bytesWritten, header } = sealDb(db, out, passphrase);
    console.log(`Sellado en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  Repo:       ${header.repoName || "(sin meta)"}`);
    console.log(`  Schema:     v${header.schemaVersion}`);
    console.log(`  Resúmenes:  ${header.nSummaries ?? "?"}  ·  Embeddings: ${header.nEmbeddings ?? "?"}`);
    console.log(`  Clave:      ${header.publicKeyFingerprint}`);
    console.log(`  Salida:     ${out}  (${bytesWritten.toLocaleString()} bytes)`);
  }));

program
  .command("open")
  .description("descifra y valida un .fdb (firma + auth_tag); muestra el header sin escribir a disco")
  .argument("<fdb>", "archivo .fdb de entrada")
  .option("--passphrase <p>", "passphrase de cifrado (o env FRED_FDB_PASSPHRASE)")
  .action((fdb, opts) => run(async () => {
    const passphrase = resolvePassphrase(opts.passphrase);
    const { header, data } = openFdb(fdb, passphrase);
    console.log(`${bold("OK")}: firma y cifrado verificados; ${data.length.toLocaleString()} bytes descifrados en memoria.`);
    console.log(`  Repo:       ${header.repoName || "(sin meta)"}`);
    console.log(`  Schema:     v${header.schemaVersion}`);
    console.log(`  Generado:   ${header.generatedAt.toISOString()}`);
    console.log(`  Resúmenes:  ${header.nSummaries ?? "?"}  ·  Embeddings: ${header.nEmbeddings ?? "?"}`);
    console.log(dim("  (los datos descifrados solo viven en memoria; no se escriben a disco)"));
  }));

program
  .command("serve")
  .option("--db <path>", "archivo SQLite", "code.db")
  .option("--port <n>", "puerto HTTP", "3000")
  .option("--model <id>", "modelo de Claude", "claude-opus-4-8")
  .action((opts) => run(async () => {
    serve({ dbPath: opts.db, port: Number(opts.port), model: opts.model });
  }));

program
  .command("view")
  .description("abre un visor web de solo lectura para inspeccionar un .fdb (datos solo en memoria)")
  .argument("<fdb>", "archivo .fdb de entrada")
  .option("--passphrase <p>", "passphrase de cifrado (o env FRED_FDB_PASSPHRASE)")
  .option("--port <n>", "puerto HTTP", "4000")
  .option("--no-open", "no abrir el navegador automáticamente")
  .action((fdb, opts) => run(async () => {
    const passphrase = resolvePassphrase(opts.passphrase);
    viewer({ fdbPath: fdb, passphrase, port: Number(opts.port), open: opts.open });
  }));

program.parse();
