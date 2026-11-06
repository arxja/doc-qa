// Wires chunker -> embedder -> SQLite. No cleverness; it does one thing.

import type { Database } from "bun:sqlite";
import { loadCorpus } from "./fetch";
import { chunkMarkdown, type Chunk } from "./chunk";
import { Embedder } from "../embed";
import { openDb } from "../db";
import { createHash } from "node:crypto";

export type IngestStats = {
  docs: number;
  chunks: number;
  embedded: number;
  cached: number;
};

export async function ingestCorpus(
  db: Database = openDb(),
): Promise<IngestStats> {
  const docs = await loadCorpus();
  const chunks: Chunk[] = docs.flatMap((d) => chunkMarkdown(d));

  const embedder = new Embedder(db);
  const { vectors, cached, embedded } = await embedder.embedTexts(
    chunks.map((c) => c.text),
  );

  // Upsert into chunks table. Delete-then-insert keeps re-runs idempotent.
  const insert = db.prepare(`
    INSERT OR REPLACE INTO chunks
      (id, doc_id, heading_path, text, approx_tokens, content_hash, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      insert.run(
        c.id,
        c.docId,
        JSON.stringify(c.headingPath),
        c.text,
        c.approxTokens,
        createHash("sha256").update(c.text, "utf8").digest("hex"),
        new Uint8Array(vectors[i]!.buffer),
      );
    }
  });
  tx();

  return { docs: docs.length, chunks: chunks.length, embedded, cached };
}
