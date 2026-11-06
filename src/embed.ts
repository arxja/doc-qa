// Embedding client. Three concerns folded in here, each small:
//   1. Rate limiting   — token bucket (RPM & RPD aware)
//   2. Caching         — sha256(text) -> vector, skip API if present
//   3. Retry/backoff   — 429 -> exponential backoff with jitter
//
// Batch-first: send up to 100 contents per request. Fall back to singles
// on 429 (known free-tier batch quota quirk).

import { GoogleGenAI } from "@google/genai";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { blobToVector, EMBEDDING_DIMS } from "./db";

export const EMBED_MODEL = "gemini-embedding-001";
const BATCH_LIMIT = 100;

// ---------------------------------------------------------------------------
// Token bucket rate limiter (RPM = 100, RPD = 1000 for free tier).
// We only enforce RPM here — RPD is a daily wall, so backoff on 429 is enough.
// ---------------------------------------------------------------------------
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  constructor(
    private capacity: number,
    private refillPerMs: number,
  ) {
    this.tokens = capacity;
  }
  async take(cost = 1): Promise<void> {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return;
    }
    const need = cost - this.tokens;
    const waitMs = Math.ceil(need / this.refillPerMs);
    await sleep(waitMs);
    this.refill();
    this.tokens -= cost;
  }
  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsed * this.refillPerMs,
    );
    this.lastRefill = now;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 100 RPM = 100/60/1000 tokens per ms
const rpmBucket = new TokenBucket(100, 100 / 60_000);

// ---------------------------------------------------------------------------
// Retry with exponential backoff + jitter.
// ---------------------------------------------------------------------------
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === maxAttempts - 1) throw err;
      const backoff = 2 ** attempt * 1000 + Math.random() * 500;
      console.warn(
        `[embed] ${label} failed (${status}); retry ${attempt + 1}/${maxAttempts - 1} in ${Math.round(backoff)}ms`,
      );
      await sleep(backoff);
    }
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// The public embedder.
// ---------------------------------------------------------------------------
export class Embedder {
  private ai: GoogleGenAI;
  private getCache: ReturnType<Database["prepare"]>;
  private putCache: ReturnType<Database["prepare"]>;

  constructor(
    private db: Database,
    apiKey = process.env.GEMINI_API_KEY,
  ) {
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    this.ai = new GoogleGenAI({ apiKey });
    this.getCache = db.prepare(
      "SELECT vector FROM embedding_cache WHERE content_hash = ?",
    );
    this.putCache = db.prepare(
      "INSERT OR REPLACE INTO embedding_cache (content_hash, vector, dims, created_at) VALUES (?, ?, ?, ?)",
    );
  }

  async embedTexts(
    texts: string[],
  ): Promise<{ vectors: Float32Array[]; cached: number; embedded: number }> {
    const hashes = texts.map((t) => sha256(t));
    const results: (Float32Array | null)[] = new Array(texts.length).fill(null);

    // 1. Cache hits
    for (let i = 0; i < texts.length; i++) {
      const row = this.getCache.get(hashes[i]!) as
        | { vector: Uint8Array }
        | undefined;
      if (row) results[i] = blobToVector(row.vector);
    }

    // 2. Misses -> batch embed
    const missIdx = results.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    if (missIdx.length === 0) {
      console.log(
        `[embed] ${texts.length}/${texts.length} cache hits, no API call`,
      );
      return {
        vectors: results as Float32Array[],
        cached: texts.length,
        embedded: 0,
      };
    }

    console.log(
      `[embed] ${texts.length - missIdx.length} cache hits, ${missIdx.length} misses -> API`,
    );
    const missTexts = missIdx.map((i) => texts[i]!);

    for (let start = 0; start < missTexts.length; start += BATCH_LIMIT) {
      const batch = missTexts.slice(start, start + BATCH_LIMIT);
      await rpmBucket.take(1);
      const vectors = await this.embedBatchWithFallback(batch);
      for (let j = 0; j < batch.length; j++) {
        const globalIdx = missIdx[start + j]!;
        results[globalIdx] = vectors[j]!;
        this.putCache.run(
          hashes[globalIdx]!,
          new Uint8Array(vectors[j]!.buffer),
          EMBEDDING_DIMS,
          Date.now(),
        );
      }
    }
    return {
      vectors: results as Float32Array[],
      cached: texts.length - missIdx.length,
      embedded: missIdx.length,
    };
  }

  private async embedBatchWithFallback(
    batch: string[],
  ): Promise<Float32Array[]> {
    try {
      const res = await withRetry(
        () =>
          this.ai.models.embedContent({
            model: EMBED_MODEL,
            contents: batch,
            config: {
              outputDimensionality: EMBEDDING_DIMS,
              taskType: "RETRIEVAL_DOCUMENT",
            },
          }),
        "batch",
      );
      return res.embeddings!.map((e) => new Float32Array(e.values!));
    } catch (err: any) {
      if (batch.length === 1) throw err;
      console.warn(
        `[embed] batch of ${batch.length} failed (${err?.status}); falling back to singles`,
      );
      const out: Float32Array[] = [];
      for (const t of batch) {
        await rpmBucket.take(1);
        const res = await withRetry(
          () =>
            this.ai.models.embedContent({
              model: EMBED_MODEL,
              contents: t,
              config: {
                outputDimensionality: EMBEDDING_DIMS,
                taskType: "RETRIEVAL_DOCUMENT",
              },
            }),
          "single",
        );
        out.push(new Float32Array(res.embeddings![0]!.values!));
      }
      return out;
    }
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
