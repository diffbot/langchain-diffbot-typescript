import { describe, expect, it } from "vitest";
import { DiffbotClient, type JsonObject } from "@diffbot/typescript";
import { Document } from "@langchain/core/documents";
import { DiffbotExtractLoader } from "../../src/loaders/extract.js";
import { createMockFetch, jsonResponse, type MockHandler } from "../helpers/mock-fetch.js";

const ANALYZE_URL = "https://api.diffbot.com/v3/analyze";

function makeClient(handler: MockHandler): DiffbotClient {
  return new DiffbotClient({ token: "test-token", fetch: createMockFetch(handler) });
}

describe("DiffbotExtractLoader identity", () => {
  it("exposes the LangChain loader surface", () => {
    const loader = new DiffbotExtractLoader({
      client: makeClient(() => jsonResponse({})),
      urls: ["https://example.com"],
    });
    expect(DiffbotExtractLoader.lc_name()).toBe("DiffbotExtractLoader");
    expect(loader.lc_namespace).toEqual(["langchain", "document_loaders", "diffbot"]);
  });
});

describe("DiffbotExtractLoader.load", () => {
  it("yields one Document per URL with the requested url in metadata", async () => {
    const seen: string[] = [];
    const db = makeClient((req) => {
      const url = req.params.get("url") ?? "";
      seen.push(url);
      return jsonResponse({
        objects: [{ text: `Body for ${url}`, title: "T", type: "article", pageUrl: url }],
      });
    });
    const loader = new DiffbotExtractLoader({
      client: db,
      urls: ["https://example.com/a", "https://example.com/b"],
    });

    const docs = await loader.load();

    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d instanceof Document)).toBe(true);
    expect(docs[0]!.metadata.url).toBe("https://example.com/a");
    expect(docs[1]!.metadata.url).toBe("https://example.com/b");
    /* URLs are extracted serially, in order. */
    expect(seen).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("prefers objects[0].text over the top-level markdown fallback", async () => {
    const db = makeClient(() =>
      jsonResponse({ objects: [{ text: "Object text." }], markdown: "Top-level markdown." }),
    );
    const docs = await new DiffbotExtractLoader({
      client: db,
      urls: ["https://example.com"],
    }).load();
    expect(docs[0]!.pageContent).toBe("Object text.");
  });

  it("falls back to top-level markdown when objects carries no text", async () => {
    const db = makeClient(() => jsonResponse({ markdown: "Top-level markdown." }));
    const docs = await new DiffbotExtractLoader({
      client: db,
      urls: ["https://example.com"],
    }).load();
    expect(docs[0]!.pageContent).toBe("Top-level markdown.");
  });

  it("sends api and fmt to the wire", async () => {
    let params: URLSearchParams | undefined;
    const db = makeClient((req) => {
      params = req.params;
      expect(req.url).toBe(ANALYZE_URL);
      return jsonResponse({ objects: [{ text: "x" }] });
    });
    await new DiffbotExtractLoader({
      client: db,
      urls: ["https://example.com"],
      api: "analyze",
      fmt: "markdown",
    }).load();
    expect(params!.get("mode")).toBe("llm");
  });

  it("reaches a non-default api via the request path", async () => {
    let requestedUrl = "";
    const db = makeClient((req) => {
      requestedUrl = req.url;
      return jsonResponse({ objects: [{ text: "x" }] });
    });
    await new DiffbotExtractLoader({
      client: db,
      urls: ["https://example.com"],
      api: "article",
    }).load();
    expect(requestedUrl).toBe("https://api.diffbot.com/v3/article");
  });

  it("lets documentMapper override the default mapping", async () => {
    const db = makeClient(() => jsonResponse({ objects: [{ text: "ignored" }] }));
    const customMapper = (url: string, raw: JsonObject) =>
      new Document({
        pageContent: `custom:${url}`,
        metadata: { raw },
      });
    const docs = await new DiffbotExtractLoader({
      client: db,
      urls: ["https://example.com"],
      documentMapper: customMapper,
    }).load();
    expect(docs[0]!.pageContent).toBe("custom:https://example.com");
    expect(docs[0]!.metadata.raw).toEqual({ objects: [{ text: "ignored" }] });
  });
});

describe("DiffbotExtractLoader.lazyLoad", () => {
  it("yields documents incrementally", async () => {
    const db = makeClient((req) => {
      const url = req.params.get("url") ?? "";
      return jsonResponse({ objects: [{ text: `Body for ${url}` }] });
    });
    const loader = new DiffbotExtractLoader({
      client: db,
      urls: ["https://example.com/a", "https://example.com/b", "https://example.com/c"],
    });

    const iterator = loader.lazyLoad();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value!.pageContent).toBe("Body for https://example.com/a");

    const second = await iterator.next();
    expect(second.value!.pageContent).toBe("Body for https://example.com/b");

    const third = await iterator.next();
    expect(third.value!.pageContent).toBe("Body for https://example.com/c");

    const done = await iterator.next();
    expect(done.done).toBe(true);
  });

  it("load() drains lazyLoad into a full array", async () => {
    const db = makeClient(() => jsonResponse({ objects: [{ text: "x" }] }));
    const loader = new DiffbotExtractLoader({
      client: db,
      urls: ["https://example.com/a", "https://example.com/b"],
    });
    const docs = await loader.load();
    expect(docs).toHaveLength(2);
  });
});
