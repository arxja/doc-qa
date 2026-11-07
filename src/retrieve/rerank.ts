// Pointwise LLM reranker. One (query, chunk) call per candidate, score 0-10.
// Cached by sha256(query || "\x00" || chunk_content_hash) so re-runs are free.
// Rate-limited for free-tier Gemini flash (~10 RPM).

import { GoogleGenAI, Type } from "@google/genai";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

const MODEL = "gemini-3.5-flash-lite";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Sliding-window limiter — matches Google's actual quota semantics.
// Token bucket models "sustainable rate"; Google enforces "N calls per
// rolling 60s." Different constraint, different structure.
//
// maxCalls = 8 (safety margin under the 10 RPM free-tier cap — other
// traffic on the same API key shares the budget).

class SlidingWindowLimiter {
  private timestamps: number[] = [];
  constructor(
    private maxCalls: number,
    private windowMs: number,
  ) {}

  async take(): Promise<void> {
    while (true) {
      const now = Date.now();
      while (
        this.timestamps.length > 0 &&
        this.timestamps[0]! <= now - this.windowMs
      ) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < this.maxCalls) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = this.timestamps[0]! + this.windowMs - now + 100;
      await sleep(waitMs);
    }
  }
}

const bucket = new SlidingWindowLimiter(12, 60_000);

// Retry on 429. Parses the RetryInfo detail from Google's error body
// when available — that gives the exact wait time instead of a guess.

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 5;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status;
      if (status !== 429 || i === maxAttempts - 1) throw err;

      let waitMs = 2 ** i * 1000 + Math.random() * 500;
      try {
        const body = JSON.parse(
          String(err.message).match(/\{[\s\S]*\}/)?.[0] ?? "{}",
        );
        const retryInfo = body?.error?.details?.find((d: any) =>
          d["@type"]?.includes("RetryInfo"),
        );
        if (retryInfo?.retryDelay) {
          waitMs = parseInt(retryInfo.retryDelay, 10) * 1000 + 500;
        }
      } catch {
        /* fall back to exponential */
      }

      console.warn(
        `[rerank] ${label} 429; retry ${i + 1}/${maxAttempts - 1} in ${Math.round(waitMs)}ms`,
      );
      await sleep(waitMs);
    }
  }
  throw new Error("unreachable");
}

const PROMPT = (
  query: string,
  chunk: string,
) => `You are ranking search results for a documentation Q&A system.
Score how well the chunk answers the query, on an integer 0-10 scale:

10: the chunk directly and completely answers the query
7-9: the chunk contains the answer but requires minor inference
4-6: the chunk is topically related but does not answer the query
1-3: the chunk shares keywords but is not useful
0: the chunk is irrelevant

Query:
${query}

Chunk:
${chunk}`;

export class Reranker {
  private ai: GoogleGenAI;
  private getCache: ReturnType<Database["prepare"]>;
  private putCache: ReturnType<Database["prepare"]>;
  public callsMade = 0;
  public callsCached = 0;

  constructor(
    private db: Database,
    apiKey = process.env.GEMINI_API_KEY,
  ) {
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    this.ai = new GoogleGenAI({ apiKey });
    this.getCache = db.prepare("SELECT score FROM rerank_cache WHERE key = ?");
    this.putCache = db.prepare(
      "INSERT OR REPLACE INTO rerank_cache (key, score, created_at) VALUES (?, ?, ?)",
    );
  }

  async score(
    query: string,
    chunk: { id: string; contentHash: string; text: string },
  ): Promise<number> {
    const key = createHash("sha256")
      .update(query, "utf8")
      .update("\x00")
      .update(chunk.contentHash, "utf8")
      .digest("hex");

    const cached = this.getCache.get(key) as { score: number } | undefined;
    if (cached) {
      this.callsCached++;
      return cached.score;
    }

    await bucket.take();
    const res = await withRetry(() =>
      this.ai.models.generateContent({
        model: MODEL,
        contents: PROMPT(query, chunk.text),
        config: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              score: { type: Type.INTEGER, minimum: 0, maximum: 10 },
            },
            required: ["score"],
          },
        },
      }), "score"
    );
    this.callsMade++;
    const parsed = JSON.parse(res.text ?? "{}") as { score?: number };
    const score = Math.max(0, Math.min(10, Math.round(parsed.score ?? 0)));
    this.putCache.run(key, score, Date.now());
    return score;
  }
}
