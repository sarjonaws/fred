/**
 * Fase 2 del MVP: elevación semántica.
 * Recorre el grafo de llamadas en orden topológico inverso (hojas primero) y
 * le pide a Claude un resumen de la REGLA DE NEGOCIO de cada función, usando
 * los resúmenes ya generados de sus callees como contexto. Después sube de
 * nivel: módulo (archivo) y dominio (carpeta), estilo RAPTOR bottom-up.
 *
 * Idempotencia: se hashea el cuerpo de cada función; si no cambió desde la
 * última corrida no se vuelve a resumir (control de costos).
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CodeDB, SummaryRow } from "./db.js";

export interface SummarizeOptions {
  repoPath: string;
  dbPath: string;
  model?: string;
  concurrency?: number;
  force?: boolean;   // re-resumir aunque el hash no haya cambiado
  dryRun?: boolean;  // mostrar el plan sin llamar a la API
}

export interface SummarizeStats {
  functions: { summarized: number; reusedFromCache: number; unchanged: number };
  modules: { summarized: number; unchanged: number };
  domains: { summarized: number; unchanged: number };
}

interface CallableSym {
  id: number;
  name: string;
  kind: string;
  parent: string | null;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc: string | null;
  file_id: number;
  path: string;
}

const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_BODY_CHARS = 8000; // las funciones gigantes se truncan: el inicio suele bastar para la regla

const SYSTEM_PROMPT = `Eres un analista que deduce reglas de negocio leyendo código TypeScript.
Tu salida alimenta una memoria consultable por arquitectos de software, así que describe QUÉ regla
de negocio implementa el código (condiciones, umbrales, montos, efectos para el negocio), no CÓMO
está escrito (nada de "itera un arreglo", "usa async/await", etc.).
Responde en español, únicamente con el resumen pedido, sin preámbulos ni formato markdown.`;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Ejecuta tareas con un límite de concurrencia (sin dependencias externas). */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Orden topológico inverso del grafo de llamadas: primero las funciones que no
 * llaman a nadie (hojas), después sus callers, en oleadas. Los ciclos (recursión
 * mutua) se agrupan en una oleada final — sus resúmenes simplemente no verán el
 * resumen del compañero de ciclo.
 */
function leavesFirstWaves(ids: number[], edges: Map<number, Set<number>>): number[][] {
  const remaining = new Set(ids);
  const waves: number[][] = [];
  while (remaining.size) {
    const wave = [...remaining].filter((id) => {
      const callees = edges.get(id);
      return !callees || [...callees].every((c) => !remaining.has(c));
    });
    if (!wave.length) {
      waves.push([...remaining]); // ciclo: procesarlos juntos
      break;
    }
    wave.forEach((id) => remaining.delete(id));
    waves.push(wave);
  }
  return waves;
}

export async function summarize(opts: SummarizeOptions): Promise<SummarizeStats> {
  const repo = path.resolve(opts.repoPath);
  if (!fs.existsSync(repo)) throw new Error(`No existe la ruta: ${repo}`);
  if (!opts.dryRun && !process.env.ANTHROPIC_API_KEY)
    throw new Error("Falta ANTHROPIC_API_KEY en el entorno (o usa --dry-run para ver el plan).");

  const db = new CodeDB(opts.dbPath);
  const model = opts.model ?? DEFAULT_MODEL;
  const concurrency = opts.concurrency ?? 4;
  const client = new Anthropic({ maxRetries: 5 }); // reintentos con backoff los maneja el SDK

  const stats: SummarizeStats = {
    functions: { summarized: 0, reusedFromCache: 0, unchanged: 0 },
    modules: { summarized: 0, unchanged: 0 },
    domains: { summarized: 0, unchanged: 0 },
  };

  // ---- Nivel function: símbolos invocables en orden hojas-primero ----------
  const callables = db.db.prepare(`
    SELECT s.id, s.name, s.kind, s.parent, s.start_line, s.end_line, s.signature, s.doc, s.file_id, f.path
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.kind IN ('function', 'method', 'arrow')
  `).all() as unknown as CallableSym[];
  const byId = new Map(callables.map((c) => [c.id, c]));

  const edges = new Map<number, Set<number>>(); // caller -> callees resueltos (solo invocables)
  const callRows = db.db.prepare(
    `SELECT caller_id, callee_id FROM calls WHERE callee_id IS NOT NULL`
  ).all() as { caller_id: number; callee_id: number }[];
  for (const { caller_id, callee_id } of callRows) {
    if (caller_id === callee_id || !byId.has(caller_id) || !byId.has(callee_id)) continue;
    if (!edges.has(caller_id)) edges.set(caller_id, new Set());
    edges.get(caller_id)!.add(callee_id);
  }

  const waves = leavesFirstWaves([...byId.keys()], edges);
  const fileCache = new Map<string, string[]>();
  const readBody = (sym: CallableSym): string => {
    const abs = path.join(repo, sym.path);
    if (!fileCache.has(abs)) fileCache.set(abs, fs.readFileSync(abs, "utf8").split(/\r?\n/));
    const body = fileCache.get(abs)!.slice(sym.start_line - 1, sym.end_line).join("\n");
    return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + "\n// [truncado]" : body;
  };

  const label = (s: CallableSym) => (s.parent ? `${s.parent}.${s.name}` : s.name);
  const summaryTexts = new Map<number, string>(); // symbol_id -> resumen (contexto para callers)

  const askClaude = async (prompt: string): Promise<string> => {
    const msg = await client.messages.create({
      model,
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });
    if (msg.stop_reason === "refusal") throw new Error("La API rechazó la petición (stop_reason: refusal).");
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new Error(`Respuesta vacía del modelo (stop_reason: ${msg.stop_reason}).`);
    return text;
  };

  const summarizeFunction = async (sym: CallableSym): Promise<void> => {
    const body = readBody(sym);
    const hash = sha256(`${body}\n${sym.signature ?? ""}\n${sym.doc ?? ""}`);

    if (!opts.force) {
      const current = db.getSummary("function", sym.id, null, null);
      if (current?.body_hash === hash) {
        summaryTexts.set(sym.id, current.text);
        stats.functions.unchanged++;
        if (opts.dryRun) console.log(`  = ${label(sym)} (sin cambios)`);
        return;
      }
      const cached = db.findSummaryByHash("function", hash);
      if (cached) {
        // Mismo cuerpo bajo otro symbol_id (re-análisis): reusar texto sin gastar tokens
        if (!opts.dryRun) db.upsertSummary({ symbol_id: sym.id, file_id: null, domain: null, level: "function", body_hash: hash, text: cached.text, model: cached.model });
        summaryTexts.set(sym.id, cached.text);
        stats.functions.reusedFromCache++;
        if (opts.dryRun) console.log(`  ~ ${label(sym)} (reusado de caché)`);
        return;
      }
    }

    if (opts.dryRun) {
      stats.functions.summarized++;
      summaryTexts.set(sym.id, "(pendiente)"); // para que el plan cuente también módulos y dominios
      console.log(`  + ${label(sym)} (se resumiría con ${model})`);
      return;
    }

    const calleeSummaries = [...(edges.get(sym.id) ?? [])]
      .map((id) => (summaryTexts.has(id) ? `- ${label(byId.get(id)!)}: ${summaryTexts.get(id)}` : null))
      .filter(Boolean)
      .join("\n");

    const prompt = [
      `Resume en 1 a 3 frases la regla de negocio que implementa esta función.`,
      ``,
      `Archivo: ${sym.path}`,
      `Símbolo: ${label(sym)} (${sym.kind})${sym.signature ? ` — firma: ${sym.signature}` : ""}`,
      sym.doc ? `JSDoc:\n${sym.doc}` : null,
      calleeSummaries ? `Resúmenes de las funciones que llama:\n${calleeSummaries}` : null,
      ``,
      "```ts",
      body,
      "```",
    ].filter((l) => l !== null).join("\n");

    const text = await askClaude(prompt);
    db.upsertSummary({ symbol_id: sym.id, file_id: null, domain: null, level: "function", body_hash: hash, text, model });
    summaryTexts.set(sym.id, text);
    stats.functions.summarized++;
    console.log(`  ✓ ${label(sym)}`);
  };

  console.log(`Nivel función: ${callables.length} símbolos en ${waves.length} oleadas (hojas primero)`);
  for (const wave of waves) {
    // Dentro de una oleada no hay dependencias entre sí: procesar en paralelo acotado
    await mapLimited(wave, concurrency, (id) => summarizeFunction(byId.get(id)!));
  }

  // ---- Nivel module: un resumen por archivo, a partir de sus símbolos ------
  const files = db.db.prepare(`SELECT id, path FROM files ORDER BY path`).all() as { id: number; path: string }[];
  const moduleTexts = new Map<number, string>(); // file_id -> resumen

  const modulesWithSymbols = files
    .map((f) => {
      const children = callables
        .filter((c) => c.file_id === f.id && summaryTexts.has(c.id))
        .map((c) => `- ${label(c)}: ${summaryTexts.get(c.id)}`);
      return { ...f, children };
    })
    .filter((f) => f.children.length > 0);

  console.log(`Nivel módulo: ${modulesWithSymbols.length} archivos`);
  await mapLimited(modulesWithSymbols, concurrency, async (f) => {
    const material = f.children.join("\n");
    const hash = sha256(material);
    const current = db.getSummary("module", null, f.id, null);
    if (!opts.force && current?.body_hash === hash) {
      moduleTexts.set(f.id, current.text);
      stats.modules.unchanged++;
      return;
    }
    if (opts.dryRun) {
      stats.modules.summarized++;
      moduleTexts.set(f.id, "(pendiente)");
      console.log(`  + ${f.path}`);
      return;
    }
    const text = await askClaude(
      `Resume en 2 a 3 frases el propósito de negocio del módulo "${f.path}", a partir de los resúmenes de sus funciones:\n${material}`
    );
    db.upsertSummary({ symbol_id: null, file_id: f.id, domain: null, level: "module", body_hash: hash, text, model });
    moduleTexts.set(f.id, text);
    stats.modules.summarized++;
    console.log(`  ✓ ${f.path}`);
  });

  // ---- Nivel domain: un resumen por carpeta, a partir de sus módulos -------
  const domains = new Map<string, { path: string; text: string }[]>();
  for (const f of modulesWithSymbols) {
    if (!moduleTexts.has(f.id)) continue;
    const dir = path.dirname(f.path).replace(/\\/g, "/");
    if (!domains.has(dir)) domains.set(dir, []);
    domains.get(dir)!.push({ path: f.path, text: moduleTexts.get(f.id)! });
  }

  console.log(`Nivel dominio: ${domains.size} carpetas`);
  await mapLimited([...domains.entries()], concurrency, async ([dir, mods]) => {
    const material = mods.map((m) => `- ${m.path}: ${m.text}`).join("\n");
    const hash = sha256(material);
    const current = db.getSummary("domain", null, null, dir);
    if (!opts.force && current?.body_hash === hash) {
      stats.domains.unchanged++;
      return;
    }
    if (opts.dryRun) {
      stats.domains.summarized++;
      console.log(`  + ${dir}`);
      return;
    }
    const text = await askClaude(
      `Resume en 2 a 4 frases qué dominio de negocio cubre la carpeta "${dir}", a partir de los resúmenes de sus módulos:\n${material}`
    );
    db.upsertSummary({ symbol_id: null, file_id: null, domain: dir, level: "domain", body_hash: hash, text, model });
    stats.domains.summarized++;
    console.log(`  ✓ ${dir}`);
  });

  if (!opts.dryRun) db.pruneStaleSummaries([...domains.keys()]);
  db.close();
  return stats;
}
