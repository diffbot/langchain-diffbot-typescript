import { DiffbotClient } from "@diffbot/typescript";
import { describe, expect, it } from "vitest";
import { DiffbotKnowledgeGraphTool } from "../../src/tools/knowledge-graph.js";
import { createMockFetch, jsonResponse, type MockHandler } from "../helpers/mock-fetch.js";

function toolWith(handler: MockHandler): DiffbotKnowledgeGraphTool {
  return new DiffbotKnowledgeGraphTool({
    client: new DiffbotClient({ token: "test-token", fetch: createMockFetch(handler) }),
  });
}

describe("DiffbotKnowledgeGraphTool", () => {
  it("identifies itself as a Diffbot tool", () => {
    const tool = toolWith(() => jsonResponse({}));
    expect(DiffbotKnowledgeGraphTool.lc_name()).toBe("DiffbotKnowledgeGraphTool");
    expect(tool.name).toBe("diffbot_knowledge_graph");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.lc_namespace).toEqual(["langchain", "tools", "diffbot"]);
  });

  it("returns the raw response body", async () => {
    const body = { hits: 42, data: [{ score: 1.0, entity: { id: "E1", name: "Acme" } }] };
    const tool = toolWith(() => jsonResponse(body));

    const out = await tool.invoke({ query: "type:Organization", size: 1 });
    expect(out).toEqual(body);
    expect(out.hits).toBe(42);
  });

  it("sends query, size, from and filter on the wire", async () => {
    const tool = toolWith((req) => {
      expect(req.url).toBe("https://kg.diffbot.com/kg/v3/dql");
      expect(req.params.get("query")).toBe("type:Organization");
      expect(req.params.get("size")).toBe("5");
      expect(req.params.get("from")).toBe("20");
      expect(req.params.get("filter")).toBe("nbEmployees>100");
      return jsonResponse({ data: [] });
    });

    await tool.invoke({
      query: "type:Organization",
      size: 5,
      from: 20,
      filter: "nbEmployees>100",
    });
  });

  it("defaults to size 10 and omits from and filter", async () => {
    const tool = toolWith((req) => {
      expect(req.params.get("size")).toBe("10");
      expect(req.params.get("from")).toBeNull();
      expect(req.params.get("filter")).toBeNull();
      return jsonResponse({ data: [] });
    });

    await tool.invoke({ query: "type:Organization" });
  });
});
