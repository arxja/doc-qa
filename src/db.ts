// SQLite storage. Two tables:
//   - chunks:          the retrievable units (text + heading path + embedding)
//   - embedding_cache: content-hash -> vector (so re-runs don't re-embed)
//
// Rule: cache key is sha256 of the EXACT UTF-8 bytes of chunk.text.
// No trim, no normalize, no lowercase. Byte-identical in -> byte-identical key.

import { Database } from "bun:sqlite";

export const EMBEDDING_DIMS = 768;

export function openDb(path = "data/lumen.db"): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id             TEXT PRIMARY KEY,
      doc_id         TEXT NOT NULL,
      heading_path   TEXT NOT NULL,          -- JSON array, e.g. ["Auth","OAuth 2.0"]
      text           TEXT NOT NULL,
      approx_tokens  INTEGER NOT NULL,
      content_hash   TEXT NOT NULL,
      embedding      BLOB NOT NULL           -- Float32Array(768) as bytes
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

    CREATE TABLE IF NOT EXISTS embedding_cache (
      content_hash  TEXT PRIMARY KEY,
      vector        BLOB NOT NULL,           -- Float32Array(768)
      dims          INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rerank_cache (
      key           TEXT PRIMARY KEY,
      score         INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS generation_cache (
      key       TEXT PRIMARY KEY,
      answer    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

// SQLite BLOB -> Float32Array. Bun returns BLOB as Uint8Array.
export function blobToVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob); // ensure 4-byte-aligned buffer
  return new Float32Array(copy.buffer);
}
