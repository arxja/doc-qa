// For each answer, extract claims, check each cited chunk, aggregate.
// Metric: faithfulness = (supported + 0.5*partial) / total_claims. Target ≥ 0.9.

import { openDb } from "../src/db";
import {
  FaithfulnessChecker,
  extractClaims,
  type Verdict,
} from "../src/faithfulness";
import { readFileSync } from "node:fs";

type Citation = { n: number; chunkId: string };
type AnswerRow = {
  id: string;
  tag: string;
  query: string;
  answer: string;
  citations: Citation[];
  abstained: boolean;
};

const answers: AnswerRow[] = JSON.parse(
  readFileSync("data/d5/answers.json", "utf8"),
);
const db = openDb();
const checker = new FaithfulnessChecker(db);
const getChunkText = db.prepare("SELECT text FROM chunks WHERE id = ?");

let totalClaims = 0;
let supported = 0;
let partial = 0;
let unsupported = 0;

for (const row of answers) {
  if (row.abstained) {
    console.log(`⏭  ${row.id}  (abstained — no claims to check)`);
    continue;
  }

  const claims = extractClaims(row.answer);
  if (claims.length === 0) {
    console.log(`⚠️  ${row.id}  (no claims — answer has no citations?)`);
    continue;
  }

  const citationByIdx = new Map<number, string>();
  for (const c of row.citations) citationByIdx.set(c.n, c.chunkId);

  console.log(`\n${row.id} (${row.tag})  claims=${claims.length}`);
  let rowSupported = 0,
    rowPartial = 0,
    rowUnsupported = 0;

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i]!;
    const verdicts: Verdict[] = [];

    for (const n of claim.citedIndices) {
      const chunkId = citationByIdx.get(n);
      if (!chunkId) {
        console.log(
          `   ⚠️ claim ${i + 1}: citation [${n}] not in answers.json — parser bug`,
        );
        verdicts.push("unsupported");
        continue;
      }
      const chunkRow = getChunkText.get(chunkId) as
        | { text: string }
        | undefined;
      if (!chunkRow) {
        console.log(`   ⚠️ claim ${i + 1}: chunk ${chunkId} not in DB`);
        verdicts.push("unsupported");
        continue;
      }
      const res = await checker.check(claim.text, chunkRow.text);
      verdicts.push(res.verdict);
    }

    // Claim-level verdict: best of the per-chunk verdicts.
    // Any SUPPORTED → claim is SUPPORTED (over-citation is allowed).
    // Else any PARTIAL → claim is PARTIAL.
    // Else UNSUPPORTED.
    const claimVerdict: Verdict = verdicts.includes("supported")
      ? "supported"
      : verdicts.includes("partial")
        ? "partial"
        : "unsupported";

    if (claimVerdict === "supported") {
      supported++;
      rowSupported++;
    } else if (claimVerdict === "partial") {
      partial++;
      rowPartial++;
    } else {
      unsupported++;
      rowUnsupported++;
    }
    totalClaims++;

    const icon =
      claimVerdict === "supported"
        ? "✅"
        : claimVerdict === "partial"
          ? "🟡"
          : "❌";
    console.log(
      `   ${icon} claim ${i + 1}: ${claimVerdict.toUpperCase()}  cites=[${claim.citedIndices.join(",")}]  "${claim.text.slice(0, 80)}${claim.text.length > 80 ? "…" : ""}"`,
    );
  }
  console.log(
    `   → ${rowSupported}/${claims.length} supported, ${rowPartial} partial, ${rowUnsupported} unsupported`,
  );
}

const faithfulness =
  totalClaims > 0 ? (supported + 0.5 * partial) / totalClaims : 0;

console.log(`\n== faithfulness metrics ==`);
console.log(`  total claims:       ${totalClaims}`);
console.log(`  SUPPORTED:          ${supported}`);
console.log(`  PARTIAL:            ${partial}`);
console.log(`  UNSUPPORTED:        ${unsupported}`);
console.log(
  `  faithfulness score: ${faithfulness.toFixed(3)}  (target ≥ 0.900)`,
);
console.log(
  `  checker calls:      ${checker.callsMade}  cached: ${checker.callsCached}`,
);

console.log(`\nD7 success criterion: faithfulness ≥ 0.90`);
console.log(`  ${faithfulness >= 0.9 ? "PASS" : "FAIL"}`);
if (faithfulness < 0.9) {
  console.log(
    `  → Look at UNSUPPORTED claims above. Are they hallucinated facts, or citations to the wrong chunk?`,
  );
  console.log(
    `  → If citation to wrong chunk: retrieval/rerank issue (D4) — investigate those queries.`,
  );
  console.log(
    `  → If hallucinated fact: generation issue (D5) — tighten prompt or swap model.`,
  );
}
