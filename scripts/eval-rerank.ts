import { openDb } from "../src/db";
import { Embedder } from "../src/embed";
import { Reranker } from "../src/retrieve/rerank";
import { searchVectors } from "../src/retrieve/vector";
import { searchBm25, buildIndexFromDb } from "../src/retrieve/bm25";
import { unionIds } from "../src/retrieve/union";
import { readFileSync } from "node:fs";

type Q = { id: string; tag: string; q: string; hint: string };
const queries: Q[] = JSON.parse(readFileSync("evals/queries-d2.json", "utf8"));

const db = openDb();
const embedder = new Embedder(db);
const reranker = new Reranker(db);
const bm25 = buildIndexFromDb(db);
const contentHashStmt = db.prepare(
  "SELECT content_hash FROM chunks WHERE id = ?",
);

type QV = Float32Array;
const qvCache = new Map<string, QV>();
async function qv(text: string): Promise<QV> {
  let v = qvCache.get(text);
  if (!v) {
    v = await embedder.embedQuery(text);
    qvCache.set(text, v);
  }
  return v;
}

let h1Vec = 0,
  h1Bm = 0,
  h1Union = 0,
  h1Rr = 0;
let sumRR = 0;

const getChunk = db.prepare(
  "SELECT text, content_hash FROM chunks WHERE id = ?",
);

for (const q of queries) {
  const hints = q.hint.split(" or ").map((s) => s.trim());

  const vec = searchVectors(await qv(q.q), db, 10);
  const bm = searchBm25(q.q, bm25, 10);
  const ids = unionIds(vec, bm);

  const candidates = ids.map((id) => {
    const row = getChunk.get(id) as { text: string; content_hash: string };
    return { id, text: row.text, contentHash: row.content_hash };
  });

  const candRanked = candidates
    .map((c) => {
      const vR = vec.findIndex((v) => v.id === c.id);
      const bR = bm.findIndex((b) => b.id === c.id);
      const best = Math.min(vR === -1 ? 999 : vR, bR === -1 ? 999 : bR);
      return { id: c.id, best };
    })
    .sort((a, b) => a.best - b.best)
    .map((x) => x.id);

  const scored: Array<{ id: string; score: number }> = [];
  for (const c of candidates) {
    scored.push({ id: c.id, score: await reranker.score(q.q, c) });
  }
  scored.sort((a, b) => b.score - a.score);
  const rerankRanked = scored.map((s) => s.id);

  const vRank = vec.findIndex((r) => hints.includes(r.id)) + 1 || null;
  const bRank = bm.findIndex((r) => hints.includes(r.id)) + 1 || null;
  const uRank = candRanked.findIndex((id) => hints.includes(id)) + 1 || null;
  const rRank = rerankRanked.findIndex((id) => hints.includes(id)) + 1 || null;

  if (vRank === 1) h1Vec++;
  if (bRank === 1) h1Bm++;
  if (uRank === 1) h1Union++;
  if (rRank === 1) h1Rr++;
  if (rRank !== null) sumRR += 1 / rRank;

  const flag = rRank === 1 ? "✅" : rRank && rRank <= 10 ? "🟡" : "❌";
  console.log(
    `${flag} ${q.id} (${q.tag.padEnd(10)}) v=${vRank ?? "—"} b=${bRank ?? "—"} u=${uRank ?? "—"} → rr=#${rRank ?? "—"}  (top1=${rerankRanked[0]}, expected=${q.hint})`,
  );
}
const n = queries.length;
console.log(`\n== comparison (n=${n}) ==`);
console.log(
  `  vector hit@1:  ${h1Vec}/${n} (${((h1Vec / n) * 100).toFixed(1)}%)`,
);
console.log(
  `  bm25   hit@1:  ${h1Bm}/${n} (${((h1Bm / n) * 100).toFixed(1)}%)`,
);
console.log(
  `  union  hit@1:  ${h1Union}/${n} (${((h1Union / n) * 100).toFixed(1)}%)   [no rerank, best-rank order]`,
);
console.log(
  `  rerank hit@1:  ${h1Rr}/${n} (${((h1Rr / n) * 100).toFixed(1)}%)   MRR=${(sumRR / n).toFixed(3)}`,
);
console.log(
  `  rerank calls:  ${reranker.callsMade} API, ${reranker.callsCached} cached`,
);
console.log(`\nD4 success criterion: rerank hit@1 ≥ 90% (≥18/${n})`);
console.log(
  `  ${h1Rr >= Math.ceil(0.9 * n) ? "PASS" : "FAIL — reranker didn't earn its keep"}`,
);
