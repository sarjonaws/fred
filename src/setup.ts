/**
 * Preparación interactiva de la sesión de consulta (Fase 3).
 * Antes de abrir `ask`, `chat` o `tui`:
 *   1. Resuelve las API keys: entorno → ~/.fred/credentials.json →
 *      preguntar (entrada oculta). Las tecleadas se inyectan en process.env
 *      y, si el usuario acepta, se guardan para futuras sesiones.
 *   2. Resuelve la base de datos: si existe la confirma con el usuario y
 *      completa las fases pendientes (resúmenes/embeddings); si no existe,
 *      ofrece las .db del directorio actual o construye una nueva pidiendo
 *      la ruta del proyecto (analyze → summarize → embed).
 * Sin TTY (stdin por pipe) no se pregunta nada: se valida y se falla con un
 * mensaje accionable, para no romper el uso de `chat`/`ask` en scripts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { analyze } from "./analyzer.js";
import { summarize } from "./summarize.js";
import { embedSummaries } from "./embed.js";
import { openFdbToMemory } from "./seal.js";

export interface SetupOptions {
  dbPath: string; // valor de --db (puede no existir todavía)
  model: string;  // modelo de Claude — se reusa si hay que generar resúmenes
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const API_KEYS = [
  { env: "ANTHROPIC_API_KEY", use: "Claude: agente RAG y resúmenes" },
  { env: "VOYAGE_API_KEY", use: "Voyage AI: búsqueda vectorial y embeddings" },
];

/** Credenciales guardadas del usuario, al estilo ~/.claude de Claude Code. */
const CREDENTIALS_PATH = join(homedir(), ".fred", "credentials.json");

/** Lee las claves guardadas; archivo ausente o corrupto cuenta como vacío. Tolera BOM (editores de Windows). */
function loadSavedKeys(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function saveKeys(keys: Record<string, string>): void {
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  // mode 0o600: solo el dueño puede leerlas (en Windows aplican las ACL del perfil)
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
}

/** Pregunta simple por stdin. Una interfaz readline por pregunta, para no interferir con la entrada oculta ni con la sesión que sigue. */
async function question(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/** Lee una línea sin eco (muestra * por carácter) — para las API keys. Requiere TTY. */
function questionHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\x03") {
          // Ctrl+C: en raw mode el proceso no recibe SIGINT, hay que salir a mano
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\x7f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (ch >= " ") {
          // se ignoran los demás caracteres de control (flechas, escape, etc.)
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

/** Resuelve las API keys (entorno → guardadas → preguntar) y las deja en process.env: el SDK de Anthropic y voyageEmbed las leen de ahí. */
async function ensureApiKeys(interactive: boolean): Promise<void> {
  const saved = loadSavedKeys();
  for (const key of API_KEYS) {
    if (!process.env[key.env] && saved[key.env]) process.env[key.env] = saved[key.env];
  }
  const missing = API_KEYS.filter((k) => !process.env[k.env]);
  if (!missing.length) return;
  if (!interactive)
    throw new Error(
      `Faltan las claves: ${missing.map((k) => k.env).join(", ")}. ` +
      `Defínelas como variables de entorno o guárdalas en ${CREDENTIALS_PATH}.`
    );

  console.log(bold("Claves de API") + dim("  ·  no se muestran al teclear"));
  const entered: Record<string, string> = {};
  for (const key of missing) {
    let value = "";
    while (!value) value = (await questionHidden(`  ${key.env} ${dim(`(${key.use})`)}: `)).trim();
    process.env[key.env] = value;
    entered[key.env] = value;
  }
  const save = await question(`¿Guardar en ${dim(CREDENTIALS_PATH)} para futuras sesiones? (S/n): `);
  if (!/^n/i.test(save)) {
    saveKeys({ ...saved, ...entered });
    console.log(dim("  guardadas."));
  }
  console.log();
}

/**
 * Resuelve las API keys para un comando no interactivo de generación (build):
 * entorno → ~/.fred/credentials.json → preguntar oculta si hay TTY. Las deja en
 * process.env para que summarize/embed las lean.
 */
export async function resolveApiKeys(): Promise<void> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  await ensureApiKeys(interactive);
}

interface DbStatus {
  summaries: number;
  embeddings: number;
}

/** Cuenta resúmenes y embeddings; tablas inexistentes (base de una fase anterior) cuentan como 0. */
function inspectDb(path: string): DbStatus {
  const db = new DatabaseSync(path, { readOnly: true });
  const count = (table: string): number => {
    try {
      return Number((db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c);
    } catch {
      return 0;
    }
  };
  const status = { summaries: count("summaries"), embeddings: count("embeddings") };
  db.close();
  return status;
}

async function askRepoPath(): Promise<string> {
  while (true) {
    const repo = await question("Ruta del proyecto TypeScript a analizar: ");
    if (repo && existsSync(repo)) return repo;
    console.log(dim("  esa ruta no existe, intenta de nuevo."));
  }
}

async function summarizeAndReport(dbPath: string, repoPath: string, model: string): Promise<void> {
  console.log(`Resumiendo reglas de negocio con ${model} ${dim("(consume tokens de la API)")} ...`);
  const s = await summarize({ repoPath, dbPath, model });
  console.log(dim(`  ${s.functions.summarized} funciones, ${s.modules.summarized} módulos, ${s.domains.summarized} dominios resumidos`));
}

async function embedAndReport(dbPath: string): Promise<void> {
  console.log("Generando embeddings con Voyage ...");
  const e = await embedSummaries({ dbPath });
  console.log(dim(`  ${e.embedded} generados, ${e.unchanged} sin cambios`));
}

/** Pipeline completo sobre una base nueva (o regenerada): analyze → summarize → embed. */
async function createDatabase(dbPath: string, model: string): Promise<string> {
  console.log(`\nVoy a crear ${bold(dbPath)} (analyze → summarize → embed).`);
  const repo = await askRepoPath();
  console.log(`\nAnalizando ${repo} ...`);
  const a = analyze({ repoPath: repo, dbPath });
  console.log(dim(`  ${a.files} archivos, ${a.symbols} símbolos, ${a.calls} llamadas (${a.resolvedCalls} resueltas)`));
  await summarizeAndReport(dbPath, repo, model);
  await embedAndReport(dbPath);
  console.log(`Base lista en ${bold(dbPath)}\n`);
  return dbPath;
}

/** Decide qué base usar: la existente (confirmada), otra .db del directorio, o una nueva. */
async function resolveDatabase(opts: SetupOptions, interactive: boolean): Promise<string> {
  if (existsSync(opts.dbPath)) {
    if (!interactive) return opts.dbPath;
    const st = inspectDb(opts.dbPath);
    const ok = await question(
      `Encontré ${bold(opts.dbPath)} ${dim(`(${st.summaries} resúmenes, ${st.embeddings} embeddings)`)}. ¿Usarla para la sesión? (S/n): `
    );
    if (!/^n/i.test(ok)) return opts.dbPath;
    const name = await question(`Archivo para la nueva base ${dim(`(Enter = regenerar ${opts.dbPath})`)}: `);
    return createDatabase(name ? resolve(name) : opts.dbPath, opts.model);
  }

  if (!interactive)
    throw new Error(
      `No existe la base ${opts.dbPath}. Genérala primero: analyze <repo> --db ${opts.dbPath}, ` +
      `summarize <repo> --db ${opts.dbPath}, embed --db ${opts.dbPath}.`
    );

  const others = readdirSync(".").filter((f) => f.endsWith(".db") && f !== basename(opts.dbPath));
  if (others.length) {
    console.log(`No existe ${bold(opts.dbPath)}, pero hay otras bases en el directorio:`);
    others.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    const pick = await question("Número de la base a usar, o Enter para crear una nueva: ");
    const idx = Number(pick);
    if (pick && Number.isInteger(idx) && idx >= 1 && idx <= others.length) return resolve(others[idx - 1]);
  }
  return createDatabase(opts.dbPath, opts.model);
}

/** Completa las fases pendientes de una base ya elegida (idempotente si está completa). */
async function completeDatabase(dbPath: string, model: string, interactive: boolean): Promise<void> {
  const st = inspectDb(dbPath);
  if (st.summaries && st.embeddings) return;
  if (!interactive) {
    if (!st.summaries)
      throw new Error(`La base ${dbPath} no tiene resúmenes (Fase 2). Corre: summarize <repo> --db ${dbPath} y luego embed --db ${dbPath}.`);
    throw new Error(`La base ${dbPath} no tiene embeddings. Corre: embed --db ${dbPath}.`);
  }
  if (!st.summaries) {
    console.log(`La base ${bold(dbPath)} no tiene resúmenes (Fase 2 pendiente); hay que generarlos.`);
    await summarizeAndReport(dbPath, await askRepoPath(), model);
  }
  await embedAndReport(dbPath);
  console.log();
}

/**
 * Deja todo listo para abrir una sesión de consulta (claves + base completa)
 * y devuelve la ruta de la base a usar — puede diferir de opts.dbPath si el
 * usuario eligió otra del directorio o creó una nueva.
 */
export async function prepareSession(opts: SetupOptions): Promise<string> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  await ensureApiKeys(interactive);
  // Ruta absoluta desde el inicio: todos los mensajes (y el pie del TUI) deben
  // mostrar DÓNDE vive la base realmente, no el valor relativo de --db.
  const dbPath = await resolveDatabase({ ...opts, dbPath: resolve(opts.dbPath) }, interactive);
  await completeDatabase(dbPath, opts.model, interactive);
  return dbPath;
}

/** Resuelve la passphrase del .fdb: flag → env FRED_FDB_PASSPHRASE → preguntar oculta (requiere TTY). */
async function resolvePassphrase(flag: string | undefined, interactive: boolean): Promise<string> {
  const fromFlagOrEnv = flag ?? process.env.FRED_FDB_PASSPHRASE;
  if (fromFlagOrEnv) return fromFlagOrEnv;
  if (!interactive)
    throw new Error("Falta la passphrase del .fdb: usa --passphrase o la variable FRED_FDB_PASSPHRASE.");
  let value = "";
  while (!value) value = (await questionHidden(`Passphrase del ${bold(".fdb")}: `)).trim();
  return value;
}

/**
 * Pide la passphrase para CIFRAR un .fdb nuevo: flag/env si existen; si no, se
 * pide por teclado (oculta) con confirmación. Sin flag/env y sin TTY, falla.
 */
export async function resolveSealPassphrase(flag?: string): Promise<string> {
  const fromFlagOrEnv = flag ?? process.env.FRED_FDB_PASSPHRASE;
  if (fromFlagOrEnv) return fromFlagOrEnv;
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive)
    throw new Error("Falta la passphrase: usa --passphrase o la variable FRED_FDB_PASSPHRASE.");
  while (true) {
    const p1 = (await questionHidden(`Passphrase para cifrar el ${bold(".fdb")}: `)).trim();
    if (!p1) { console.log(dim("  no puede estar vacía.")); continue; }
    const p2 = (await questionHidden("Confírmala: ")).trim();
    if (p1 !== p2) { console.log(dim("  no coinciden, intenta de nuevo.")); continue; }
    return p1;
  }
}

export interface FdbSessionOptions {
  fdbPath: string;     // ruta al artefacto .fdb cifrado
  passphrase?: string; // si se omite: env FRED_FDB_PASSPHRASE o se pregunta (TTY)
}

/**
 * Prepara una sesión de consulta sobre un .fdb cifrado: resuelve las API keys y la
 * passphrase, descifra el artefacto y lo carga en una base SQLite EN MEMORIA (los
 * datos descifrados nunca tocan disco). Devuelve la conexión lista para RagAgent.
 * Un .fdb ya es autocontenido (se selló tras summarize+embed), así que no hay fases
 * pendientes que completar — a diferencia de un .db nuevo.
 */
export async function prepareFdbSession(opts: FdbSessionOptions): Promise<DatabaseSync> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  await ensureApiKeys(interactive);
  const passphrase = await resolvePassphrase(opts.passphrase, interactive);
  return openFdbToMemory(resolve(opts.fdbPath), passphrase);
}
