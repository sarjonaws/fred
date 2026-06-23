/**
 * Tests del spec binario del header `.fdb` (src/fdb.ts).
 * Ejecutar: npx tsx --test src/fdb.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FDB_MAGIC,
  FDB_HEADER_VERSION,
  FDB_FLAG_SIGNATURE_ASYMMETRIC,
  FDB_FLAG_HAS_COUNTERS,
  encodeFdbHeader,
  decodeFdbHeader,
  isFdb,
  FdbFormatError,
} from "./fdb.js";

test("round-trip completo conserva todos los campos", () => {
  const generatedAt = new Date("2026-06-14T10:20:30.456Z");
  const buf = encodeFdbHeader({
    schemaVersion: 2,
    repoName: "back-appcore-api",
    generatedAt,
    publicKeyFingerprint: "sha256:abcdef0123",
    signatureAsymmetric: true,
    nSummaries: 119,
    nEmbeddings: 119,
    payloadLength: 1_500_000,
    signatureLength: 256,
  });

  const { header, headerLength } = decodeFdbHeader(buf);
  assert.equal(headerLength, buf.length, "headerLength debe igualar el tamaño del buffer");
  assert.equal(header.headerVersion, FDB_HEADER_VERSION);
  assert.equal(header.schemaVersion, 2);
  assert.equal(header.repoName, "back-appcore-api");
  assert.equal(header.generatedAt.getTime(), generatedAt.getTime());
  assert.equal(header.publicKeyFingerprint, "sha256:abcdef0123");
  assert.equal(header.signatureAsymmetric, true);
  assert.equal(header.nSummaries, 119);
  assert.equal(header.nEmbeddings, 119);
  assert.equal(header.payloadLength, 1_500_000);
  assert.equal(header.signatureLength, 256);
});

test("magic bytes correctos y detectables por isFdb", () => {
  const buf = encodeFdbHeader({ schemaVersion: 2, repoName: "x", payloadLength: 0, signatureLength: 0 });
  assert.equal(buf.toString("ascii", 0, 6), FDB_MAGIC);
  assert.equal(isFdb(buf), true);
  assert.equal(isFdb(Buffer.from("SQLite format 3\0")), false);
});

test("flags: HMAC por defecto, sin contadores cuando no se proveen", () => {
  const buf = encodeFdbHeader({ schemaVersion: 2, repoName: "x", payloadLength: 0, signatureLength: 0 });
  const flags = buf.readUInt8(7);
  assert.equal(flags & FDB_FLAG_SIGNATURE_ASYMMETRIC, 0, "HMAC por defecto");
  assert.equal(flags & FDB_FLAG_HAS_COUNTERS, 0, "sin contadores por defecto");
  const { header } = decodeFdbHeader(buf);
  assert.equal(header.signatureAsymmetric, false);
  assert.equal(header.nSummaries, null);
  assert.equal(header.nEmbeddings, null);
});

test("contador parcial (solo n_summaries) enciende HAS_COUNTERS", () => {
  const buf = encodeFdbHeader({
    schemaVersion: 2,
    repoName: "x",
    nSummaries: 10,
    payloadLength: 0,
    signatureLength: 0,
  });
  const { header } = decodeFdbHeader(buf);
  assert.equal(header.nSummaries, 10);
  assert.equal(header.nEmbeddings, 0, "el otro contador es significativo y vale 0, no null");
});

test("repo_name UTF-8 multibyte se conserva", () => {
  const name = "señor-cañón-日本語";
  const buf = encodeFdbHeader({ schemaVersion: 2, repoName: name, payloadLength: 0, signatureLength: 0 });
  const { header } = decodeFdbHeader(buf);
  assert.equal(header.repoName, name);
});

test("magic inválido lanza FdbFormatError", () => {
  const bad = Buffer.alloc(48);
  bad.write("XXXXXX", 0, 6, "ascii");
  assert.throws(() => decodeFdbHeader(bad), FdbFormatError);
});

test("buffer truncado lanza FdbFormatError", () => {
  const buf = encodeFdbHeader({ schemaVersion: 2, repoName: "repo", payloadLength: 0, signatureLength: 0 });
  assert.throws(() => decodeFdbHeader(buf.subarray(0, 10)), FdbFormatError);
  // header anuncia más bytes (repo_name) de los presentes
  assert.throws(() => decodeFdbHeader(buf.subarray(0, 48)), FdbFormatError);
});

test("header_version futura es rechazada", () => {
  const buf = encodeFdbHeader({ schemaVersion: 2, repoName: "x", payloadLength: 0, signatureLength: 0 });
  buf.writeUInt8(FDB_HEADER_VERSION + 1, 6);
  assert.throws(() => decodeFdbHeader(buf), /header_version/);
});

test("repo_name que excede 65535 bytes es rechazado al codificar", () => {
  const huge = "a".repeat(70_000);
  assert.throws(
    () => encodeFdbHeader({ schemaVersion: 2, repoName: huge, payloadLength: 0, signatureLength: 0 }),
    FdbFormatError
  );
});

test("payload_len grande (sobre u32) sobrevive el round-trip", () => {
  const big = 5_000_000_000; // > 2^32, dentro de MAX_SAFE_INTEGER
  const buf = encodeFdbHeader({ schemaVersion: 2, repoName: "x", payloadLength: big, signatureLength: 0 });
  const { header } = decodeFdbHeader(buf);
  assert.equal(header.payloadLength, big);
});
