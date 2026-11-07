// Runs all 20 in-scope + 10 off-scope queries through the full
// D4 -> D6 pipeline. Measures abstention accuracy on both sides.
//
// Success criterion:
//   off-scope abstention = 10/10  (all 10 refuse)
//   in-scope abstention <= 1      (at most 1 false abstention)

import { openDb } from "../src/db";
import { Embedder } from "../src/embed";
import { Generator } from "../src/generate";
import { Reranker } from "../src/retrieve/rerank";
import { searchVectors } from "../src/retrieve/vector";
import { searchBm25, buildIndexFromDb } from "../src/retrieve/bm25";
import { unionIds } from "../src/retrieve/union";
import { shouldAbstainPreGeneration, combineAbstention, ABSTAIN_ANSWER } from "../src/abstain";
import { readFileSync } from "node:fs";

// Set this from calibrate-abstain.ts output. Default = the guardrail value.
const THRESHOLD = 5.0;

type InQ = { id: string; tag: string; q: string; hint: string };
type OffQ = { id: string; q: string; reason: string };
const inScope: InQ[] = JSON.parse(readFileSync("evals/queries-d2.json", "utf8"));
const offScope: OffQ[] = JSON.parse(readFileSync("evals/queries-offcorpus.json", "utf8"));

const db = openDb();
const embedder = new Embedder(db);
const reranker = new Reranker(db);
const generator = new Generator(db);
const bm25 = buildIndexFromDb(db);
const getChunk = db.prepare("SELECT text, heading_path, content_hash FROM chunks WHERE id = ?");

async function runQuery(query: string): Promise<{
  abstained: boolean;
  reason: string;
  topScore: number;
  answer: string;
}> {
  const vec = searchVectors(await embedder.embedQuery(query), db, 10);
  const bm = searchBm25(query, bm25, 10);
  const ids = unionIds(vec, bm);

  const scored = [];
  for (const id of ids) {
    const row = getChunk.get(id) as { text: string; heading_path: string; content_hash: string };
    const score = await reranker.score(query, { id, contentHash: row.content_hash, text: row.text });
    scored.push({ id, row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0]?.score ?? 0;

  const pre = shouldAbstainPreGeneration(topScore, THRESHOLD);
  if (pre.abstained) {
    return { abstained: true, reason: "pre-gate", topScore, answer: ABSTAIN_ANSWER };
  }

  const top5 = scored.slice(0, 5).map((c) => ({
    id: c.id,
    headingPath: JSON.parse(c.row.heading_path) as string[],
    text: c.row.text,
  }));
  const gen = await generator.generate(query, top5);
  const decision = combineAbstention(pre, gen.abstained);

  return {
    abstained: decision.abstained,
    reason: decision.reason,
    topScore,
    answer: gen.answer,
  };
}

console.log("=== IN-SCOPE (should NOT abstain) ===");
let inAbstained = 0;
for (const q of inScope) {
  const r = await runQuery(q.q);
  const flag = r.abstained ? "❌ ABSTAINED" : "✅";
  if (r.abstained) inAbstained++;
  console.log(`${flag} ${q.id}  top=${r.topScore}  (${r.abstained ? r.reason : "answered"})`);
}

console.log("\n=== OFF-SCOPE (should ALL abstain) ===");
let offAbstained = 0;
for (const q of offScope) {
  const r = await runQuery(q.q);
  const flag = r.abstained ? "✅ ABSTAINED" : "❌ ANSWERED";
  if (r.abstained) offAbstained++;
  console.log(`${flag} ${q.id}  top=${r.topScore}  ${r.abstained ? "" : `answer="${r.answer.slice(0, 80)}…"`}`);
}

console.log(`\n== metrics ==`);
console.log(`  threshold:              ${THRESHOLD}`);
console.log(`  off-scope abstention:   ${offAbstained}/10  (target 10/10)`);
console.log(`  in-scope false abstain: ${inAbstained}/20 (target ≤1)`);
console.log(`  reranker API calls:     ${reranker.callsMade}  cached: ${reranker.callsCached}`);
console.log(`  generator API calls:    ${generator.callsMade} cached: ${generator.callsCached}`);

const pass = offAbstained === 10 && inAbstained <= 1;
console.log(`\nD6 success criterion: off=10/10 AND in≤1`);
console.log(`  ${pass ? "PASS" : "FAIL"}`);
if (!pass) {
  console.log(`  → If off < 10: lower threshold (currently ${THRESHOLD}, try ${THRESHOLD - 1}).`);
  console.log(`  → If in > 1: raise threshold (try ${THRESHOLD + 1}).`);
  console.log(`  → If both fail: overlap exists — choose which error to accept (recommend keeping in-scope low).`);
}