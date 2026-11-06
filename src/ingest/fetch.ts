import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type Doc = { id: string; path: string; content: string };

export async function loadCorpus(dir = "data/corpus"): Promise<Doc[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const docs: Doc[] = [];
  for (const f of files) {
    const content = await readFile(join(dir, f), "utf8");
    docs.push({ id: f.replace(/\.md$/, ""), path: join(dir, f), content });
  }
  return docs;
}
