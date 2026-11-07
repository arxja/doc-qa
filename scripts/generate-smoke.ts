// Smoke test: run union+rerank -> top-5 -> generate, on 2 queries.
// Shows the answer with citations resolved to chunks.

import { openDb } from "../src/db";
import { Embedder } from "../src/embed";
import { Generator } from "../src/generate";
import { Reranker } from "../src/retrieve/rerank";
import { searchVectors } from "../src/retrieve/vector";
import { searchBm25, buildIndexFromDb } from "../src/retrieve/bm25";
import { unionIds } from "../src/retrieve/union";

const queries = [
  "How many times are failed webhooks retried?",
  "Can a viewer delete a document?",
];

const db = openDb();
const embedder = new Embedder(db);
const reranker = new Reranker(db);
const generator = new Generator(db);
const bm25 = buildIndexFromDb(db);
const getChunk = db.prepare(
  "SELECT text, heading_path, content_hash FROM chunks WHERE id = ?",
);

for (const q of queries) {
  console.log(`\n${"=".repeat(72)}\nQuery: ${q}\n${"=".repeat(72)}`);

  const vec = searchVectors(await embedder.embedQuery(q), db, 10);
  const bm = searchBm25(q, bm25, 10);
  const ids = unionIds(vec, bm);

  const scored = [];
  for (const id of ids) {
    const row = getChunk.get(id) as {
      text: string;
      heading_path: string;
      content_hash: string;
    };
    const score = await reranker.score(q, {
      id,
      contentHash: row.content_hash,
      text: row.text,
    });
    scored.push({ id, text: row.text, heading_path: row.heading_path, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top5 = scored.slice(0, 5).map((c) => ({
    id: c.id,
    headingPath: JSON.parse(c.heading_path) as string[],
    text: c.text,
  }));

  console.log(`\nTop-5 fed to generator (from rerank):`);
  for (const c of top5)
    console.log(`  • ${c.id}  (${c.headingPath.join(" > ")})`);

  const result = await generator.generate(q, top5);

  console.log(`\n── ANSWER ──`);
  console.log(result.answer);
  console.log(`\n── CITATIONS ──`);
  for (const c of result.citations) {
    console.log(`  [${c.n}] ${c.chunkId}  (${c.headingPath.join(" > ")})`);
  }
  console.log(`\n── DIAGNOSTICS ──`);
  console.log(`  abstained:        ${result.abstained}`);
  console.log(`  cited indices:    [${result.citedIndices.join(", ")}]`);
  console.log(`  uncited chunks:   [${result.uncitedIndices.join(", ")}]`);
  console.log(`  invalid indices:  [${result.invalidIndices.join(", ")}]`);
  console.log(
    `  API calls: ${generator.callsMade}, cached: ${generator.callsCached}`,
  );
}
