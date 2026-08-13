import { describe, expect, it } from "vitest";
import { DiffbotClient } from "@diffbot/typescript";
import { Document } from "@langchain/core/documents";
import { DiffbotWebSearchRetriever } from "../../src/retrievers/web-search.js";
import { createMockFetch, jsonResponse, type MockHandler } from "../helpers/mock-fetch.js";

const WEB_SEARCH_URL = "https://llm.diffbot.com/api/v1/web_search";

function makeClient(handler: MockHandler): DiffbotClient {
  return new DiffbotClient({
    token: "test-token",
    fetch: createMockFetch(handler),
  });
}

const SAMPLE_BODY = {
  search_results: [
    {
      score: 0.91,
      title: "Diffbot Knowledge Graph",
      pageUrl: "https://www.diffbot.com/kg/",
      content: "Diffbot KG is the largest commercial knowledge graph...",
    },
    {
      score: 0.42,
      title: "About Diffbot",
      pageUrl: "https://www.diffbot.com/about",
      snippet: "Diffbot uses AI to extract structured data from web pages.",
    },
    {
      score: 0.13,
      title: "Diffbot Extract",
      pageUrl: "https://www.diffbot.com/products/extract/",
      snippet: "Turn any page into structured data.",
    },
  ],
};

describe("DiffbotWebSearchRetriever document mapping", () => {
  it("maps search results to documents, preferring content over snippet", async () => {
    const db = makeClient((req) => {
      expect(req.url).toBe(WEB_SEARCH_URL);
      expect(req.method).toBe("GET");
      expect(req.params.get("text")).toBe("diffbot knowledge graph");
      expect(req.headers.get("Authorization")).toBe("Bearer test-token");
      return jsonResponse(SAMPLE_BODY);
    });
    const docs = await new DiffbotWebSearchRetriever({
      client: db,
      k: 2,
    }).invoke("diffbot knowledge graph");

    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d instanceof Document)).toBe(true);
    expect(docs[0]!.pageContent).toBe("Diffbot KG is the largest commercial knowledge graph...");
    /* `content` was promoted to pageContent, so it must not repeat in metadata. */
    expect(docs[0]!.metadata).not.toHaveProperty("content");
  });

  it("falls back to snippet when a result has no content", async () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    const docs = await new DiffbotWebSearchRetriever({
      client: db,
      k: 2,
    }).invoke("diffbot");

    expect(docs[1]!.pageContent).toBe("Diffbot uses AI to extract structured data from web pages.");
    expect(docs[1]!.metadata).not.toHaveProperty("snippet");
  });

  it("keeps title and score in metadata by default", async () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    const docs = await new DiffbotWebSearchRetriever({
      client: db,
      k: 2,
    }).invoke("diffbot");

    expect(docs[0]!.metadata.title).toBe("Diffbot Knowledge Graph");
    expect(docs[0]!.metadata.score).toBe(0.91);
    expect(docs[0]!.metadata.pageUrl).toBe("https://www.diffbot.com/kg/");
    expect(docs[1]!.metadata.title).toBe("About Diffbot");
    expect(docs[1]!.metadata.score).toBe(0.42);
  });

  it("narrows metadata to the fields allowlist", async () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    const docs = await new DiffbotWebSearchRetriever({
      client: db,
      k: 1,
      fields: ["title", "pageUrl"],
    }).invoke("diffbot");

    expect(Object.keys(docs[0]!.metadata).sort()).toEqual(["pageUrl", "title"]);
    expect(docs[0]!.metadata).not.toHaveProperty("score");
  });

  it("respects a custom contentFields priority", async () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    const docs = await new DiffbotWebSearchRetriever({
      client: db,
      k: 1,
      contentFields: ["title", "content"],
    }).invoke("diffbot");

    expect(docs[0]!.pageContent).toBe("Diffbot Knowledge Graph");
    expect(docs[0]!.metadata.content).toBe(
      "Diffbot KG is the largest commercial knowledge graph...",
    );
  });

  it("lets documentMapper override the default mapping", async () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    const docs = await new DiffbotWebSearchRetriever({
      client: db,
      k: 1,
      fields: ["score"],
      documentMapper: (hit) =>
        new Document({
          pageContent: String(hit.title),
          metadata: { url: hit.pageUrl },
        }),
    }).invoke("diffbot");

    expect(docs[0]!.pageContent).toBe("Diffbot Knowledge Graph");
    expect(docs[0]!.metadata).toEqual({ url: "https://www.diffbot.com/kg/" });
  });
});

describe("DiffbotWebSearchRetriever request wiring", () => {
  it("sends k as the size wire param and maxTokens as maxTokens", async () => {
    const db = makeClient((req) => {
      expect(req.params.get("size")).toBe("5");
      expect(req.params.get("maxTokens")).toBe("2000");
      return jsonResponse(SAMPLE_BODY);
    });
    await new DiffbotWebSearchRetriever({
      client: db,
      k: 5,
      maxTokens: 2000,
    }).invoke("diffbot");
  });

  it("omits maxTokens when it is not set", async () => {
    const db = makeClient((req) => {
      expect(req.params.get("size")).toBe("10");
      expect(req.params.get("maxTokens")).toBeNull();
      return jsonResponse(SAMPLE_BODY);
    });
    await new DiffbotWebSearchRetriever({ client: db }).invoke("diffbot");
  });

  it("slices the returned documents to k", async () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    const docs = await new DiffbotWebSearchRetriever({
      client: db,
      k: 2,
    }).invoke("diffbot");

    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.metadata.title)).toEqual(["Diffbot Knowledge Graph", "About Diffbot"]);
  });

  it("returns no documents when the response carries no search_results", async () => {
    const db = makeClient(() => jsonResponse({}));
    const docs = await new DiffbotWebSearchRetriever({ client: db }).invoke("diffbot");
    expect(docs).toEqual([]);
  });

  it("rejects a non-positive k at construction time", () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    expect(() => new DiffbotWebSearchRetriever({ client: db, k: 0 })).toThrow(
      /`k` must be a positive integer/,
    );
  });
});
