import { DiffbotClient } from "@diffbot/typescript";
import { describe, expect, it } from "vitest";
import { DiffbotWebSearchTool } from "../../src/tools/web-search.js";
import { createMockFetch, jsonResponse, type MockHandler } from "../helpers/mock-fetch.js";

function toolWith(handler: MockHandler): DiffbotWebSearchTool {
  return new DiffbotWebSearchTool({
    client: new DiffbotClient({ token: "test-token", fetch: createMockFetch(handler) }),
  });
}

describe("DiffbotWebSearchTool", () => {
  it("identifies itself as a Diffbot tool", () => {
    const tool = toolWith(() => jsonResponse({}));
    expect(DiffbotWebSearchTool.lc_name()).toBe("DiffbotWebSearchTool");
    expect(tool.name).toBe("diffbot_web_search");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.lc_namespace).toEqual(["langchain", "tools", "diffbot"]);
  });

  it("returns the raw search_results list", async () => {
    const tool = toolWith(() =>
      jsonResponse({
        search_results: [{ score: 1.0, title: "A", pageUrl: "https://a.example", content: "hi" }],
      }),
    );

    const out = await tool.invoke({ text: "anything" });
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      score: 1.0,
      title: "A",
      pageUrl: "https://a.example",
      content: "hi",
    });
  });

  it("sends numResults on the wire as `size` and maxTokens as-is", async () => {
    const tool = toolWith((req) => {
      expect(req.url).toBe("https://llm.diffbot.com/api/v1/web_search");
      expect(req.params.get("text")).toBe("anything");
      expect(req.params.get("size")).toBe("3");
      expect(req.params.get("maxTokens")).toBe("500");
      return jsonResponse({ search_results: [] });
    });

    await tool.invoke({ text: "anything", numResults: 3, maxTokens: 500 });
  });

  it("omits size and maxTokens when unset", async () => {
    const tool = toolWith((req) => {
      expect(req.params.get("size")).toBeNull();
      expect(req.params.get("maxTokens")).toBeNull();
      return jsonResponse({ search_results: [] });
    });

    await tool.invoke({ text: "anything" });
  });

  it("returns an empty list when the body carries no search_results", async () => {
    const tool = toolWith(() => jsonResponse({}));
    expect(await tool.invoke({ text: "anything" })).toEqual([]);
  });
});
