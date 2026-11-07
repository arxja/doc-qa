// Reciprocal Rank Fusion — combines N ranked lists into one.
//
// score(d) = Σ over lists L containing d:  1 / (k + rank_L(d))
//
// Why not average scores: cosine ∈ [0,1] vs BM25 ∈ [0,~15] are incomparable.
// RRF works on RANKS (scale-free). k=60 dampens rank differences so that
// "appears in multiple lists" beats "top of one list" — that's the point.
//
// k=60 from Cormack, Clarke, Buettcher (2009). The exact value is
// conventional; anything in [10, 100] behaves similarly. Don't tune k first.
//
// EXPERIMENTAL — NOT WIRED INTO THE PIPELINE.
//
// Tested (2026-11-07) as the standard BM25+vector fusion step
// (Reciprocal Rank Fusion, k=60, equal weights).
//
// Result on the 20-query eval set:
//   vector alone: hit@1 = 70.0%, MRR = 0.842
//   bm25   alone: hit@1 = 80.0%, MRR = 0.850
//   hybrid       : hit@1 = 70.0%, MRR = 0.820  ← no lift, MRR regression
//
// Cause: RRF compresses rank differences (k=60 makes rank 1 ≈ rank 2),
// so when the two retrievers disagree — which is exactly the case where
// one of them is right and the other is noise — the tie is broken by
// insertion order, not by quality. Equal weights pull the stronger
// retriever toward the weaker.
//
// Decision: deferred to union + cross-encoder rerank. The retrievers
// become candidate generators; the reranker becomes the decision-maker.
// Retained here as a reference for future fusion experiments.

export type Ranked = { id: string };
export type Fused = { id: string; rrf: number; sources: string[] };

export function rrfFuse(
  rankings: Array<{ name: string; hits: Ranked[] }>,
  k = 60,
): Fused[] {
  const acc = new Map<string, { rrf: number; sources: string[] }>();

  for (const { name, hits } of rankings) {
    for (let i = 0; i < hits.length; i++) {
      const id = hits[i].id;
      const contribution = 1 / (k + i + 1); // rank is 1-indexed
      const cur = acc.get(id);
      if (cur) {
        cur.rrf += contribution;
        if (!cur.sources.includes(name)) cur.sources.push(name);
      } else {
        acc.set(id, { rrf: contribution, sources: [name] });
      }
    }
  }

  return [...acc.entries()]
    .map(([id, v]) => ({ id, rrf: v.rrf, sources: v.sources }))
    .sort((a, b) => b.rrf - a.rrf);
}
