import { ingestCorpus } from "../src/ingest";
import { openDb, blobToVector } from "../src/db";

const db = openDb();
const stats = await ingestCorpus(db);
console.log(`\n=== ingest complete ===`);
console.log(stats);

// Verification query 1: counts and vector sizes
const summary = db
  .query(
    `
  SELECT
    count(*)              AS chunks,
    count(DISTINCT doc_id) AS docs,
    min(length(embedding)) AS min_bytes,
    max(length(embedding)) AS max_bytes
  FROM chunks
`,
  )
  .get();
console.log("summary:", summary);

// Verification query 2: one full embedding decoded
const row = db
  .query(`SELECT id, text, embedding FROM chunks LIMIT 1`)
  .get() as any;
const vec = blobToVector(row.embedding);
console.log(
  `\nsample: id=${row.id}, dims=${vec.length}, first3=[${vec[0].toFixed(4)}, ${vec[1].toFixed(4)}, ${vec[2].toFixed(4)}]`,
);
console.log(`norm≈${Math.sqrt(vec.reduce((s, x) => s + x * x, 0)).toFixed(4)}`);
