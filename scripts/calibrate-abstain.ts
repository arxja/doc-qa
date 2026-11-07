// Calibration pass. Runs the pipeline on all 20 in-scope queries,
// records the top-1 reranker score for each, and suggests a threshold
// just under the minimum. Also runs the 10 off-corpus queries and reports
// their top scores — so you can SEE the separation.
//
// Run this FIRST. It prints the number to put in the eval script.

import { openDb } from "../src/db";
import { Embedder } from "../src/embed";
import { Reranker } from "../src/retrieve/rerank";
import { searchVectors } from "../src/retrieve/vector";
import { searchBm25, buildIndexFromDb } from "../src/retrieve/bm25";
import { unionIds } from "../src/retrieve/union";
import { readFileSync } from "node:fs";

type Q = { id: string; q: string };
const inScope: Q[] = JSON.parse(
  readFileSync("evals/queries-d2.json", "utf8"),
).map((q: any) => ({ id: q.id, q: q.q }));
const offScope: Q[] = JSON.parse(
  readFileSync("evals/queries-offcorpus.json", "utf8"),
);

const db = openDb();
const embedder = new Embedder(db);
const reranker = new Reranker(db);
const bm25 = buildIndexFromDb(db);
const getChunk = db.prepare(
  "SELECT text, content_hash FROM chunks WHERE id = ?",
);

async function topScore(query: string): Promise<number> {
  const vec = searchVectors(await embedder.embedQuery(query), db, 10);
  const bm = searchBm25(query, bm25, 10);
  const ids = unionIds(vec, bm);
  let best = -1;
  for (const id of ids) {
    const row = getChunk.get(id) as { text: string; content_hash: string };
    const score = await reranker.score(query, {
      id,
      contentHash: row.content_hash,
      text: row.text,
    });
    if (score > best) best = score;
  }
  return best;
}

console.log("=== IN-SCOPE (should be HIGH) ===");
const inScores: number[] = [];
for (const q of inScope) {
  const s = await topScore(q.q);
  inScores.push(s);
  console.log(`  ${q.id}  top=${s}/10`);
}

console.log("\n=== OFF-SCOPE (should be LOW) ===");
const offScores: number[] = [];
for (const q of offScope) {
  const s = await topScore(q.q);
  offScores.push(s);
  console.log(`  ${q.id}  top=${s}/10   "${q.q}"`);
}

const minIn = Math.min(...inScores);
const maxOff = Math.max(...offScores);
console.log(`\n== calibration ==`);
console.log(`  in-scope  min top score: ${minIn}`);
console.log(`  in-scope  max top score: ${Math.max(...inScores)}`);
console.log(`  off-scope max top score: ${maxOff}`);
console.log(
  `  suggested threshold:     ${((minIn + maxOff) / 2).toFixed(1)}   (midpoint between min-in and max-off)`,
);
console.log(
  `  guardrail:               ${(minIn - 0.5).toFixed(1)}   (just under min-in — fewer false abstentions)`,
);
if (minIn <= maxOff) {
  console.log(
    `\n  ⚠️  OVERLAP — no clean threshold separates in-scope from off-scope.`,
  );
  console.log(
    `     Pick a threshold manually and accept some error. Prefer the guardrail value: it errs on answering.`,
  );
} else {
  console.log(
    `\n  ✅ Clean separation. Any threshold in (${maxOff}, ${minIn}) works.`,
  );
  console.log(
    `     Use ${(minIn - 0.5).toFixed(1)} — errs on the side of answering in-scope queries.`,
  );
}
