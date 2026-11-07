// run vector, BM25, hybrid on the same 20 queries.
// Caches query embeddings (20 API calls total, not 60).
// Prints hit@1/3/5/10 + MRR per mode, then a comparison table.
// Pass/fail: hybrid lifts hit@1 by ≥5 points AND MRR by ≥0.03 vs vector.

import { openDb } from "../src/db";
import { Embedder } from "../src/embed";
import { searchVectors } from "../src/retrieve/vector";
import { searchBm25, buildIndexFromDb } from "../src/retrieve/bm25";
import { rrfFuse } from "../src/retrieve/hybrid";
import { readFileSync } from "node:fs";

type Q = { id: string; tag: string; q: string; hint: string };
const queries: Q[] = JSON.parse(readFileSync("evals/queries-d2.json", "utf8"));

const db = openDb();
const embedder = new Embedder(db);
const bm25 = buildIndexFromDb(db);

// Cache query embeddings (one per unique query string)
const qvCache = new Map<string, Float32Array>();
async function qv(text: string): Promise<Float32Array> {
  let v = qvCache.get(text);
  if (!v) {
    v = await embedder.embedQuery(text);
    qvCache.set(text, v);
  }
  return v;
}

type Mode = "vector" | "bm25" | "hybrid";
type PerQuery = {
  id: string;
  rank: number | null;
  top1: string;
  sources?: string[];
};
type Metrics = {
  hit1: number;
  hit3: number;
  hit5: number;
  hit10: number;
  mrr: number;
  n: number;
};

async function evaluate(
  mode: Mode,
): Promise<{ m: Metrics; perQuery: PerQuery[] }> {
  const perQuery: PerQuery[] = [];
  let h1 = 0,
    h3 = 0,
    h5 = 0,
    h10 = 0,
    sumRR = 0;

  for (const q of queries) {
    const hints = q.hint.split(" or ").map((s) => s.trim());
    let orderedIds: string[];
    let sources: string[] | undefined;

    if (mode === "vector") {
      orderedIds = searchVectors(await qv(q.q), db, 10).map((r) => r.id);
    } else if (mode === "bm25") {
      orderedIds = searchBm25(q.q, bm25, 10).map((r) => r.id);
    } else {
      const v = searchVectors(await qv(q.q), db, 20).map((r) => ({ id: r.id }));
      const b = searchBm25(q.q, bm25, 20).map((r) => ({ id: r.id }));
      const fused = rrfFuse([
        { name: "vector", hits: v },
        { name: "bm25", hits: b },
      ]);
      orderedIds = fused.slice(0, 10).map((f) => f.id);
      sources = fused.find((f) => f.id === orderedIds[0])?.sources;
    }

    const rankIdx = orderedIds.findIndex((id) => hints.includes(id));
    const rank = rankIdx >= 0 ? rankIdx + 1 : null;
    perQuery.push({ id: q.id, rank, top1: orderedIds[0], sources });

    if (rank === 1) h1++;
    if (rank !== null && rank <= 3) h3++;
    if (rank !== null && rank <= 5) h5++;
    if (rank !== null) {
      h10++;
      sumRR += 1 / rank;
    }
  }

  const n = queries.length;
  return {
    m: { hit1: h1, hit3: h3, hit5: h5, hit10: h10, mrr: sumRR / n, n },
    perQuery,
  };
}

const results: Record<Mode, { m: Metrics; perQuery: PerQuery[] }> = {
  vector: await evaluate("vector"),
  bm25: await evaluate("bm25"),
  hybrid: await evaluate("hybrid"),
};

for (const mode of ["vector", "bm25", "hybrid"] as Mode[]) {
  const { m, perQuery } = results[mode];
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  for (const p of perQuery) {
    const flag =
      p.rank === 1 ? "✅" : p.rank !== null && p.rank <= 10 ? "🟡" : "❌";
    const src = p.sources ? `  sources=${p.sources.join("+")}` : "";
    console.log(`${flag} ${p.id}  rank=${p.rank ?? "—"}  top1=${p.top1}${src}`);
  }
  const pct = (x: number) => ((x / m.n) * 100).toFixed(0) + "%";
  console.log(
    `  hit@1=${m.hit1}/${m.n} (${pct(m.hit1)})  hit@3=${m.hit3}/${m.n}  hit@5=${m.hit5}/${m.n}  hit@10=${m.hit10}/${m.n}  MRR=${m.mrr.toFixed(3)}`,
  );
}

const v = results.vector.m;
const h = results.hybrid.m;
const dHit1 = (h.hit1 - v.hit1) / v.n;
const dMRR = h.mrr - v.mrr;

console.log(`\n=== comparison ===`);
const pad = (s: string, w = 8) => s.padStart(w);
console.log(`metric    vector    bm25      hybrid`);
console.log(
  `hit@1     ${pad(((v.hit1 / v.n) * 100).toFixed(1) + "%")}   ${pad(((results.bm25.m.hit1 / v.n) * 100).toFixed(1) + "%")}    ${pad(((h.hit1 / h.n) * 100).toFixed(1) + "%")}`,
);
console.log(
  `MRR       ${pad(v.mrr.toFixed(3))}   ${pad(results.bm25.m.mrr.toFixed(3))}    ${pad(h.mrr.toFixed(3))}`,
);
console.log(
  `\nD3 success criterion: hybrid hit@1 ≥ vector +5pts AND hybrid MRR ≥ vector +0.03`,
);
console.log(
  `  Δ hit@1: ${(dHit1 * 100).toFixed(1)} pts   Δ MRR: ${dMRR.toFixed(3)}`,
);
console.log(
  `  ${dHit1 >= 0.05 && dMRR >= 0.03 ? "PASS — keep hybrid" : "FAIL — delete hybrid per blueprint"}`,
);
