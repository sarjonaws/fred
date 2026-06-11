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
import { DatabaseSync } from "node:sqlite";
import { analyze } from "./analyzer.js";
import { readMeta } from "./db.js";
import { summarize } from "./summarize.js";
import { embedSummaries } from "./embed.js";
import { RagAgent, formatUsage } from "./rag.js";
import { serve } from "./server.js";
import { prepareSession } from "./setup.js";

const program = new Command();
program.name("fred").description("Analizador estructural de repos TypeScript (Fase 1 del MVP)");

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
  .option("--db <path>", "archivo SQLite", "code.db")
  .option("--model <id>", "modelo de Claude", "claude-opus-4-8")
  .action((question, opts) => run(async () => {
    const dbPath = await prepareSession({ dbPath: opts.db, model: opts.model });
    const agent = new RagAgent({ dbPath, model: opts.model });
    const result = await agent.ask(question, [], {
      onTool: (name, input) => console.log(dim(`  → ${name} ${JSON.stringify(input)}`)),
      onText: (delta) => process.stdout.write(delta),
    });
    agent.close();
    console.log(`\n\n${dim("─".repeat(60))}\n${dim(formatUsage(result.usage))}`);
  }));

program
  .command("chat")
  .description("sesión interactiva de chat sobre el repo analizado (multi-turno, con streaming)")
  .option("--db <path>", "archivo SQLite", "code.db")
  .option("--model <id>", "modelo de Claude", "claude-opus-4-8")
  .action((opts) => run(async () => {
    const dbPath = await prepareSession({ dbPath: opts.db, model: opts.model });
    const { createInterface } = await import("node:readline");
    const agent = new RagAgent({ dbPath, model: opts.model });
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
  .option("--db <path>", "archivo SQLite", "code.db")
  .option("--model <id>", "modelo de Claude", "claude-opus-4-8")
  .action((opts) => run(async () => {
    const dbPath = await prepareSession({ dbPath: opts.db, model: opts.model });
    // Import dinámico: no cargar React/Ink para los demás comandos
    const { runTui } = await import("./tui.js");
    runTui({ dbPath, model: opts.model });
  }));

program
  .command("serve")
  .option("--db <path>", "archivo SQLite", "code.db")
  .option("--port <n>", "puerto HTTP", "3000")
  .option("--model <id>", "modelo de Claude", "claude-opus-4-8")
  .action((opts) => run(async () => {
    serve({ dbPath: opts.db, port: Number(opts.port), model: opts.model });
  }));

program.parse();
