// Smoke test: run union + rerank on 2 queries, print full ranking with scores.

import { openDb } from "../src/db";
import { Embedder } from "../src/embed";
import { Reranker } from "../src/retrieve/rerank";
import { searchVectors } from "../src/retrieve/vector";
import { searchBm25, buildIndexFromDb } from "../src/retrieve/bm25";
import { unionIds } from "../src/retrieve/union";

const queries = [
  "Is E_INTERNAL safe to retry?",
  "How do I prove who I am to the API?",
];

const db = openDb();
const embedder = new Embedder(db);
const reranker = new Reranker(db);
const bm25 = buildIndexFromDb(db);
const contentHash = db.prepare("SELECT content_hash FROM chunks WHERE id = ?");
const getChunk = db.prepare(
  "SELECT text, content_hash FROM chunks WHERE id = ?",
);

for (const q of queries) {
  console.log(`\n${"=".repeat(70)}\nQuery: ${q}\n${"=".repeat(70)}`);

  const vec = searchVectors(await embedder.embedQuery(q), db, 10);
  const bm = searchBm25(q, bm25, 10);
  const ids = unionIds(vec, bm);

  const candidates = ids.map((id) => {
    const row = getChunk.get(id) as { text: string; content_hash: string };
    return {
      id,
      text: row.text,
      contentHash: row.content_hash,
      vectorRank: vec.findIndex((v) => v.id === id) + 1 || null,
      bm25Rank: bm.findIndex((b) => b.id === id) + 1 || null,
    };
  });

  const scored: Array<{
    id: string;
    text: string;
    score: number;
    vR: number | null;
    bR: number | null;
  }> = [];
  for (const c of candidates) {
    const score = await reranker.score(q, c);
    scored.push({
      id: c.id,
      text: c.text,
      score,
      vR: c.vectorRank,
      bR: c.bm25Rank,
    });
  }
  scored.sort((a, b) => b.score - a.score);

  for (const s of scored.slice(0, 10)) {
    const preview = s.text.replace(/\s+/g, " ").slice(0, 100);
    console.log(
      `  [${s.score}/10] ${s.id.padEnd(20)}  (v=${s.vR ?? "—"}, b=${s.bR ?? "—"})`,
    );
    console.log(`         ${preview}${s.text.length > 100 ? "…" : ""}`);
  }
  const scores = scored.map((s) => s.score);
  const spread = Math.max(...scores) - Math.min(...scores);
  console.log(
    `\n  union size=${candidates.length}  calls=${reranker.callsMade}  cached=${reranker.callsCached}  score spread=${spread}`,
  );
  if (spread < 3)
    console.warn(
      "  ⚠️  LOW SPREAD — reranker is not discriminating, prompt may need work",
    );
}
