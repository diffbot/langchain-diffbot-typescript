import { DiffbotClient } from "@diffbot/typescript";
import { describe, expect, it } from "vitest";
import { DiffbotEntitiesTool } from "../../src/tools/entities.js";
import { createMockFetch, jsonResponse, type MockHandler } from "../helpers/mock-fetch.js";

function toolWith(handler: MockHandler): DiffbotEntitiesTool {
  return new DiffbotEntitiesTool({
    client: new DiffbotClient({ token: "test-token", fetch: createMockFetch(handler) }),
  });
}

describe("DiffbotEntitiesTool", () => {
  it("identifies itself as a Diffbot tool", () => {
    const tool = toolWith(() => jsonResponse([{}]));
    expect(DiffbotEntitiesTool.lc_name()).toBe("DiffbotEntitiesTool");
    expect(tool.name).toBe("diffbot_entities");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.lc_namespace).toEqual(["langchain", "tools", "diffbot"]);
  });

  it("returns the response object verbatim", async () => {
    /* The NLP endpoint answers with an array; the SDK unwraps it to data[0]. */
    const tool = toolWith(() =>
      jsonResponse([
        { entities: [{ name: "Apple", type: "Organization", id: "E1" }], sentiment: 0.4 },
      ]),
    );

    const out = await tool.invoke({ text: "Apple CEO ..." });
    expect(out).toEqual({
      entities: [{ name: "Apple", type: "Organization", id: "E1" }],
      sentiment: 0.4,
    });
  });

  it("posts the text with the default `auto` language hint", async () => {
    const tool = toolWith((req) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("https://nl.diffbot.com/v1/");
      expect(req.params.get("token")).toBe("test-token");
      expect(JSON.parse(req.body ?? "[]")).toEqual([
        { lang: "auto", format: "plain text", content: "Apple CEO ..." },
      ]);
      return jsonResponse([{ entities: [], sentiment: 0 }]);
    });

    await tool.invoke({ text: "Apple CEO ..." });
  });

  it("passes an explicit lang through to the request payload", async () => {
    const tool = toolWith((req) => {
      expect(JSON.parse(req.body ?? "[]")).toEqual([
        { lang: "fr", format: "plain text", content: "Bonjour." },
      ]);
      return jsonResponse([{ entities: [], sentiment: 0 }]);
    });

    await tool.invoke({ text: "Bonjour.", lang: "fr" });
  });
});
