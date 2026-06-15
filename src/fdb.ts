/**
 * Formato `.fdb` — spec binario del HEADER (zona en claro).
 *
 * El `.fdb` es el sucesor cifrado del `.db` (SQLite) actual. Su layout es:
 *
 *   ┌────────────────────────────────────────────┐
 *   │ HEADER   (texto plano, NO sensible)          │  <- este módulo
 *   ├────────────────────────────────────────────┤
 *   │ PAYLOAD  (cifrado AES-256-GCM)               │  <- futuro: serialización + cifrado
 *   ├────────────────────────────────────────────┤
 *   │ FIRMA    (HMAC-SHA256 o firma asimétrica)    │  <- futuro
 *   └────────────────────────────────────────────┘
 *
 * El header existe para que el hub valide el artefacto SIN descifrar nada:
 * magic bytes, versión de schema, nombre de repo, fingerprint de clave y los
 * contadores (n_summaries/n_embeddings) que permiten rechazar pipelines de CI
 * incompletos. También enmarca el archivo: lleva las longitudes del payload y de
 * la firma, así el lector localiza cada zona sin adivinar (ver docs/fred-fdb-implementacion.md).
 *
 * Todo el header es little-endian.
 */

// Identifica la familia de formato. 6 bytes ASCII. Un .db SQLite empieza por
// "SQLite format 3\0"; estos magic bytes hacen los dos formatos distinguibles a simple vista.
export const FDB_MAGIC = "FRED01";
const MAGIC_BYTES = 6;

// Versión del LAYOUT de este header (distinta de schema_version, que versiona el
// payload). Permite evolucionar la disposición de campos de forma controlada.
export const FDB_HEADER_VERSION = 1;

// Tamaño de la parte fija del header (antes de los campos de longitud variable).
// magic(6) + header_version(1) + flags(1) + schema_version(2) + reserved(2)
// + generated_at_ms(8) + n_summaries(4) + n_embeddings(4)
// + payload_len(8) + signature_len(8) + repo_name_len(2) + fingerprint_len(2) = 48
const FIXED_SIZE = 48;

// Offsets de la parte fija.
const OFF_HEADER_VERSION = 6;
const OFF_FLAGS = 7;
const OFF_SCHEMA_VERSION = 8;
const OFF_RESERVED = 10;
const OFF_GENERATED_AT = 12;
const OFF_N_SUMMARIES = 20;
const OFF_N_EMBEDDINGS = 24;
const OFF_PAYLOAD_LEN = 28;
const OFF_SIGNATURE_LEN = 36;
const OFF_REPO_NAME_LEN = 44;
const OFF_FINGERPRINT_LEN = 46;

// Bitfield de `flags`.
export const FDB_FLAG_SIGNATURE_ASYMMETRIC = 1 << 0; // 1 = firma asimétrica; 0 = HMAC-SHA256
export const FDB_FLAG_HAS_COUNTERS = 1 << 1; // 1 = n_summaries/n_embeddings son significativos

/** Header del `.fdb` en su forma lógica (decodificada). */
export interface FdbHeader {
  /** Versión del layout del header. Por defecto FDB_HEADER_VERSION al codificar. */
  headerVersion: number;
  /** Versión del schema del payload (espeja SCHEMA_VERSION de db.ts). */
  schemaVersion: number;
  /** true si la firma del archivo es asimétrica; false = HMAC-SHA256. */
  signatureAsymmetric: boolean;
  /** Nombre del repo (meta.repo_name). UTF-8, máx 65535 bytes. */
  repoName: string;
  /** Momento de generación del artefacto (meta.generated_at), precisión de ms. */
  generatedAt: Date;
  /** Fingerprint de la clave pública usada para firmar/cifrar. "" si aún no aplica. */
  publicKeyFingerprint: string;
  /** Nº de resúmenes en el payload, o null si los contadores no se incluyeron. */
  nSummaries: number | null;
  /** Nº de embeddings en el payload, o null si los contadores no se incluyeron. */
  nEmbeddings: number | null;
  /** Bytes del PAYLOAD cifrado que siguen al header. */
  payloadLength: number;
  /** Bytes de la FIRMA al final del archivo. */
  signatureLength: number;
}

/** Error de formato del `.fdb`: magic inválido, header truncado, versión no soportada, etc. */
export class FdbFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FdbFormatError";
  }
}

/** Campos que el llamador provee; el resto del header se rellena con defaults sensatos. */
export type FdbHeaderInput = Partial<FdbHeader> &
  Pick<FdbHeader, "schemaVersion" | "repoName" | "payloadLength" | "signatureLength">;

function utf8Bytes(s: string, field: string, max: number): Buffer {
  const buf = Buffer.from(s, "utf8");
  if (buf.length > max) {
    throw new FdbFormatError(`${field} excede ${max} bytes en UTF-8 (${buf.length})`);
  }
  return buf;
}

function assertU32(n: number, field: string): number {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new FdbFormatError(`${field} fuera de rango u32: ${n}`);
  }
  return n;
}

function assertU64(n: number, field: string): bigint {
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new FdbFormatError(`${field} fuera de rango u64 seguro: ${n}`);
  }
  return BigInt(n);
}

/**
 * Serializa un header a su forma binaria.
 *
 * Layout (little-endian):
 *   0   magic                  6  ASCII "FRED01"
 *   6   header_version         1  u8
 *   7   flags                  1  u8  (bitfield FDB_FLAG_*)
 *   8   schema_version         2  u16 (schema del payload)
 *   10  reserved               2  u16 (cero; alineación / futuro)
 *   12  generated_at_ms        8  i64 (epoch UTC en ms)
 *   20  n_summaries            4  u32 (0 si HAS_COUNTERS está apagado)
 *   24  n_embeddings           4  u32 (0 si HAS_COUNTERS está apagado)
 *   28  payload_len            8  u64 (bytes del payload cifrado)
 *   36  signature_len          8  u64 (bytes de la firma)
 *   44  repo_name_len          2  u16
 *   46  fingerprint_len        2  u16
 *   48  repo_name              var UTF-8
 *   ..  public_key_fingerprint var UTF-8
 */
export function encodeFdbHeader(input: FdbHeaderInput): Buffer {
  const repoNameBytes = utf8Bytes(input.repoName, "repo_name", 0xffff);
  const fingerprintBytes = utf8Bytes(input.publicKeyFingerprint ?? "", "public_key_fingerprint", 0xffff);

  const hasCounters = input.nSummaries != null || input.nEmbeddings != null;
  let flags = 0;
  if (input.signatureAsymmetric) flags |= FDB_FLAG_SIGNATURE_ASYMMETRIC;
  if (hasCounters) flags |= FDB_FLAG_HAS_COUNTERS;

  const generatedAt = input.generatedAt ?? new Date();

  const buf = Buffer.alloc(FIXED_SIZE + repoNameBytes.length + fingerprintBytes.length);
  buf.write(FDB_MAGIC, 0, MAGIC_BYTES, "ascii");
  buf.writeUInt8(input.headerVersion ?? FDB_HEADER_VERSION, OFF_HEADER_VERSION);
  buf.writeUInt8(flags, OFF_FLAGS);
  buf.writeUInt16LE(assertU32(input.schemaVersion, "schema_version") & 0xffff, OFF_SCHEMA_VERSION);
  buf.writeUInt16LE(0, OFF_RESERVED);
  buf.writeBigInt64LE(BigInt(generatedAt.getTime()), OFF_GENERATED_AT);
  buf.writeUInt32LE(assertU32(input.nSummaries ?? 0, "n_summaries"), OFF_N_SUMMARIES);
  buf.writeUInt32LE(assertU32(input.nEmbeddings ?? 0, "n_embeddings"), OFF_N_EMBEDDINGS);
  buf.writeBigUInt64LE(assertU64(input.payloadLength, "payload_len"), OFF_PAYLOAD_LEN);
  buf.writeBigUInt64LE(assertU64(input.signatureLength, "signature_len"), OFF_SIGNATURE_LEN);
  buf.writeUInt16LE(repoNameBytes.length, OFF_REPO_NAME_LEN);
  buf.writeUInt16LE(fingerprintBytes.length, OFF_FINGERPRINT_LEN);
  repoNameBytes.copy(buf, FIXED_SIZE);
  fingerprintBytes.copy(buf, FIXED_SIZE + repoNameBytes.length);
  return buf;
}

/** Resultado de decodificar: el header lógico y cuántos bytes ocupó (= offset del payload). */
export interface DecodedFdbHeader {
  header: FdbHeader;
  /** Longitud total del header en bytes; el payload empieza en este offset. */
  headerLength: number;
}

/**
 * Decodifica el header desde el inicio de un `.fdb`. Valida magic y consistencia
 * de longitudes; no descifra ni toca el payload. Lanza FdbFormatError si el buffer
 * está truncado o el magic no coincide.
 */
export function decodeFdbHeader(buf: Buffer): DecodedFdbHeader {
  if (buf.length < FIXED_SIZE) {
    throw new FdbFormatError(`header truncado: ${buf.length} bytes, se requieren al menos ${FIXED_SIZE}`);
  }
  const magic = buf.toString("ascii", 0, MAGIC_BYTES);
  if (magic !== FDB_MAGIC) {
    throw new FdbFormatError(`magic bytes inválidos: esperado "${FDB_MAGIC}", visto "${magic}"`);
  }

  const headerVersion = buf.readUInt8(OFF_HEADER_VERSION);
  if (headerVersion > FDB_HEADER_VERSION) {
    throw new FdbFormatError(
      `header_version ${headerVersion} no soportado (máx ${FDB_HEADER_VERSION}); actualiza fred`
    );
  }

  const flags = buf.readUInt8(OFF_FLAGS);
  const hasCounters = (flags & FDB_FLAG_HAS_COUNTERS) !== 0;
  const repoNameLen = buf.readUInt16LE(OFF_REPO_NAME_LEN);
  const fingerprintLen = buf.readUInt16LE(OFF_FINGERPRINT_LEN);
  const headerLength = FIXED_SIZE + repoNameLen + fingerprintLen;
  if (buf.length < headerLength) {
    throw new FdbFormatError(
      `header truncado: se anuncian ${headerLength} bytes pero el buffer tiene ${buf.length}`
    );
  }

  const repoName = buf.toString("utf8", FIXED_SIZE, FIXED_SIZE + repoNameLen);
  const publicKeyFingerprint = buf.toString(
    "utf8",
    FIXED_SIZE + repoNameLen,
    FIXED_SIZE + repoNameLen + fingerprintLen
  );

  const header: FdbHeader = {
    headerVersion,
    schemaVersion: buf.readUInt16LE(OFF_SCHEMA_VERSION),
    signatureAsymmetric: (flags & FDB_FLAG_SIGNATURE_ASYMMETRIC) !== 0,
    repoName,
    generatedAt: new Date(Number(buf.readBigInt64LE(OFF_GENERATED_AT))),
    publicKeyFingerprint,
    nSummaries: hasCounters ? buf.readUInt32LE(OFF_N_SUMMARIES) : null,
    nEmbeddings: hasCounters ? buf.readUInt32LE(OFF_N_EMBEDDINGS) : null,
    payloadLength: Number(buf.readBigUInt64LE(OFF_PAYLOAD_LEN)),
    signatureLength: Number(buf.readBigUInt64LE(OFF_SIGNATURE_LEN)),
  };
  return { header, headerLength };
}

/**
 * Lee solo lo justo para detectar/validar el formato sin cargar el archivo entero:
 * útil cuando el hub escanea un directorio de artefactos. `chunk` debe contener al
 * menos los primeros `headerLength` bytes del archivo.
 */
export function isFdb(chunk: Buffer): boolean {
  return chunk.length >= MAGIC_BYTES && chunk.toString("ascii", 0, MAGIC_BYTES) === FDB_MAGIC;
}
