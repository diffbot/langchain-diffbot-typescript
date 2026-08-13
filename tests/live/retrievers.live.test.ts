/*
  Live integration tests against the real Diffbot Knowledge Graph and web
  search APIs. These hit a live, changing index and consume API quota, so
  assertions are shape-based rather than content-based: non-empty results,
  correct types, and requested metadata keys, never a specific company or
  page. Requires DIFFBOT_API_TOKEN; the whole suite is skipped when it is
  unset (see vitest.live.config.ts for how this file is picked up).
*/

import { describe, expect, it } from "vitest";
import { DiffbotClient } from "@diffbot/typescript";
import { Document } from "@langchain/core/documents";
import { DiffbotKnowledgeGraphRetriever } from "../../src/retrievers/knowledge-graph.js";
import { DiffbotWebSearchRetriever } from "../../src/retrievers/web-search.js";

const token = process.env.DIFFBOT_API_TOKEN;

/*
  Built even when `token` is undefined, since `describe.skipIf` still
  collects (but does not run) the tests inside — the SDK requires a
  non-empty token string at construction, so fall back to a placeholder
  that is never actually used because the tests it backs are skipped.
*/
const client = new DiffbotClient({ token: token ?? "unused-token-suite-skipped" });

describe.skipIf(!token)("DiffbotKnowledgeGraphRetriever (live)", () => {
  it("returns Documents narrowed to the requested fields", async () => {
    const retriever = new DiffbotKnowledgeGraphRetriever({
      client,
      k: 3,
      fields: ["id", "type", "name"],
    });

    const docs = await retriever.invoke("type:Organization");

    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.length).toBeLessThanOrEqual(3);
    for (const doc of docs) {
      expect(doc).toBeInstanceOf(Document);
      expect(typeof doc.pageContent).toBe("string");
      /*
        `score` always rides along on top of the requested allowlist (see
        DiffbotKnowledgeGraphRetriever.hitToDocument), so it's an allowed key
        here even though it wasn't in `fields`.
      */
      for (const key of Object.keys(doc.metadata)) {
        expect(["id", "type", "name", "score"]).toContain(key);
      }
    }
  });
});

describe.skipIf(!token)("DiffbotWebSearchRetriever (live)", () => {
  it("returns Documents with pageUrl metadata", async () => {
    const retriever = new DiffbotWebSearchRetriever({ client, k: 3 });

    const docs = await retriever.invoke("What is the Diffbot Knowledge Graph?");

    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc).toBeInstanceOf(Document);
      expect(typeof doc.pageContent).toBe("string");
      expect(typeof doc.metadata.pageUrl).toBe("string");
    }
  });
});
