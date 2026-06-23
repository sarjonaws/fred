/**
 * Superficie de librería de fred: lo que consume fred-hub (y cualquier otro
 * servicio) para federar bases .db y reutilizar el agente RAG sin pasar por la CLI.
 */
export { RagAgent, formatUsage } from "./rag.js";
export type { RagOptions, RagSource, UsageReport, AskResult, AskCallbacks } from "./rag.js";
export { CodeDB, SCHEMA_VERSION, readMeta } from "./db.js";
export type { FileRow, SymbolRow, SummaryRow } from "./db.js";
export { gitInfo, repoNameFromRemote } from "./git.js";
export type { GitInfo } from "./git.js";
export { analyze } from "./analyzer.js";
export type { AnalyzeOptions, AnalyzeStats } from "./analyzer.js";
export { summarize } from "./summarize.js";
export { embedSummaries, voyageEmbed } from "./embed.js";
export { sealDb, openFdb, openFdbToMemory } from "./seal.js";
export type { SealResult, OpenResult } from "./seal.js";
export { viewer } from "./viewer.js";
export type { ViewerOptions } from "./viewer.js";
export {
  encodeFdbHeader,
  decodeFdbHeader,
  isFdb,
  FdbFormatError,
  FDB_MAGIC,
  FDB_HEADER_VERSION,
} from "./fdb.js";
export type { FdbHeader } from "./fdb.js";
