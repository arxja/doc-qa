// Faithfulness checker. For each (claim, chunk) pair, ask an LLM:
//   "Does this chunk entail (support) this claim?"
// Returns SUPPORTED / PARTIAL / UNSUPPORTED with optional reasoning.
// Cached by (claim_text, chunk_content_hash).

import { GoogleGenAI } from "@google/genai";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

const MODEL = "gemini-3.5-flash-lite";
const PROMPT_VERSION = 1;

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
      const status = err?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || i === maxAttempts - 1) throw err;
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
        `[faith] ${label} ${status}; retry ${i + 1} in ${Math.round(waitMs)}ms`,
      );
      await sleep(waitMs);
    }
  }
  throw new Error("unreachable");
}

export type Verdict = "supported" | "partial" | "unsupported";
export type SupportResult = { verdict: Verdict; reasoning: string };

const PROMPT = (
  claim: string,
  chunk: string,
) => `You are a strict entailment checker for a documentation Q&A system.

Given a CLAIM and a CHUNK, decide whether the chunk supports the claim.

Return exactly one verdict:
- SUPPORTED: the chunk states the claim, or a direct paraphrase with no material difference.
- PARTIAL: the chunk discusses the same fact but omits or slightly alters a material detail (number, condition, scope).
- UNSUPPORTED: the chunk does not contain the claim, or contradicts it.

Be strict. "Related topic" is not SUPPORTED. If the claim adds a fact not present in the chunk, that is PARTIAL at best.

CLAIM:
${claim}

CHUNK:
${chunk}

Respond in JSON: {"verdict": "supported" | "partial" | "unsupported", "reasoning": "<one sentence>"}`;

export class FaithfulnessChecker {
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
      "SELECT verdict, reasoning FROM faithfulness_cache WHERE key = ?",
    );
    this.putCache = db.prepare(
      "INSERT OR REPLACE INTO faithfulness_cache (key, verdict, reasoning, created_at) VALUES (?, ?, ?, ?)",
    );
  }

  async check(claim: string, chunkText: string): Promise<SupportResult> {
    const chunkHash = createHash("sha256")
      .update(chunkText, "utf8")
      .digest("hex")
      .slice(0, 16);
    const key = createHash("sha256")
      .update(String(PROMPT_VERSION), "utf8")
      .update("\x00")
      .update(claim, "utf8")
      .update("\x00")
      .update(chunkHash, "utf8")
      .digest("hex");

    const cached = this.getCache.get(key) as
      | { verdict: Verdict; reasoning: string }
      | undefined;
    if (cached) {
      this.callsCached++;
      return { verdict: cached.verdict, reasoning: cached.reasoning };
    }

    await bucket.take();
    const res = await withRetry(
      () =>
        this.ai.models.generateContent({
          model: MODEL,
          contents: PROMPT(claim, chunkText),
          config: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                verdict: {
                  type: "string",
                  enum: ["supported", "partial", "unsupported"],
                },
                reasoning: { type: "string" },
              },
              required: ["verdict", "reasoning"],
            } as any,
          },
        }),
      "check",
    );
    this.callsMade++;

    let parsed: { verdict?: Verdict; reasoning?: string } = {};
    try {
      parsed = JSON.parse(res.text ?? "{}");
    } catch {
      /* fallback below */
    }
    const verdict: Verdict = (parsed.verdict as Verdict) ?? "unsupported";
    const reasoning = parsed.reasoning ?? "";
    this.putCache.run(key, verdict, reasoning, Date.now());
    return { verdict, reasoning };
  }
}

// ---- Claim extraction ----
// Split an answer into (claim, cited_indices) tuples. Deterministic.
// A claim is a sentence that contains at least one [n] marker.
export type Claim = { text: string; citedIndices: number[] };

export function extractClaims(answer: string): Claim[] {
  // Split on sentence boundaries (. ! ?) followed by whitespace.
  // Keep abbreviation-safe by requiring the period to be followed by a capital or end.
  const raw = answer
    .split(/(?<=[.!?])\s+(?=[A-Z"([])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const claims: Claim[] = [];
  for (const sentence of raw) {
    const indices: number[] = [];
    const re = /\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence)) !== null) {
      indices.push(parseInt(m[1]!, 10));
    }
    if (indices.length === 0) continue; // not a claim (greeting, transitional)
    const claimText = sentence
      .replace(/\[\d+\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (claimText.length < 5) continue; // too short to be substantive
    claims.push({
      text: claimText,
      citedIndices: [...new Set(indices)].sort((a, b) => a - b),
    });
  }
  return claims;
}
