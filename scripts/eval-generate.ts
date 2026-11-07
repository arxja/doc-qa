// Pipeline + generation on the 20-query set.
// Structural checks only (does every answer have citations? are all cited [n] valid?).
// Faithfulness (does cited chunk support claim?) is D7.
//
// Metrics:
//   citation_compliance = fraction of answers with ≥1 valid citation (or abstained)
//   invalid_index_rate  = fraction with [n] out of range
//   abstain_rate        = fraction of in-scope queries that abstained (should be near 0)

import { openDb } from "../src/db";
import { Embedder } from "../src/embed";
import { Generator } from "../src/generate";
import { Reranker } from "../src/retrieve/rerank";
import { searchVectors } from "../src/retrieve/vector";
import { searchBm25, buildIndexFromDb } from "../src/retrieve/bm25";
import { unionIds } from "../src/retrieve/union";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

type Q = { id: string; tag: string; q: string; hint: string };
const queries: Q[] = JSON.parse(readFileSync("evals/queries-d2.json", "utf8"));

const db = openDb();
const embedder = new Embedder(db);
const reranker = new Reranker(db);
const generator = new Generator(db);
const bm25 = buildIndexFromDb(db);
const getChunk = db.prepare(
  "SELECT text, heading_path, content_hash FROM chunks WHERE id = ?",
);

type Row = {
  id: string;
  tag: string;
  query: string;
  answer: string;
  citations: Array<{ n: number; chunkId: string; headingPath: string[] }>;
  abstained: boolean;
  citedIndices: number[];
  uncitedIndices: number[];
  invalidIndices: number[];
};
const rows: Row[] = [];

for (const q of queries) {
  const vec = searchVectors(await embedder.embedQuery(q.q), db, 10);
  const bm = searchBm25(q.q, bm25, 10);
  const ids = unionIds(vec, bm);

  const scored = [];
  for (const id of ids) {
    const row = getChunk.get(id) as {
      text: string;
      heading_path: string;
      content_hash: string;
    };
    const score = await reranker.score(q.q, {
      id,
      contentHash: row.content_hash,
      text: row.text,
    });
    scored.push({ id, row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top5 = scored.slice(0, 5).map((c) => ({
    id: c.id,
    headingPath: JSON.parse(c.row.heading_path) as string[],
    text: c.row.text,
  }));

  const result = await generator.generate(q.q, top5);
  rows.push({
    id: q.id,
    tag: q.tag,
    query: q.q,
    answer: result.answer,
    citations: result.citations.map((c) => ({
      n: c.n,
      chunkId: c.chunkId,
      headingPath: c.headingPath,
    })),
    abstained: result.abstained,
    citedIndices: result.citedIndices,
    uncitedIndices: result.uncitedIndices,
    invalidIndices: result.invalidIndices,
  });

  const status = result.abstained
    ? "🟡 ABSTAINED"
    : result.invalidIndices.length > 0
      ? "❌ BAD_CITE"
      : result.citations.length === 0
        ? "❌ NO_CITE"
        : "✅";
  console.log(
    `${status} ${q.id} (${q.tag.padEnd(10)}) cites=[${result.citedIndices.join(",")}] answer="${result.answer.replace(/\s+/g, " ").slice(0, 90)}…"`,
  );
}

// Structural metrics
const n = rows.length;
const compliant = rows.filter(
  (r) =>
    r.abstained || (r.citations.length > 0 && r.invalidIndices.length === 0),
).length;
const abstained = rows.filter((r) => r.abstained).length;
const withInvalid = rows.filter((r) => r.invalidIndices.length > 0).length;
const withNoCite = rows.filter(
  (r) => !r.abstained && r.citations.length === 0,
).length;

console.log(`\n== structural metrics (n=${n}) ==`);
console.log(
  `  citation_compliance: ${compliant}/${n} = ${((compliant / n) * 100).toFixed(1)}%`,
);
console.log(
  `  abstained:           ${abstained}/${n}  (should be near 0 — these are in-scope)`.replace(
    "near 0",
    `target ≤1`,
  ),
);
console.log(`  invalid citations:   ${withInvalid}/${n}  (out-of-range [n])`);
console.log(
  `  no citations:        ${withNoCite}/${n}  (answered but cited nothing)`,
);
console.log(
  `  generator API calls: ${generator.callsMade}, cached: ${generator.callsCached}`,
);

mkdirSync("data/d5", { recursive: true });
writeFileSync("data/d5/answers.json", JSON.stringify(rows, null, 2));
console.log(
  `\nWrote 20 answers -> data/d5/answers.json  (open and eyeball each one for correctness)`,
);

console.log(
  `\nD5 success criterion: citation_compliance ≥ 90% AND abstained ≤ 1 (since all in-scope)`,
);
const pass = compliant >= Math.ceil(0.9 * n) && abstained <= 1;
console.log(`  ${pass ? "PASS" : "FAIL"}`);
