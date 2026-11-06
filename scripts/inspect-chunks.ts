import { loadCorpus } from "../src/ingest/fetch";
import { chunkMarkdown } from "../src/ingest/chunk";

const docs = await loadCorpus();
const all = docs.flatMap((d) => chunkMarkdown(d));

if (all.length === 0) {
  console.error("No chunks. Did data/corpus/*.md exist?");
  process.exit(1);
}

const toks = all.map((c) => c.approxTokens).sort((a, b) => a - b);
const avg = Math.round(toks.reduce((s, t) => s + t, 0) / toks.length);
console.log(
  `docs=${docs.length}  chunks=${all.length}  tokens min=${toks[0]} p50=${toks[Math.floor(toks.length / 2)]} p95=${toks[Math.floor(toks.length * 0.95)]} max=${toks[toks.length - 1]} avg=${avg}`,
);

const sample = [...all].sort(() => Math.random() - 0.5).slice(0, 10);
const json = process.argv.includes("--json");
for (const c of sample) {
  console.log("\n" + "─".repeat(64));
  console.log(
    `id=${c.id}  tokens≈${c.approxTokens}  path=${c.headingPath.join(" > ")}`,
  );
  console.log("─".repeat(64));
  console.log(json ? JSON.stringify(c.text) : c.text);
}
