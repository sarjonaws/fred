/**
 * Capa de persistencia: SQLite nativo de Node (node:sqlite).
 * Guarda el "esqueleto estructural" del repo: archivos, símbolos,
 * llamadas entre símbolos e imports (Fase 1, determinístico) y la
 * elevación semántica: resúmenes jerárquicos y embeddings (Fase 2).
 */
import { DatabaseSync } from "node:sqlite";

export interface FileRow {
  id: number;
  path: string;
  loc: number;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string; // function | method | class | interface | type | enum | arrow
  parent: string | null; // clase contenedora para métodos
  start_line: number;
  end_line: number;
  signature: string | null;
  doc: string | null; // JSDoc — materia prima para la Fase 2 (resúmenes con LLM)
  exported: number;
}

export interface SummaryRow {
  id: number;
  symbol_id: number | null; // nivel function
  file_id: number | null;   // nivel module
  domain: string | null;    // nivel domain (carpeta)
  level: string;            // function | module | domain
  body_hash: string;        // sha256 del material resumido — control de idempotencia/costos
  text: string;
  model: string;
  created_at: string;
}

export class CodeDB {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS files (
        id   INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        loc  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id         INTEGER PRIMARY KEY,
        file_id    INTEGER NOT NULL REFERENCES files(id),
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL,
        parent     TEXT,
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        signature  TEXT,
        doc        TEXT,
        exported   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS calls (
        caller_id   INTEGER NOT NULL REFERENCES symbols(id),
        callee_id   INTEGER,            -- NULL si no se pudo resolver (librería externa, etc.)
        callee_name TEXT NOT NULL,      -- siempre guardamos el nombre textual
        line        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS imports (
        file_id INTEGER NOT NULL REFERENCES files(id),
        module  TEXT NOT NULL,          -- de dónde se importa
        named   TEXT                    -- qué se importa
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id);
      CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_id);

      -- Fase 2: resúmenes jerárquicos (function -> module -> domain).
      -- Exactamente una de symbol_id / file_id / domain está poblada según el nivel.
      CREATE TABLE IF NOT EXISTS summaries (
        id         INTEGER PRIMARY KEY,
        symbol_id  INTEGER REFERENCES symbols(id),
        file_id    INTEGER REFERENCES files(id),
        domain     TEXT,
        level      TEXT NOT NULL,
        body_hash  TEXT NOT NULL,
        text       TEXT NOT NULL,
        model      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_symbol ON summaries(level, symbol_id) WHERE symbol_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_file   ON summaries(level, file_id)   WHERE file_id   IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_domain ON summaries(level, domain)    WHERE domain    IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_summaries_hash ON summaries(body_hash);

      -- Fase 2: embeddings de los resúmenes (no del código crudo — decisión de diseño #2).
      CREATE TABLE IF NOT EXISTS embeddings (
        summary_id INTEGER PRIMARY KEY REFERENCES summaries(id),
        body_hash  TEXT NOT NULL,    -- sha256 del texto embebido (idempotencia)
        vector     BLOB NOT NULL,    -- Float32 little-endian
        dims       INTEGER NOT NULL,
        model      TEXT NOT NULL
      );
    `);
  }

  reset() {
    this.db.exec(`DELETE FROM calls; DELETE FROM imports; DELETE FROM symbols; DELETE FROM files;`);
  }

  insertFile(path: string, loc: number): number {
    const r = this.db
      .prepare(`INSERT INTO files (path, loc) VALUES (?, ?)`)
      .run(path, loc);
    return Number(r.lastInsertRowid);
  }

  insertSymbol(s: Omit<SymbolRow, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO symbols (file_id, name, kind, parent, start_line, end_line, signature, doc, exported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(s.file_id, s.name, s.kind, s.parent, s.start_line, s.end_line, s.signature, s.doc, s.exported);
    return Number(r.lastInsertRowid);
  }

  insertCall(callerId: number, calleeId: number | null, calleeName: string, line: number) {
    this.db
      .prepare(`INSERT INTO calls (caller_id, callee_id, callee_name, line) VALUES (?, ?, ?, ?)`)
      .run(callerId, calleeId, calleeName, line);
  }

  insertImport(fileId: number, module: string, named: string | null) {
    this.db
      .prepare(`INSERT INTO imports (file_id, module, named) VALUES (?, ?, ?)`)
      .run(fileId, module, named);
  }

  // ---- Fase 2: resúmenes ----------------------------------------------------

  /** Inserta o actualiza el resumen del nivel indicado, preservando el id existente. */
  upsertSummary(s: Omit<SummaryRow, "id" | "created_at">): number {
    const existing = this.db
      .prepare(
        `SELECT id FROM summaries
         WHERE level = ?
           AND (symbol_id IS ? AND file_id IS ? AND domain IS ?)`
      )
      .get(s.level, s.symbol_id, s.file_id, s.domain) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare(`UPDATE summaries SET body_hash = ?, text = ?, model = ?, created_at = datetime('now') WHERE id = ?`)
        .run(s.body_hash, s.text, s.model, existing.id);
      return existing.id;
    }
    const r = this.db
      .prepare(
        `INSERT INTO summaries (symbol_id, file_id, domain, level, body_hash, text, model)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(s.symbol_id, s.file_id, s.domain, s.level, s.body_hash, s.text, s.model);
    return Number(r.lastInsertRowid);
  }

  getSummary(level: string, symbolId: number | null, fileId: number | null, domain: string | null): SummaryRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM summaries
         WHERE level = ? AND (symbol_id IS ? AND file_id IS ? AND domain IS ?)`
      )
      .get(level, symbolId, fileId, domain) as SummaryRow | undefined;
  }

  /** Caché por contenido: si el cuerpo no cambió (aunque cambie el symbol_id tras re-analizar), reusamos el texto. */
  findSummaryByHash(level: string, hash: string): SummaryRow | undefined {
    return this.db
      .prepare(`SELECT * FROM summaries WHERE level = ? AND body_hash = ? LIMIT 1`)
      .get(level, hash) as SummaryRow | undefined;
  }

  /** Elimina resúmenes que ya no corresponden a símbolos/archivos vigentes y embeddings huérfanos. */
  pruneStaleSummaries(validDomains: string[]) {
    this.db.exec(`
      DELETE FROM summaries WHERE level = 'function' AND symbol_id NOT IN (SELECT id FROM symbols);
      DELETE FROM summaries WHERE level = 'module'   AND file_id   NOT IN (SELECT id FROM files);
    `);
    const placeholders = validDomains.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM summaries WHERE level = 'domain' AND domain NOT IN (${placeholders || "''"})`)
      .run(...validDomains);
    this.db.exec(`DELETE FROM embeddings WHERE summary_id NOT IN (SELECT id FROM summaries);`);
  }

  close() {
    this.db.close();
  }
}
