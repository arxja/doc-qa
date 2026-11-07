// Full pipeline: query -> { answer, citations, abstained, timings }.
// Thin composition of D4 retrieval+rerank, D5 generation, D6 abstention.
// Reusable from any caller (CLI, server, future eval scripts).

import type { Database } from "bun:sqlite";
import type { Embedder } from "./embed";
import type { Reranker } from "./retrieve/rerank";
import type { Generator } from "./generate";
import type { Bm25Index } from "./retrieve/bm25";
import { searchVectors } from "./retrieve/vector";
import { searchBm25 } from "./retrieve/bm25";
import { unionIds } from "./retrieve/union";
import {
  shouldAbstainPreGeneration,
  combineAbstention,
  ABSTAIN_ANSWER,
} from "./abstain";

const ABSTAIN_THRESHOLD = 5.0;
const TOP_K_RETRIEVE = 10;
const TOP_K_GENERATE = 5;

export type PipelineResult = {
  query: string;
  answer: string;
  abstained: boolean;
  abstainReason: "pre-gate" | "post-generator" | null;
  topScore: number;
  candidates: Array<{ id: string; headingPath: string[]; score: number }>;
  citations: Array<{
    n: number;
    chunkId: string;
    headingPath: string[];
    text: string;
  }>;
  timings: {
    retrieve: number;
    rerank: number;
    generate: number;
    total: number;
  };
};

export async function runPipeline(
  query: string,
  db: Database,
  embedder: Embedder,
  reranker: Reranker,
  generator: Generator,
  bm25: Bm25Index,
): Promise<PipelineResult> {
  const t0 = performance.now();

  const qv = await embedder.embedQuery(query);
  const vec = searchVectors(qv, db, TOP_K_RETRIEVE);
  const bm = searchBm25(query, bm25, TOP_K_RETRIEVE);
  const ids = unionIds(vec, bm);
  const tRetrieve = performance.now() - t0;

  const getChunk = db.prepare(
    "SELECT text, heading_path, content_hash FROM chunks WHERE id = ?",
  );
  const t1 = performance.now();
  const scored: Array<{
    id: string;
    headingPath: string[];
    text: string;
    score: number;
  }> = [];
  for (const id of ids) {
    const row = getChunk.get(id) as {
      text: string;
      heading_path: string;
      content_hash: string;
    };
    const score = await reranker.score(query, {
      id,
      contentHash: row.content_hash,
      text: row.text,
    });
    scored.push({
      id,
      headingPath: JSON.parse(row.heading_path) as string[],
      text: row.text,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const tRerank = performance.now() - t1;

  const topScore = scored[0]?.score ?? 0;
  const candidates = scored.slice(0, TOP_K_GENERATE).map((c) => ({
    id: c.id,
    headingPath: c.headingPath,
    score: c.score,
  }));

  const pre = shouldAbstainPreGeneration(topScore, ABSTAIN_THRESHOLD);
  if (pre.abstained) {
    return {
      query,
      answer: ABSTAIN_ANSWER,
      abstained: true,
      abstainReason: "pre-gate",
      topScore,
      candidates,
      citations: [],
      timings: {
        retrieve: tRetrieve,
        rerank: tRerank,
        generate: 0,
        total: performance.now() - t0,
      },
    };
  }

  const t2 = performance.now();
  const top5 = scored.slice(0, TOP_K_GENERATE).map((c) => ({
    id: c.id,
    headingPath: c.headingPath,
    text: c.text,
  }));
  const gen = await generator.generate(query, top5);
  const decision = combineAbstention(pre, gen.abstained);
  const tGen = performance.now() - t2;

  return {
    query,
    answer: gen.answer,
    abstained: decision.abstained,
    abstainReason:
      decision.abstained && decision.reason !== "none" ? decision.reason : null,
    topScore,
    candidates,
    citations: gen.citations,
    timings: {
      retrieve: tRetrieve,
      rerank: tRerank,
      generate: tGen,
      total: performance.now() - t0,
    },
  };
}
