/**
 * Fase 3 del MVP: capa de consulta RAG.
 * Un agente con Claude que responde preguntas de arquitecto sobre el repo
 * analizado, con dos herramientas:
 *   1. search_summaries — búsqueda vectorial (coseno) sobre los resúmenes de
 *      reglas de negocio de la Fase 2, embebiendo la pregunta con Voyage.
 *   2. query_graph — SQL de SOLO LECTURA sobre el grafo estructural de la Fase 1.
 * Las respuestas citan siempre archivo:línea.
 */
import Anthropic from "@anthropic-ai/sdk";
import { DatabaseSync } from "node:sqlite";
import { voyageEmbed } from "./embed.js";

export interface RagOptions {
  dbPath: string;
  model?: string;
}

export interface UsageReport {
  model: string;
  claudeCalls: number;
  inputTokens: number;        // sin caché, a precio completo
  outputTokens: number;
  cacheWriteTokens: number;   // escritura de caché (1.25x el precio de entrada)
  cacheReadTokens: number;    // lectura de caché (0.1x el precio de entrada)
  voyageCalls: number;
  voyageTokens: number;
  estimatedCostUSD: number | null; // null si el modelo no está en la tabla de precios; solo Claude
}

export interface AskResult {
  answer: string;
  history: Anthropic.MessageParam[]; // conversación completa, lista para el siguiente turno
  usage: UsageReport;                // uso y costo de ESTE turno
}

export interface AskCallbacks {
  onTool?: (name: string, input: unknown) => void;
  onText?: (delta: string) => void; // streaming del texto a medida que se genera
}

const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_TURNS = 15;      // tope de iteraciones del loop agéntico
const MAX_SQL_ROWS = 50;   // tope de filas devueltas por query_graph
// USD por millón de tokens (entrada/salida). El costo de Voyage no se estima
// (tarifa distinta y despreciable); se reportan sus tokens y llamadas.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function estimateCost(u: Omit<UsageReport, "estimatedCostUSD">): number | null {
  const p = PRICING[u.model];
  if (!p) return null;
  return (
    (u.inputTokens * p.in +
      u.cacheWriteTokens * p.in * 1.25 +
      u.cacheReadTokens * p.in * 0.1 +
      u.outputTokens * p.out) / 1_000_000
  );
}

/** Formato legible del reporte de uso, para el CLI y los logs del servidor. */
export function formatUsage(u: UsageReport): string {
  const fmt = (n: number) => n.toLocaleString("es-MX");
  const claude = `${u.claudeCalls} llamada${u.claudeCalls === 1 ? "" : "s"} a Claude (${u.model}): ${fmt(u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens)} tokens de entrada, ${fmt(u.outputTokens)} de salida`;
  const voyage = u.voyageCalls
    ? ` · ${u.voyageCalls} llamada${u.voyageCalls === 1 ? "" : "s"} a Voyage: ${fmt(u.voyageTokens)} tokens`
    : "";
  const cost = u.estimatedCostUSD !== null
    ? `\nCosto estimado: $${u.estimatedCostUSD.toFixed(4)} USD (solo Claude)`
    : "";
  return `${claude}${voyage}${cost}`;
}

const SYSTEM_PROMPT = `Eres el asistente de consulta de fred: respondes preguntas de arquitectos
de software sobre un repositorio ya analizado (estructura + reglas de negocio deducidas).

Tienes dos herramientas:
- search_summaries: búsqueda semántica sobre resúmenes de reglas de negocio (niveles function/module/domain).
  Úsala para preguntas de negocio: "¿dónde está la regla de descuentos?", "¿qué hace el dominio de login?".
- query_graph: SQL de solo lectura sobre el grafo estructural. Úsala para preguntas estructurales:
  quién llama a qué, radio de impacto, dependencias, firmas. Esquema:
    files(id, path, loc)
    symbols(id, file_id, name, kind, parent, start_line, end_line, signature, doc, exported)
      -- kind: function | method | class | interface | type | enum | arrow; parent: clase del método
    calls(caller_id, callee_id, callee_name, line)  -- callee_id NULL = llamada externa no resuelta
    imports(file_id, module, named)
    summaries(id, symbol_id, file_id, domain, level, body_hash, text, model, created_at)
      -- level: function (symbol_id) | module (file_id) | domain (carpeta)

Reglas:
- SIEMPRE cita la ubicación como archivo:línea para cada afirmación sobre el código.
- Combina ambas herramientas cuando ayude (p. ej. encontrar la regla con search_summaries y
  luego el radio de impacto con query_graph sobre calls).
- Si no encuentras evidencia en el repo, dilo claramente; no inventes reglas.
- Responde en el idioma de la pregunta.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_summaries",
    description:
      "Búsqueda semántica sobre los resúmenes de reglas de negocio del repo. " +
      "Úsala cuando la pregunta sea sobre QUÉ hace el sistema o DÓNDE vive una regla de negocio. " +
      "Devuelve los resúmenes más similares a la consulta, con su ubicación (archivo:línea).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "La consulta en lenguaje natural" },
        top_k: { type: "integer", description: "Cuántos resultados devolver (default 8)" },
        level: {
          type: "string",
          enum: ["function", "module", "domain"],
          description: "Filtrar por nivel jerárquico (opcional)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "query_graph",
    description:
      "Ejecuta una consulta SQL de SOLO LECTURA (un solo SELECT) sobre el grafo estructural del repo. " +
      "Úsala para preguntas estructurales: quién llama a una función, qué llama una función, " +
      "radio de impacto, dependencias entre módulos, firmas y documentación.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Un único statement SELECT" },
      },
      required: ["sql"],
    },
  },
];

interface EmbeddingRow {
  summary_id: number;
  vector: Uint8Array;
  dims: number;
  model: string;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export class RagAgent {
  private db: DatabaseSync;
  private client: Anthropic;
  private model: string;

  constructor(opts: RagOptions) {
    this.db = new DatabaseSync(opts.dbPath, { readOnly: true }); // solo lectura: la garantía real de query_graph
    this.client = new Anthropic({ maxRetries: 5 });
    this.model = opts.model ?? DEFAULT_MODEL;

    const n = (this.db.prepare(`SELECT COUNT(*) c FROM summaries`).get() as any).c;
    if (!n) throw new Error("La base no tiene resúmenes. Corre primero: summarize <repo> --db <db>");
  }

  private async searchSummaries(query: string, topK = 8, level?: string, usage?: UsageReport): Promise<string> {
    if (!process.env.VOYAGE_API_KEY)
      return "Error: falta VOYAGE_API_KEY para la búsqueda vectorial. Usa query_graph con LIKE sobre summaries.text como alternativa.";

    const rows = this.db.prepare(`SELECT summary_id, vector, dims, model FROM embeddings`).all() as unknown as EmbeddingRow[];
    if (!rows.length)
      return "Error: no hay embeddings en la base. Corre `embed` primero, o usa query_graph con LIKE sobre summaries.text.";

    const { vectors, tokens } = await voyageEmbed([query], rows[0].model, process.env.VOYAGE_API_KEY, "query");
    if (usage) {
      usage.voyageCalls++;
      usage.voyageTokens += tokens;
    }
    const q = new Float32Array(vectors[0]);

    const scored = rows
      .map((r) => ({
        id: r.summary_id,
        score: cosine(q, new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dims)),
      }))
      .sort((a, b) => b.score - a.score);

    const detail = this.db.prepare(`
      SELECT su.level, su.text, su.domain, s.name, s.parent, s.start_line, s.end_line,
             sf.path AS sym_path, f.path AS file_path
      FROM summaries su
      LEFT JOIN symbols s ON s.id = su.symbol_id
      LEFT JOIN files sf ON sf.id = s.file_id
      LEFT JOIN files f ON f.id = su.file_id
      WHERE su.id = ?
    `);

    const results: string[] = [];
    for (const { id, score } of scored) {
      if (results.length >= topK) break;
      const r = detail.get(id) as any;
      if (!r || (level && r.level !== level)) continue;
      const where =
        r.level === "function" ? `${r.parent ? r.parent + "." : ""}${r.name} — ${r.sym_path}:${r.start_line}-${r.end_line}`
        : r.level === "module" ? `módulo ${r.file_path}`
        : `dominio ${r.domain}/`;
      results.push(`[${r.level}] (similitud ${score.toFixed(3)}) ${where}\n${r.text}`);
    }
    return results.length ? results.join("\n\n") : "Sin resultados para esa consulta.";
  }

  private queryGraph(sql: string): string {
    const clean = sql.trim().replace(/;\s*$/, "");
    if (!/^select\b/i.test(clean) || clean.includes(";"))
      return "Error: solo se permite un único statement SELECT.";
    try {
      const rows = this.db.prepare(clean).all() as Record<string, unknown>[];
      if (!rows.length) return "0 filas.";
      const shown = rows.slice(0, MAX_SQL_ROWS);
      const out = JSON.stringify(shown, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 1);
      return rows.length > MAX_SQL_ROWS ? `${out}\n(${rows.length} filas, mostrando ${MAX_SQL_ROWS})` : out;
    } catch (e) {
      return `Error de SQL: ${e instanceof Error ? e.message : e}`;
    }
  }

  /** Un turno de conversación. `history` debe venir de un AskResult previo (o vacío). */
  async ask(
    question: string,
    history: Anthropic.MessageParam[] = [],
    callbacks: AskCallbacks = {}
  ): Promise<AskResult> {
    const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: question }];
    const usage: UsageReport = {
      model: this.model,
      claudeCalls: 0, inputTokens: 0, outputTokens: 0,
      cacheWriteTokens: 0, cacheReadTokens: 0,
      voyageCalls: 0, voyageTokens: 0,
      estimatedCostUSD: null,
    };

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
      if (callbacks.onText) stream.on("text", callbacks.onText);
      const response = await stream.finalMessage();

      usage.claudeCalls++;
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "pause_turn") continue;

      if (response.stop_reason !== "tool_use") {
        const answer = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        usage.estimatedCostUSD = estimateCost(usage);
        return { answer, history: messages, usage };
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        callbacks.onTool?.(block.name, block.input);
        let result: string;
        try {
          if (block.name === "search_summaries") {
            const { query, top_k, level } = block.input as { query: string; top_k?: number; level?: string };
            result = await this.searchSummaries(query, top_k, level, usage);
          } else if (block.name === "query_graph") {
            result = this.queryGraph((block.input as { sql: string }).sql);
          } else {
            result = `Herramienta desconocida: ${block.name}`;
          }
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : e}`;
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      messages.push({ role: "user", content: toolResults });
    }
    throw new Error(`El agente no concluyó en ${MAX_TURNS} iteraciones.`);
  }

  close() {
    this.db.close();
  }
}
