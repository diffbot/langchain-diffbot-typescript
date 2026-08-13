import { describe, expect, it } from "vitest";
import { DiffbotClient } from "@diffbot/typescript";
import { DiffbotDQLProbeTool } from "../../src/tools/dql-probe.js";
import { createMockFetch, jsonResponse, type MockHandler } from "../helpers/mock-fetch.js";

const DQL_URL = "https://kg.diffbot.com/kg/v3/dql";

function makeClient(handler: MockHandler): DiffbotClient {
  return new DiffbotClient({
    token: "test-token",
    fetch: createMockFetch(handler),
  });
}

describe("DiffbotDQLProbeTool identity", () => {
  it("exposes the LangChain tool surface", () => {
    const tool = new DiffbotDQLProbeTool({
      client: makeClient(() => jsonResponse({})),
    });
    expect(DiffbotDQLProbeTool.lc_name()).toBe("DiffbotDQLProbeTool");
    expect(tool.name).toBe("diffbot_dql_probe");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.lc_namespace).toEqual(["langchain", "tools", "diffbot"]);
  });
});

describe("DiffbotDQLProbeTool", () => {
  it("probes each variant at size=0 and returns hit counts in input order", async () => {
    const db = makeClient((req) => {
      expect(req.url).toBe(DQL_URL);
      expect(req.method).toBe("GET");
      /* size=0 is the whole point: match counts, no entity payload. */
      expect(req.params.get("size")).toBe("0");
      const query = req.params.get("query") ?? "";
      const hits = query.includes("Diffbot") ? 5 : 100;
      return jsonResponse({ hits, results: 0 });
    });

    const out = await new DiffbotDQLProbeTool({ client: db }).invoke({
      queries: ['type:Organization name:"Diffbot"', "type:Organization"],
    });

    expect(out).toEqual([
      { query: 'type:Organization name:"Diffbot"', hits: 5 },
      { query: "type:Organization", hits: 100 },
    ]);
  });

  it("preserves input order when responses come back out of order", async () => {
    const queries = ["q0", "q1", "q2", "q3"];
    const db = makeClient(async (req) => {
      const query = req.params.get("query") ?? "";
      /* Later queries answer first, so positional zipping is really tested. */
      const delay = (queries.length - queries.indexOf(query)) * 5;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return jsonResponse({ hits: queries.indexOf(query) });
    });

    const out = await new DiffbotDQLProbeTool({ client: db }).invoke({
      queries,
      workers: 4,
    });

    expect(out).toEqual([
      { query: "q0", hits: 0 },
      { query: "q1", hits: 1 },
      { query: "q2", hits: 2 },
      { query: "q3", hits: 3 },
    ]);
  });

  it("reports null when a response carries no hit count", async () => {
    const db = makeClient(() => jsonResponse({ results: 0 }));
    const out = await new DiffbotDQLProbeTool({ client: db }).invoke({
      queries: ["type:Organization"],
    });
    expect(out).toEqual([{ query: "type:Organization", hits: null }]);
  });

  it("returns an empty list for no queries without hitting the network", async () => {
    let calls = 0;
    const db = makeClient(() => {
      calls += 1;
      return jsonResponse({ hits: 1 });
    });
    expect(await new DiffbotDQLProbeTool({ client: db }).invoke({ queries: [] })).toEqual([]);
    expect(calls).toBe(0);
  });
});
