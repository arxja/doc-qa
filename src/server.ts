// Bun HTTP server for the dashboard.
// Two routes: GET / -> HTML, POST /query -> JSON pipeline result.
// Long-lived state (DB, embedder, reranker, generator) is instantiated once,
// so caches persist across requests within the server's lifetime.

import { openDb } from "./db";
import { Embedder } from "./embed";
import { Reranker } from "./retrieve/rerank";
import { Generator } from "./generate";
import { buildIndexFromDb } from "./retrieve/bm25";
import { runPipeline } from "./pipeline";
import { readFileSync } from "node:fs";

const db = openDb();
const embedder = new Embedder(db);
const reranker = new Reranker(db);
const generator = new Generator(db);
const bm25 = buildIndexFromDb(db);

const html = readFileSync("dashboard/index.html", "utf8");

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" && req.method === "GET") {
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/query" && req.method === "POST") {
      try {
        const body = (await req.json()) as { query?: string };
        const query = (body.query ?? "").trim();
        if (!query) {
          return Response.json({ error: "missing query" }, { status: 400 });
        }
        const result = await runPipeline(
          query,
          db,
          embedder,
          reranker,
          generator,
          bm25,
        );
        return Response.json(result);
      } catch (err: any) {
        console.error("[server] pipeline error:", err);
        return Response.json(
          { error: String(err?.message ?? err) },
          { status: 500 },
        );
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`\n  Lumen Docs Q&A running at http://localhost:${server.port}\n`);
