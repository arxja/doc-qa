// Heading-aware markdown chunker.
//
// Five decisions, each preventing a specific failure mode:
//   1. Split on headings first     -> semantically coherent sections, not arbitrary 500-char windows
//   2. Prepend heading path        -> each chunk carries its own context ("Auth > API Keys > Rotation")
//   3. Target 400-800 tokens       -> too small loses context; too big blurs the embedding
//   4. 10% overlap between chunks  -> answers straddling a boundary still fully appear in one chunk
//   5. Never split mid-sentence    -> fragments embed badly and quote badly
//
// Token counts are approximate (chars / 4). Within ~15% of Gemini's tokenizer for English prose.

import type { Doc } from "./fetch";

export type Section = { headingPath: string[]; body: string };
export type Chunk = {
  id: string;
  docId: string;
  headingPath: string[];
  text: string;
  approxTokens: number;
};

const MAX_TOKENS = 800;
const MIN_TOKENS = 100;
const TARGET_TOKENS = 600;
const OVERLAP_RATIO = 0.1;
const CHARS_PER_TOKEN = 4;

const approxTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

// ---------------------------------------------------------------------------
// Step 1: parse the doc into heading-delimited sections.
// ---------------------------------------------------------------------------
export function parseSections(md: string): Section[] {
  const lines = md.split("\n");
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let body: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const flush = () => {
    const text = body.join("\n").trim();
    body = [];
    if (!text) return; // heading with no body: path still carries into children
    sections.push({ headingPath: stack.map((h) => h.title), body: text });
  };

  for (const line of lines) {
    // Track code fences so "# not a heading" inside a fence isn't parsed as a heading.
    const fence = line.match(/^(\s*)(```|~~~)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[2]!;
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
      }
      body.push(line);
      continue;
    }
    if (inFence) {
      body.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level)
        stack.pop();
      stack.push({ level, title });
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

// ---------------------------------------------------------------------------
// Step 2: split a section body into packable units (paragraphs -> sentences).
// Code fences are atomic: never sentence-split inside them.
// ---------------------------------------------------------------------------
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function splitSentences(text: string): string[] {
  if (/^\s*(```|~~~)/m.test(text)) return [text]; // atomic: contains a fence
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Step 3: greedily pack units into chunks, with 10% overlap and min-token merge.
// ---------------------------------------------------------------------------
type Packed = { text: string; tokens: number };

function packSection(section: Section): Packed[] {
  const pathStr = section.headingPath.join(" > ");
  const prefix = pathStr ? `${pathStr}\n\n` : "";
  const prefixTokens = approxTokens(prefix);
  const effectiveMax = MAX_TOKENS - prefixTokens;
  const overlapCap = Math.floor(TARGET_TOKENS * OVERLAP_RATIO);

  // Flatten body into units small enough to fit.
  const units: string[] = [];
  for (const p of splitParagraphs(section.body)) {
    if (approxTokens(p) <= effectiveMax) {
      units.push(p);
      continue;
    }
    for (const s of splitSentences(p)) {
      if (approxTokens(s) <= effectiveMax) {
        units.push(s);
      } else {
        // Last resort: hard split. Logged so we can spot it in inspection.
        console.warn(
          `[chunk] hard-split ${approxTokens(s)}-token unit in ${pathStr}`,
        );
        const chars = effectiveMax * CHARS_PER_TOKEN;
        for (let i = 0; i < s.length; i += chars)
          units.push(s.slice(i, i + chars));
      }
    }
  }

  const chunks: Packed[] = [];
  let cur: string[] = [];
  let curTokens = 0;

  const flush = (): Packed | undefined => {
    if (cur.length === 0) return undefined;
    const text = prefix + cur.join("\n\n");
    const packed: Packed = { text, tokens: approxTokens(text) };
    chunks.push(packed);
    cur = [];
    curTokens = 0;
    return packed;
  };

  for (const u of units) {
    const uTok = approxTokens(u);
    if (curTokens + uTok > effectiveMax && cur.length > 0) {
      const prev = flush();
      if (prev) {
        const prevSents = splitSentences(prev.text.slice(prefix.length));
        if (prevSents.length > 1) {
          const overlap = prevSents[prevSents.length - 1]!; 
          const oTok = approxTokens(overlap);
          if (oTok <= overlapCap && oTok + uTok <= effectiveMax) {
            cur = [overlap];
            curTokens = oTok;
          }
        }
      }
    }
    cur.push(u);
    curTokens += uTok;
  }
  flush();

  // Merge chunks that came out below MIN_TOKENS into their predecessor when they fit.
  const merged: Packed[] = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (c.tokens < MIN_TOKENS && prev) {
      const combined = `${prev.text}\n\n${c.text.slice(prefix.length)}`;
      if (approxTokens(combined) <= MAX_TOKENS) {
        prev.text = combined;
        prev.tokens = approxTokens(combined);
        continue;
      }
    }
    merged.push(c);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function chunkMarkdown(doc: Doc): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of parseSections(doc.content)) {
    for (const p of packSection(section)) {
      chunks.push({
        id: `${doc.id}#${chunks.length}`,
        docId: doc.id,
        headingPath: section.headingPath,
        text: p.text,
        approxTokens: p.tokens,
      });
    }
  }
  return chunks;
}
