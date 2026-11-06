import { openDb } from "../src/db";
import { Embedder } from "../src/embed";
import { searchVectors } from "../src/retrieve/vector";

const args = process.argv.slice(2);
const kFlag = args.indexOf("--k");
const k = kFlag >= 0 ? parseInt(args[kFlag + 1], 10) : 10;
const q = args
  .filter((a, i) => i !== kFlag && i !== kFlag + 1)
  .join(" ")
  .trim();

if (!q) {
  console.error('Usage: bun scripts/query.ts "your question" [--k 10]');
  process.exit(1);
}

const db = openDb();
const embedder = new Embedder(db);
const qv = await embedder.embedQuery(q);
const results = searchVectors(qv, db, k);

console.log(`\nQuery: ${q}\n`);
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  console.log(
    `${String(i + 1).padStart(2)}. [${r.score.toFixed(3)}] ${r.id}   (${r.headingPath.join(" > ")})`,
  );
  const preview = r.text.replace(/\s+/g, " ").slice(0, 140);
  console.log(`    ${preview}${r.text.length > 140 ? "…" : ""}\n`);
}
