/**
 * Fase 2 (paso final): embeddings de los resúmenes — no del código crudo
 * (decisión de diseño #2). Usa Voyage AI (proveedor de embeddings recomendado
 * por Anthropic) vía fetch nativo, sin dependencias extra.
 * Los vectores se guardan como Float32 little-endian en SQLite, listos para
 * la búsqueda por similitud coseno de la Fase 3.
 */
import { createHash } from "node:crypto";
import { CodeDB, SummaryRow } from "./db.js";

export interface EmbedOptions {
  dbPath: string;
  model?: string;
  batchSize?: number;
  force?: boolean;
}

export interface EmbedStats {
  embedded: number;
  unchanged: number;
}

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-3.5";
const DEFAULT_BATCH = 64;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Llama a la API de Voyage con reintentos y backoff exponencial.
 * Las cuentas sin método de pago están limitadas a 3 RPM / 10K TPM, así que
 * respetamos el header Retry-After y esperamos hasta 60s entre reintentos.
 * input_type: "document" al indexar resúmenes, "query" al embeber preguntas (Fase 3).
 */
export async function voyageEmbed(
  texts: string[],
  model: string,
  apiKey: string,
  inputType: "document" | "query" = "document"
): Promise<{ vectors: number[][]; tokens: number }> {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ input: texts, model, input_type: inputType }),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        data: { index: number; embedding: number[] }[];
        usage?: { total_tokens?: number };
      };
      return {
        vectors: json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
        tokens: json.usage?.total_tokens ?? 0,
      };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 8) {
      throw new Error(`Voyage API respondió ${res.status}: ${await res.text()}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : delay;
    if (res.status === 429) console.log(`  límite de tasa de Voyage: esperando ${Math.round(waitMs / 1000)}s...`);
    await new Promise((r) => setTimeout(r, waitMs));
    delay = Math.min(delay * 2, 60_000);
  }
}

export async function embedSummaries(opts: EmbedOptions): Promise<EmbedStats> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("Falta VOYAGE_API_KEY en el entorno (https://www.voyageai.com).");

  const db = new CodeDB(opts.dbPath);
  const model = opts.model ?? DEFAULT_MODEL;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const stats: EmbedStats = { embedded: 0, unchanged: 0 };

  const summaries = db.db.prepare(`SELECT * FROM summaries ORDER BY id`).all() as unknown as SummaryRow[];
  const pending = summaries.filter((s) => {
    const hash = sha256(s.text);
    if (opts.force) return true;
    const existing = db.db
      .prepare(`SELECT body_hash, model FROM embeddings WHERE summary_id = ?`)
      .get(s.id) as { body_hash: string; model: string } | undefined;
    if (existing && existing.body_hash === hash && existing.model === model) {
      stats.unchanged++;
      return false;
    }
    return true;
  });

  const upsert = db.db.prepare(`
    INSERT INTO embeddings (summary_id, body_hash, vector, dims, model) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(summary_id) DO UPDATE SET body_hash = excluded.body_hash, vector = excluded.vector,
                                          dims = excluded.dims, model = excluded.model
  `);

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const { vectors } = await voyageEmbed(batch.map((s) => s.text), model, apiKey);
    for (let j = 0; j < batch.length; j++) {
      const buf = Buffer.from(new Float32Array(vectors[j]).buffer);
      upsert.run(batch[j].id, sha256(batch[j].text), buf, vectors[j].length, model);
      stats.embedded++;
    }
    console.log(`  ${Math.min(i + batchSize, pending.length)}/${pending.length} embeddings`);
  }

  db.close();
  return stats;
}
