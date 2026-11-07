// BM25 keyword scoring. Exact-token precision for entity names, error codes,
// endpoint paths — the cases where embeddings blur.
//
// Tokenization: strip backticks, lowercase, split on non [a-z0-9_].
// Underscore preserved so E_AUTH_403 stays one token (code identifiers matter).
// Stopwords dropped so "what does X mean" reduces to [x].
//
// intuition (TF saturation, IDF rarity, length norm) is the real lesson.

import type { Database } from "bun:sqlite";

const STOPWORDS = new Set([
  "a","an","the","and","or","but","if","then","else","of","to","in","on","at","by",
  "for","with","about","into","through","during","before","after","above","below",
  "from","up","down","out","off","over","under","again","further","once","here",
  "there","when","where","why","how","all","any","both","each","few","more","most",
  "other","some","such","no","nor","not","only","own","same","so","than","too",
  "very","s","t","can","will","just","don","should","now","is","are","was","were",
  "be","been","being","have","has","had","do","does","did","what","which","who",
  "whom","this","that","these","those","i","me","my","we","our","you","your","he",
  "him","his","she","her","it","its","they","them","their","am","us",
]);

export function tokenize(text: string): string[] {
  const cleaned = text.replace(/`/g, " ").toLowerCase();
  return cleaned
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export type Bm25Index = {
  N: number;
  avgdl: number;
  df: Map<string, number>;
  postings: Map<string, Array<{ id: string; tf: number; dl: number }>>;
};

export function buildIndex(
  rows: Array<{ id: string; text: string }>,
): Bm25Index {
  const df = new Map<string, number>();
  const postings = new Map<string, Array<{ id: string; tf: number; dl: number }>>();
  let totalLen = 0;

  for (const { id, text } of rows) {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = tokens.length;
    totalLen += dl;
    for (const [term, freq] of tf) {
      df.set(term, (df.get(term) ?? 0) + 1);
      const list = postings.get(term) ?? [];
      list.push({ id, tf: freq, dl });
      postings.set(term, list);
    }
  }

  return {
    N: rows.length,
    avgdl: rows.length ? totalLen / rows.length : 1,
    df,
    postings,
  };
}

export type Bm25Hit = { id: string; score: number };

export function searchBm25(
  query: string,
  index: Bm25Index,
  k = 10,
  k1 = 1.2,
  b = 0.75,
): Bm25Hit[] {
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return [];
  const scores = new Map<string, number>();

  for (const term of qTerms) {
    const posting = index.postings.get(term);
    if (!posting) continue;
    const n = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));

    for (const { id, tf, dl } of posting) {
      const norm = 1 - b + b * (dl / index.avgdl);
      const sat = (tf * (k1 + 1)) / (tf + k1 * norm);
      scores.set(id, (scores.get(id) ?? 0) + idf * sat);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}

// Convenience: build index from the DB.
export function buildIndexFromDb(db: Database): Bm25Index {
  const rows = db.query("SELECT id, text FROM chunks").all() as Array<{ id: string; text: string }>;
  return buildIndex(rows);
}