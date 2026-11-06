import { openDb } from "../src/db";
import { Embedder } from "../src/embed";
import { searchVectors } from "../src/retrieve/vector";
import { readFileSync } from "node:fs";

type Q = { id: string; tag: string; q: string; hint: string };
const queries: Q[] = JSON.parse(readFileSync("evals/queries-d2.json", "utf8"));
const db = openDb();
const embedder = new Embedder(db);

type Hit = { id: string; tag: string; rank: number | null };

const hits: Hit[] = [];
let sumRR = 0;

for (const q of queries) {
  const qv = await embedder.embedQuery(q.q);
  const results = searchVectors(qv, db, 10);
  const hintIds = q.hint.split(" or ").map((s) => s.trim());
  const rank = results.findIndex((r) => hintIds.includes(r.id));
  const rankNum = rank >= 0 ? rank + 1 : null;
  hits.push({ id: q.id, tag: q.tag, rank: rankNum });
  if (rankNum !== null) sumRR += 1 / rankNum;

  const flag = rankNum === 1 ? "✅" : rankNum && rankNum <= 10 ? "🟡" : "❌";
  const top1 = results[0];
  const rankStr = rankNum === null ? "—" : `#${rankNum}`;
  console.log(
    `${flag} ${q.id} (${q.tag.padEnd(10)}) top1=${top1.id.padEnd(18)} (${top1.score.toFixed(3)})  rank=${rankStr}  expected=${q.hint}`,
  );
}

const n = queries.length;
const at = (k: number) =>
  hits.filter((h) => h.rank !== null && h.rank <= k).length;
console.log(`\n== retrieval metrics (n=${n}) ==`);
console.log(`  hit@1 : ${at(1)}/${n} = ${((at(1) / n) * 100).toFixed(1)}%`);
console.log(`  hit@3 : ${at(3)}/${n} = ${((at(3) / n) * 100).toFixed(1)}%`);
console.log(`  hit@5 : ${at(5)}/${n} = ${((at(5) / n) * 100).toFixed(1)}%`);
console.log(`  hit@10: ${at(10)}/${n} = ${((at(10) / n) * 100).toFixed(1)}%`);
console.log(`  MRR   : ${(sumRR / n).toFixed(3)}`);

const byTag: Record<string, { n: number; at1: number; rr: number }> = {};
for (const h of hits) {
  byTag[h.tag] ??= { n: 0, at1: 0, rr: 0 };
  byTag[h.tag].n++;
  if (h.rank === 1) byTag[h.tag].at1++;
  if (h.rank !== null) byTag[h.tag].rr += 1 / h.rank;
}
console.log(`\n== by tag ==`);
for (const [tag, s] of Object.entries(byTag).sort()) {
  console.log(
    `  ${tag.padEnd(12)} hit@1=${s.at1}/${s.n}  MRR=${(s.rr / s.n).toFixed(3)}`,
  );
}
