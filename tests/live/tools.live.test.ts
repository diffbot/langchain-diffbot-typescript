/*
  Live integration tests against the real Diffbot APIs. These hit a live,
  changing Knowledge Graph and live web, and consume API quota, so
  assertions are shape-based rather than content-based. Requires
  DIFFBOT_API_TOKEN; the whole suite is skipped when it is unset (see
  vitest.live.config.ts for how this file is picked up).
*/

import { describe, expect, it } from "vitest";
import { DiffbotClient } from "@diffbot/typescript";
import { DiffbotExtractTool } from "../../src/tools/extract.js";
import { DiffbotWebSearchTool } from "../../src/tools/web-search.js";
import { DiffbotEntitiesTool } from "../../src/tools/entities.js";
import { DiffbotKnowledgeGraphTool } from "../../src/tools/knowledge-graph.js";
import { DiffbotOntologyTool } from "../../src/tools/ontology.js";
import { DiffbotDQLProbeTool } from "../../src/tools/dql-probe.js";
import { DiffbotAskTool } from "../../src/tools/ask.js";

const token = process.env.DIFFBOT_API_TOKEN;

/*
  Built even when `token` is undefined, since `describe.skipIf` still
  collects (but does not run) the tests inside — the SDK requires a
  non-empty token string at construction, so fall back to a placeholder
  that is never actually used because the tests it backs are skipped.
*/
/*
  120s rather than the SDK's 30s default: DiffbotAskTool drives the RAG LLM
  endpoint, which routinely runs 15-30s and sometimes longer. The extract/search
  /KG calls in this file are all fast, but they share the one client.
*/
const client = new DiffbotClient({
  token: token ?? "unused-token-suite-skipped",
  timeout: 120_000,
});

describe.skipIf(!token)("DiffbotExtractTool (live)", () => {
  it("extracts a stable URL", async () => {
    const tool = new DiffbotExtractTool({ client });

    const out = await tool.invoke({ url: "https://en.wikipedia.org/wiki/Knowledge_graph" });

    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect(typeof out.content).toBe("string");
      expect(out.content.length).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!token)("DiffbotWebSearchTool (live)", () => {
  it("returns a non-empty list of search results", async () => {
    const tool = new DiffbotWebSearchTool({ client });

    const out = await tool.invoke({ text: "Diffbot knowledge graph", numResults: 3 });

    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    for (const result of out) {
      expect(typeof result).toBe("object");
    }
  });
});

describe.skipIf(!token)("DiffbotEntitiesTool (live)", () => {
  it("identifies entities in a sentence naming a well-known organization", async () => {
    const tool = new DiffbotEntitiesTool({ client });

    const out = await tool.invoke({ text: "Diffbot is a company based in California." });

    expect(Array.isArray(out.entities)).toBe(true);
    expect((out.entities as unknown[]).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!token)("DiffbotKnowledgeGraphTool (live)", () => {
  it("runs a DQL query and returns the raw response", async () => {
    const tool = new DiffbotKnowledgeGraphTool({ client });

    const out = await tool.invoke({ query: "type:Organization", size: 3 });

    expect(typeof out.hits).toBe("number");
    expect(Array.isArray(out.data)).toBe(true);
  });
});

describe.skipIf(!token)("DiffbotOntologyTool (live)", () => {
  it("lists entity types, including the stable `Organization` type", async () => {
    const tool = new DiffbotOntologyTool({ client });

    const out = await tool.invoke({ op: "types" });

    expect(Array.isArray(out)).toBe(true);
    expect(out as string[]).toContain("Organization");
  });

  it("lists fields for the `Organization` type", async () => {
    const tool = new DiffbotOntologyTool({ client });

    const out = await tool.invoke({ op: "fields", name: "Organization" });

    expect(Array.isArray(out)).toBe(true);
    expect((out as string[]).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!token)("DiffbotDQLProbeTool (live)", () => {
  it("returns numeric hit counts for two query variants", async () => {
    const tool = new DiffbotDQLProbeTool({ client });

    const out = await tool.invoke({
      queries: ["type:Organization", 'type:Organization name:"Diffbot"'],
    });

    expect(out).toHaveLength(2);
    for (const result of out) {
      expect(typeof result.query).toBe("string");
      expect(typeof result.hits).toBe("number");
    }
  });
});

describe.skipIf(!token)("DiffbotAskTool (live)", () => {
  /*
    `ask` is an LLM call and can be slow, so the question is kept short.
    vitest.live.config.ts raises the timeout to 60s for exactly this reason.
  */
  it("answers a short question", async () => {
    const tool = new DiffbotAskTool({ client });

    const out = await tool.invoke({ question: "What is Diffbot?" });

    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
