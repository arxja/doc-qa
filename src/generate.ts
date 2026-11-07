// Answer generation with citation contract.
// Takes (query, top-k chunks) -> { answer, citations[], abstained }.
// Cached by sha256(query + ordered chunk ids/hashes) so re-runs are free.

import { GoogleGenAI } from "@google/genai";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

const MODEL = "gemini-3.5-flash-lite";
const ABSTAIN_PHRASE = "I couldn't find this in the documentation.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      await sleep(this.timestamps[0]! + this.windowMs - now + 100);
    }
  }
}

const bucket = new SlidingWindowLimiter(12, 60_000);

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 5;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.status !== 429 || i === maxAttempts - 1) throw err;
      let waitMs = 2 ** i * 1000 + Math.random() * 500;
      try {
        const body = JSON.parse(
          String(err.message).match(/\{[\s\S]*\}/)?.[0] ?? "{}",
        );
        const retryInfo = body?.error?.details?.find((d: any) =>
          d["@type"]?.includes("RetryInfo"),
        );
        if (retryInfo?.retryDelay)
          waitMs = parseInt(retryInfo.retryDelay, 10) * 1000 + 500;
      } catch {
        /* fall back */
      }
      console.warn(
        `[generate] ${label} 429; retry ${i + 1} in ${Math.round(waitMs)}ms`,
      );
      await sleep(waitMs);
    }
  }
  throw new Error("unreachable");
}

export type ChunkForGen = { id: string; headingPath: string[]; text: string };
export type GenerationResult = {
  answer: string;
  citations: Array<{
    n: number;
    chunkId: string;
    headingPath: string[];
    text: string;
  }>;
  abstained: boolean;
  citedIndices: number[];
  uncitedIndices: number[]; // chunks passed but never referenced — diagnostic
  invalidIndices: number[]; // cited [n] not in range 1..N — structural error
};

const PROMPT_VERSION = 2;

const PROMPT = (query: string, chunks: ChunkForGen[]) => {
  const chunkBlock = chunks
    .map((c, i) => {
      const heading = c.headingPath.join(" > ");
      return `[${i + 1}] ${heading}\n${c.text}`;
    })
    .join("\n\n---\n\n");

  return `You are a documentation Q&A assistant. Answer the question using ONLY the provided chunks below.

Rules:
1. Every sentence in your answer must end with a citation marker like [1] or [2], where the number matches the chunk number.
2. If a sentence draws from multiple chunks, cite all of them: [1][3].
3. Direct quotes from a chunk must ALSO end with a citation — the reader must know which chunk every sentence came from.
4. Do not use any knowledge outside the provided chunks.
5. If the chunks do not contain enough information to answer the question, respond with exactly: "${ABSTAIN_PHRASE}"
6. Be concise. No preamble. Start with the answer.
7. Every non-abstention answer must contain at least one [n] citation marker.

Chunks:
${chunkBlock}

Question: ${query}

Answer:`;
};

export class Generator {
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
    this.getCache = db.prepare(
      "SELECT answer FROM generation_cache WHERE key = ?",
    );
    this.putCache = db.prepare(
      "INSERT OR REPLACE INTO generation_cache (key, answer, created_at) VALUES (?, ?, ?)",
    );
  }

  async generate(
    query: string,
    chunks: ChunkForGen[],
  ): Promise<GenerationResult> {
    const key = createHash("sha256")
      .update(String(PROMPT_VERSION), "utf8")
      .update(query, "utf8")
      .update("\x00")
      .update(
        JSON.stringify(chunks.map((c) => ({ id: c.id, h: hash(c.text) }))),
      )
      .digest("hex");

    const cached = this.getCache.get(key) as { answer: string } | undefined;
    let answer: string;
    if (cached) {
      this.callsCached++;
      answer = cached.answer;
    } else {
      await bucket.take();
      const res = await withRetry(
        () =>
          this.ai.models.generateContent({
            model: MODEL,
            contents: PROMPT(query, chunks),
            config: { temperature: 0.1 },
          }),
        "generate",
      );
      this.callsMade++;
      answer = (res.text ?? "").trim();
      this.putCache.run(key, answer, Date.now());
    }

    return this.parseAnswer(answer, chunks);
  }

  private parseAnswer(raw: string, chunks: ChunkForGen[]): GenerationResult {
    const abstained =
      raw.trim() === ABSTAIN_PHRASE ||
      raw
        .trim()
        .toLowerCase()
        .includes("couldn't find this in the documentation");

    const citedIndices = new Set<number>();
    const invalidIndices: number[] = [];
    const re = /\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const n = parseInt(m[1]!, 10);
      if (n >= 1 && n <= chunks.length) citedIndices.add(n);
      else if (!invalidIndices.includes(n)) invalidIndices.push(n);
    }

    const citedSet = citedIndices;
    const allIndices = chunks.map((_, i) => i + 1);
    const uncitedIndices = allIndices.filter((n) => !citedSet.has(n));

    const citations = [...citedSet]
      .sort((a, b) => a - b)
      .map((n) => {
        const c = chunks[n - 1]!;
        return { n, chunkId: c.id, headingPath: c.headingPath, text: c.text };
      });

    return {
      answer: raw,
      citations,
      abstained,
      citedIndices: [...citedSet].sort((a, b) => a - b),
      uncitedIndices,
      invalidIndices,
    };
  }
}

function hash(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}
