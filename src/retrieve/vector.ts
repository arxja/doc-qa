// Brute-force kNN over stored embeddings.
// O(N·D) per query. Fine to ~100K chunks; swap for sqlite-vec or HNSW past that.

import type { Database } from "bun:sqlite";
import { blobToVector } from "../db";

export type ScoredChunk = {
  id: string;
  docId: string;
  headingPath: string[];
  text: string;
  score: number; // cosine similarity ∈ [-1, 1]
};

type Row = {
  id: string;
  doc_id: string;
  heading_path: string;
  text: string;
  embedding: Uint8Array;
};

// Cosine similarity. Vectors are truncated (norm ≈ 0.58, not 1.0),
// so we divide by both norms — ranking differs from raw dot product.
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function searchVectors(
  queryVec: Float32Array,
  db: Database,
  k = 10,
): ScoredChunk[] {
  const rows = db
    .query("SELECT id, doc_id, heading_path, text, embedding FROM chunks")
    .all() as Row[];

  const scored: ScoredChunk[] = rows.map((r) => ({
    id: r.id,
    docId: r.doc_id,
    headingPath: JSON.parse(r.heading_path) as string[],
    text: r.text,
    score: cosine(queryVec, blobToVector(r.embedding)),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
