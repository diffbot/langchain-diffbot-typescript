import { DiffbotClient } from "@diffbot/typescript";
import { describe, expect, it } from "vitest";
import { DiffbotExtractTool } from "../../src/tools/extract.js";
import { createMockFetch, jsonResponse, type MockHandler } from "../helpers/mock-fetch.js";

function toolWith(handler: MockHandler): DiffbotExtractTool {
  return new DiffbotExtractTool({
    client: new DiffbotClient({ token: "test-token", fetch: createMockFetch(handler) }),
  });
}

describe("DiffbotExtractTool", () => {
  it("identifies itself as a Diffbot tool", () => {
    const tool = toolWith(() => jsonResponse({}));
    expect(DiffbotExtractTool.lc_name()).toBe("DiffbotExtractTool");
    expect(tool.name).toBe("diffbot_extract");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.lc_namespace).toEqual(["langchain", "tools", "diffbot"]);
  });

  it("shapes the response from objects[0]", async () => {
    const tool = toolWith(() =>
      jsonResponse({
        objects: [
          {
            text: "Hello world",
            title: "Example",
            type: "article",
            pageUrl: "https://example.com",
            resolvedPageUrl: "https://example.com/",
          },
        ],
      }),
    );

    const out = await tool.invoke({ url: "https://example.com" });
    expect(out).toEqual({
      content: "Hello world",
      title: "Example",
      type: "article",
      pageUrl: "https://example.com",
      resolvedPageUrl: "https://example.com/",
    });
  });

  it("falls back to the top-level markdown shape", async () => {
    const tool = toolWith(() =>
      jsonResponse({
        markdown: "# Heading\n\nBody.",
        title: "Top-level title",
        url: "https://example.com/top",
        type: "article",
      }),
    );

    const out = await tool.invoke({ url: "https://example.com" });
    expect(out).toEqual({
      content: "# Heading\n\nBody.",
      title: "Top-level title",
      pageUrl: "https://example.com/top",
      resolvedPageUrl: undefined,
      type: "article",
    });
  });

  it("sends the url and the markdown LLM mode by default", async () => {
    const tool = toolWith((req) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("https://api.diffbot.com/v3/analyze");
      expect(req.params.get("url")).toBe("https://example.com");
      expect(req.params.get("token")).toBe("test-token");
      expect(req.params.get("timeout")).toBe("30000");
      expect(req.params.get("mode")).toBe("llm");
      return jsonResponse({ objects: [{ text: "Body." }] });
    });

    const out = await tool.invoke({ url: "https://example.com" });
    expect(out).toMatchObject({ content: "Body." });
  });

  it("routes `api` to the endpoint path and drops llm mode for other formats", async () => {
    const tool = toolWith((req) => {
      expect(req.url).toBe("https://api.diffbot.com/v3/article");
      expect(req.params.get("mode")).toBeNull();
      return jsonResponse({ objects: [{ text: "Body." }] });
    });

    await tool.invoke({ url: "https://example.com", api: "article", fmt: "json" });
  });

  it("returns a structured error on extraction failure instead of throwing", async () => {
    /*
      An extraction failure is a 200 response carrying an `errorCode` body. The
      SDK turns that into ExtractionError; the tool turns it back into data so
      the agent can react.
    */
    const tool = toolWith(() => jsonResponse({ errorCode: 500, error: "could not fetch" }));

    const out = await tool.invoke({ url: "https://example.com" });
    expect(out).toMatchObject({ errorCode: 500 });
    expect((out as { error: string }).error).toContain("could not fetch");
  });

  it("propagates an auth error", async () => {
    const tool = toolWith(() => jsonResponse({ message: "bad token" }, 401));
    await expect(tool.invoke({ url: "https://example.com" })).rejects.toThrow(/401/);
  });
});
