/**
 * Visor web de solo lectura para artefactos `.fdb`.
 *
 * Es el equivalente a un cliente de SQLite (DB Browser, DBeaver) pero respetando
 * la regla dura del formato: los datos descifrados NUNCA tocan disco. El `.fdb` se
 * abre con `openFdbToMemory` (verifica firma HMAC + auth_tag GCM y carga el `.db`
 * en una base `:memory:` vía deserialize); el servidor sirve una SPA mínima que
 * lista tablas, pagina filas y ejecuta SELECTs ad-hoc contra esa base en memoria.
 *
 * Pensado para uso LOCAL: el contenido descifrado vive en la RAM de este proceso,
 * así que no expongas el puerto a la red.
 */
import express from "express";
import { exec } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openFdbToMemory } from "./seal.js";
import { readMeta } from "./db.js";

export interface ViewerOptions {
  fdbPath: string;
  passphrase: string;
  port?: number;
  /** Intentar abrir el navegador automáticamente (default: true). */
  open?: boolean;
}

// Identificador SQLite válido (nombres de tabla). Evita inyección al interpolar.
const IDENT = /^[A-Za-z0-9_]+$/;

/**
 * Hace serializables a JSON los valores que devuelve node:sqlite: los BLOB (p. ej.
 * los vectores de embeddings, 4KB cada uno) se colapsan a un placeholder en vez de
 * volcarse enteros, y los BigInt se normalizan a number/string.
 */
function jsonSafe(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof Uint8Array) {
        out[k] = `\u27e8BLOB ${v.length} B\u27e9`;
      } else if (typeof v === "bigint") {
        out[k] = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
      } else {
        out[k] = v;
      }
    }
    return out;
  });
}

/** Lista las tablas de usuario (excluye las internas de SQLite). */
function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* best-effort: si falla, el usuario abre la URL a mano */
  });
}

export function viewer(opts: ViewerOptions): void {
  const db = openFdbToMemory(opts.fdbPath, opts.passphrase); // descifrado solo en RAM
  const meta = readMeta(db);
  const app = express();
  app.use(express.json());

  // Metadatos del artefacto + lista de tablas para la cabecera/sidebar.
  app.get("/api/meta", (_req, res) => {
    const tables = listTables(db).map((name) => ({
      name,
      rows: (db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get() as { c: number }).c,
    }));
    res.json({ file: opts.fdbPath, meta, tables });
  });

  // Esquema de una tabla (PRAGMA table_info).
  app.get("/api/schema/:name", (req, res) => {
    const name = req.params.name;
    if (!IDENT.test(name) || !listTables(db).includes(name))
      return res.status(404).json({ error: "tabla desconocida" });
    res.json(jsonSafe(db.prepare(`PRAGMA table_info("${name}")`).all() as Record<string, unknown>[]));
  });

  // Filas paginadas de una tabla.
  app.get("/api/table/:name", (req, res) => {
    const name = req.params.name;
    if (!IDENT.test(name) || !listTables(db).includes(name))
      return res.status(404).json({ error: "tabla desconocida" });
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const total = (db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get() as { c: number }).c;
    const rows = db.prepare(`SELECT * FROM "${name}" LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[];
    res.json({ total, limit, offset, rows: jsonSafe(rows) });
  });

  // Editor SQL: mismo guardrail que query_graph en rag.ts (un único SELECT).
  app.post("/api/query", (req, res) => {
    const sql = String(req.body?.sql ?? "").trim().replace(/;\s*$/, "");
    if (!/^select\b/i.test(sql) || sql.includes(";"))
      return res.status(400).json({ error: "Solo se permite un único statement SELECT." });
    try {
      const rows = db.prepare(sql).all() as Record<string, unknown>[];
      res.json({ rows: jsonSafe(rows) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/", (_req, res) => {
    res.type("html").send(PAGE);
  });

  const port = opts.port ?? 4000;
  app.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`Visor .fdb en ${url}`);
    console.log(`  Archivo: ${opts.fdbPath}`);
    console.log(`  Repo:    ${meta.repo_name ?? "(sin meta)"}`);
    console.log("  (datos descifrados solo en memoria; no expongas este puerto a la red)");
    if (opts.open !== false) openBrowser(url);
  });
}

// SPA embebida (sin build de frontend): se sirve como string para sobrevivir a `tsc`
// sin un paso de copia de assets. Vanilla JS, estilo cliente de SQLite.
const PAGE = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>fred · visor .fdb</title>
<style>
  :root { --bg:#0f1117; --panel:#161922; --border:#262b38; --fg:#e6e8ee; --muted:#8b93a7; --accent:#6ea8fe; --accent2:#1f6feb; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif; color:var(--fg); background:var(--bg); height:100vh; display:flex; flex-direction:column; }
  header { padding:10px 16px; border-bottom:1px solid var(--border); background:var(--panel); display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; }
  header h1 { font-size:14px; margin:0; font-weight:600; }
  header .meta { color:var(--muted); font-size:12px; display:flex; gap:14px; flex-wrap:wrap; }
  header .meta b { color:var(--fg); font-weight:500; }
  main { flex:1; display:flex; min-height:0; }
  aside { width:240px; border-right:1px solid var(--border); background:var(--panel); overflow:auto; flex-shrink:0; }
  aside .group { padding:8px 12px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
  aside button { display:flex; justify-content:space-between; gap:8px; width:100%; text-align:left; background:none; border:none; color:var(--fg); padding:7px 14px; cursor:pointer; font:inherit; }
  aside button:hover { background:#1d2130; }
  aside button.active { background:var(--accent2); color:#fff; }
  aside button .count { color:var(--muted); font-size:12px; }
  aside button.active .count { color:#cfe0ff; }
  section { flex:1; display:flex; flex-direction:column; min-width:0; }
  .tabs { display:flex; gap:4px; padding:8px 12px 0; border-bottom:1px solid var(--border); background:var(--panel); }
  .tabs button { background:none; border:1px solid transparent; border-bottom:none; color:var(--muted); padding:7px 14px; cursor:pointer; font:inherit; border-radius:6px 6px 0 0; }
  .tabs button.active { color:var(--fg); background:var(--bg); border-color:var(--border); }
  .pane { flex:1; min-height:0; display:none; flex-direction:column; }
  .pane.active { display:flex; }
  .toolbar { padding:8px 12px; display:flex; gap:8px; align-items:center; color:var(--muted); font-size:12px; }
  .toolbar button { background:#222838; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:5px 10px; cursor:pointer; font:inherit; }
  .toolbar button:disabled { opacity:.4; cursor:default; }
  .grid { flex:1; overflow:auto; }
  table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
  th, td { border:1px solid var(--border); padding:5px 9px; text-align:left; vertical-align:top; white-space:pre-wrap; max-width:460px; overflow:hidden; }
  th { position:sticky; top:0; background:var(--panel); z-index:1; font-weight:600; }
  tbody tr:nth-child(odd) { background:#12151d; }
  td.null { color:var(--muted); font-style:italic; }
  #sql { width:100%; height:120px; resize:vertical; background:#0b0d13; color:var(--fg); border:1px solid var(--border); border-radius:8px; padding:10px 12px; font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
  .runbar { padding:10px 12px; display:flex; gap:10px; align-items:center; }
  .runbar button { background:var(--accent2); color:#fff; border:none; border-radius:6px; padding:7px 16px; cursor:pointer; font:inherit; }
  .err { color:#ff7b72; padding:0 12px 8px; white-space:pre-wrap; }
  .empty { color:var(--muted); padding:24px; }
</style>
</head>
<body>
<header>
  <h1>fred · visor .fdb</h1>
  <div class="meta" id="meta"></div>
</header>
<main>
  <aside>
    <div class="group">Tablas</div>
    <div id="tables"></div>
  </aside>
  <section>
    <div class="tabs">
      <button data-tab="data" class="active">Datos</button>
      <button data-tab="sql">SQL</button>
    </div>
    <div class="pane active" id="pane-data">
      <div class="toolbar">
        <span id="tableName">Selecciona una tabla</span>
        <span style="flex:1"></span>
        <button id="prev" disabled>&larr;</button>
        <span id="pageInfo"></span>
        <button id="next" disabled>&rarr;</button>
      </div>
      <div class="grid" id="dataGrid"></div>
    </div>
    <div class="pane" id="pane-sql">
      <div class="runbar">
        <span style="color:var(--muted);font-size:12px">Solo un SELECT · Ctrl/Cmd+Enter para ejecutar</span>
        <span style="flex:1"></span>
        <button id="run">Ejecutar</button>
      </div>
      <div style="padding:0 12px"><textarea id="sql" placeholder="SELECT * FROM summaries LIMIT 20"></textarea></div>
      <div class="err" id="sqlErr"></div>
      <div class="grid" id="sqlGrid"></div>
    </div>
  </section>
</main>
<script>
const PAGE_SIZE = 100;
let current = null, offset = 0, total = 0;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" }[c]));

function renderGrid(el, rows) {
  if (!rows || !rows.length) { el.innerHTML = '<div class="empty">Sin filas.</div>'; return; }
  const cols = Object.keys(rows[0]);
  let html = "<table><thead><tr>" + cols.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>";
  for (const r of rows) {
    html += "<tr>" + cols.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return '<td class="null">NULL</td>';
      return "<td>" + esc(v) + "</td>";
    }).join("") + "</tr>";
  }
  el.innerHTML = html + "</tbody></table>";
}

async function loadMeta() {
  const d = await fetch("/api/meta").then((r) => r.json());
  const m = d.meta || {};
  const bits = [];
  if (m.repo_name) bits.push("<b>" + esc(m.repo_name) + "</b>");
  if (m.schema_version) bits.push("schema v" + esc(m.schema_version));
  if (m.commit_sha) bits.push("@ " + esc(String(m.commit_sha).slice(0, 8)));
  if (m.generated_at) bits.push(esc(m.generated_at));
  bits.push(esc(d.file));
  document.getElementById("meta").innerHTML = bits.map((b) => "<span>" + b + "</span>").join("");

  const tbox = document.getElementById("tables");
  tbox.innerHTML = "";
  for (const t of d.tables) {
    const b = document.createElement("button");
    b.innerHTML = "<span>" + esc(t.name) + "</span><span class='count'>" + t.rows + "</span>";
    b.onclick = () => selectTable(t.name);
    b.dataset.name = t.name;
    tbox.appendChild(b);
  }
  if (d.tables.length) selectTable(d.tables[0].name);
}

async function selectTable(name) {
  current = name; offset = 0;
  document.querySelectorAll("#tables button").forEach((b) => b.classList.toggle("active", b.dataset.name === name));
  document.getElementById("tableName").textContent = name;
  await loadPage();
}

async function loadPage() {
  const d = await fetch("/api/table/" + encodeURIComponent(current) + "?limit=" + PAGE_SIZE + "&offset=" + offset).then((r) => r.json());
  total = d.total;
  renderGrid(document.getElementById("dataGrid"), d.rows);
  const from = total ? offset + 1 : 0, to = Math.min(offset + PAGE_SIZE, total);
  document.getElementById("pageInfo").textContent = from + "–" + to + " de " + total;
  document.getElementById("prev").disabled = offset <= 0;
  document.getElementById("next").disabled = offset + PAGE_SIZE >= total;
}

document.getElementById("prev").onclick = () => { offset = Math.max(0, offset - PAGE_SIZE); loadPage(); };
document.getElementById("next").onclick = () => { offset += PAGE_SIZE; loadPage(); };

document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".pane").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.getElementById("pane-" + b.dataset.tab).classList.add("active");
  };
});

async function runQuery() {
  const sql = document.getElementById("sql").value;
  const errEl = document.getElementById("sqlErr");
  errEl.textContent = "";
  const d = await fetch("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) }).then((r) => r.json());
  if (d.error) { errEl.textContent = d.error; renderGrid(document.getElementById("sqlGrid"), []); return; }
  renderGrid(document.getElementById("sqlGrid"), d.rows);
}
document.getElementById("run").onclick = runQuery;
document.getElementById("sql").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runQuery(); }
});

loadMeta();
</script>
</body>
</html>`;
