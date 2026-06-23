/**
 * Formato `.fdb` — sellado (db -> fdb) y apertura (fdb -> bytes en memoria).
 *
 * Ensambla el archivo cifrado a partir de un `.db` SQLite existente:
 *
 *   HEADER (claro, ver fdb.ts)  +  PAYLOAD (cifrado)  +  FIRMA (HMAC-SHA256)
 *
 * El PAYLOAD aquí es el archivo `.db` completo cifrado con AES-256-GCM. SQLite ya
 * es una serialización autocontenida de summaries/embeddings/meta/grafo, así que
 * "serializar el payload" (§10.2) es leer sus bytes; preservar el formato exacto
 * garantiza la compatibilidad hacia arriba del plan Developer (§7).
 *
 * Layout interno de la zona PAYLOAD (los `payload_len` bytes que enmarca el header):
 *
 *   kdf_salt(16) || iv(12) || ciphertext || auth_tag(16)
 *
 * La clave se deriva de una passphrase con scrypt + salt aleatoria por archivo
 * (la salt no es sensible, por eso viaja en claro dentro de la zona payload). De los
 * 64 bytes derivados salen la clave AES (cifrado) y la clave HMAC (firma).
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readMeta, SCHEMA_VERSION } from "./db.js";
import {
  encodeFdbHeader,
  decodeFdbHeader,
  type FdbHeader,
} from "./fdb.js";

const SALT_LEN = 16;
const IV_LEN = 12; // recomendado para AES-GCM
const TAG_LEN = 16; // auth_tag de GCM
const HMAC_LEN = 32; // SHA-256

/** Deriva (claveAES, claveHMAC) desde la passphrase y la salt del archivo. */
function deriveKeys(passphrase: string, salt: Buffer): { aesKey: Buffer; hmacKey: Buffer } {
  const dk = scryptSync(passphrase, salt, 64);
  return { aesKey: dk.subarray(0, 32), hmacKey: dk.subarray(32, 64) };
}

/** Fingerprint no sensible de la clave HMAC: permite detectar una passphrase errónea sin descifrar. */
function keyFingerprint(hmacKey: Buffer): string {
  return "sha256:" + createHash("sha256").update(hmacKey).digest("hex").slice(0, 16);
}

interface DbPayload {
  repoName: string;
  schemaVersion: number;
  generatedAt: Date;
  nSummaries: number;
  nEmbeddings: number;
  /** Imagen SQLite consistente del .db (lista para deserialize), en modo rollback. */
  plaintext: Buffer;
}

/**
 * Lee metadatos/contadores y una imagen serializada del `.db` sin alterarlo.
 * Usa serialize() (snapshot consistente, incluye WAL no checkpointeado) y normaliza
 * el flag de journal del header de WAL(2) a rollback(1): así la imagen se puede
 * cargar con deserialize() en memoria, que no tiene archivo -wal lateral.
 */
function readDbPayload(dbPath: string): DbPayload {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const meta = readMeta(db);
    const count = (table: string): number => {
      const exists = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table);
      if (!exists) return 0;
      return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
    };
    const plaintext = (db as unknown as { serialize(): Buffer }).serialize();
    // Bytes 18 (write version) y 19 (read version) del header SQLite: 2 = WAL, 1 = rollback.
    if (plaintext.length >= 20) {
      if (plaintext[18] === 2) plaintext[18] = 1;
      if (plaintext[19] === 2) plaintext[19] = 1;
    }
    return {
      repoName: meta.repo_name ?? "",
      schemaVersion: meta.schema_version ? Number(meta.schema_version) : SCHEMA_VERSION,
      generatedAt: meta.generated_at ? new Date(meta.generated_at) : new Date(),
      nSummaries: count("summaries"),
      nEmbeddings: count("embeddings"),
      plaintext,
    };
  } finally {
    db.close();
  }
}

export interface SealResult {
  outPath: string;
  bytesWritten: number;
  header: FdbHeader;
}

/**
 * Sella un `.db` en un `.fdb` cifrado. La passphrase es la única forma de abrirlo
 * después: si se pierde, el contenido es irrecuperable.
 */
export function sealDb(dbPath: string, outPath: string, passphrase: string): SealResult {
  if (!passphrase) throw new Error("falta la passphrase para cifrar el .fdb");
  const info = readDbPayload(dbPath);
  const plaintext = info.plaintext; // imagen SQLite consistente, lista para deserialize

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const { aesKey, hmacKey } = deriveKeys(passphrase, salt);

  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = Buffer.concat([salt, iv, ciphertext, authTag]);

  const header = encodeFdbHeader({
    schemaVersion: info.schemaVersion,
    repoName: info.repoName,
    generatedAt: info.generatedAt,
    publicKeyFingerprint: keyFingerprint(hmacKey),
    signatureAsymmetric: false, // primer corte: HMAC-SHA256
    nSummaries: info.nSummaries,
    nEmbeddings: info.nEmbeddings,
    payloadLength: payload.length,
    signatureLength: HMAC_LEN,
  });

  // La firma cubre header + payload: detecta manipulación de cualquiera de los dos.
  const signature = createHmac("sha256", hmacKey).update(header).update(payload).digest();

  const file = Buffer.concat([header, payload, signature]);
  writeFileSync(outPath, file);

  return { outPath, bytesWritten: file.length, header: decodeFdbHeader(header).header };
}

export interface OpenResult {
  header: FdbHeader;
  /** Bytes del `.db` descifrados, solo en memoria (nunca se escriben a disco). */
  data: Buffer;
}

/**
 * Abre y descifra un `.fdb`. Verifica el magic, la firma HMAC y el auth_tag de GCM
 * antes de devolver los bytes. Los datos descifrados solo viven en memoria (§5).
 */
export function openFdb(fdbPath: string, passphrase: string): OpenResult {
  if (!passphrase) throw new Error("falta la passphrase para descifrar el .fdb");
  const file = readFileSync(fdbPath);
  const { header, headerLength } = decodeFdbHeader(file);

  const payloadStart = headerLength;
  const payloadEnd = payloadStart + header.payloadLength;
  const sigEnd = payloadEnd + header.signatureLength;
  if (file.length < sigEnd) {
    throw new Error(`archivo .fdb truncado: se esperaban ${sigEnd} bytes, hay ${file.length}`);
  }
  const headerBytes = file.subarray(0, headerLength);
  const payload = file.subarray(payloadStart, payloadEnd);
  const signature = file.subarray(payloadEnd, sigEnd);

  if (payload.length < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error("payload del .fdb demasiado corto / corrupto");
  }
  const salt = payload.subarray(0, SALT_LEN);
  const iv = payload.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = payload.subarray(SALT_LEN + IV_LEN, payload.length - TAG_LEN);
  const authTag = payload.subarray(payload.length - TAG_LEN);

  const { aesKey, hmacKey } = deriveKeys(passphrase, salt);

  // Passphrase incorrecta: lo detectamos por el fingerprint antes de gastar en verificación.
  if (header.publicKeyFingerprint && header.publicKeyFingerprint !== keyFingerprint(hmacKey)) {
    throw new Error("passphrase incorrecta para este .fdb");
  }

  const expected = createHmac("sha256", hmacKey).update(headerBytes).update(payload).digest();
  if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
    throw new Error("firma inválida: el .fdb fue manipulado o la passphrase es incorrecta");
  }

  const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(authTag);
  const data = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { header, data };
}

/**
 * Abre un `.fdb` y lo carga en una base SQLite EN MEMORIA (deserialize), sin
 * escribir nunca los bytes descifrados a disco (§5). Devuelve una conexión lista
 * para consultarse igual que cualquier `.db` (la usa RagAgent vía `sources`).
 */
export function openFdbToMemory(fdbPath: string, passphrase: string): DatabaseSync {
  const { data } = openFdb(fdbPath, passphrase);
  const db = new DatabaseSync(":memory:");
  // deserialize es reciente y aún no está en @types/node; cargamos los bytes en memoria.
  (db as unknown as { deserialize(data: Buffer): void }).deserialize(data);
  return db;
}
