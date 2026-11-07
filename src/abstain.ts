// Abstention logic. Two checks, OR'd:
//   1. Pre-generation gate — top reranker score below threshold => abstain.
//   2. Post-generation check — generator returned the abstain phrase => abstain.
//
// Threshold is calibrated on the in-scope eval set (see scripts/calibrate-abstain.ts).
// Do NOT hardcode a universal number — reranker scores are model-specific.

export const ABSTAIN_ANSWER = "I couldn't find this in the documentation.";

export type AbstentionDecision = {
  abstained: boolean;
  reason: "pre-gate" | "post-generator" | "none";
  topScore: number;
  threshold: number;
};

export function shouldAbstainPreGeneration(
  topScore: number,
  threshold: number,
): AbstentionDecision {
  const abstained = topScore < threshold;
  return {
    abstained,
    reason: abstained ? "pre-gate" : "none",
    topScore,
    threshold,
  };
}

export function combineAbstention(
  pre: AbstentionDecision,
  generatorAbstained: boolean,
): AbstentionDecision {
  if (pre.abstained) return pre;
  if (generatorAbstained) {
    return { ...pre, abstained: true, reason: "post-generator" };
  }
  return pre;
}
