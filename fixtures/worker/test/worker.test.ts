import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { DiffbotClient, KVOntologyStore, resolveTokenFromEnv } from "@diffbot/typescript";
import { ChatDiffbot, DiffbotKnowledgeGraphRetriever, DiffbotOntologyTool } from "@diffbot/langchain";
import { HumanMessage } from "@langchain/core/messages";
import { createMockFetch, jsonResponse, sseResponse } from "./mock-fetch.js";

interface FixtureEnv {
  ONTOLOGY: KVNamespace;
  DIFFBOT_API_TOKEN?: string;
}

const fixtureEnv = env as unknown as FixtureEnv;

describe("@diffbot/langchain in workerd", () => {
  it("imports and constructs a client with no compat flags", () => {
    // If this test file loaded at all, importing the package succeeded in
    // workerd without nodejs_compat on the fixture-under-test config — the
    // point of this whole fixture.
    const client = new DiffbotClient({ token: "test-token" });
    expect(client.token).toBe("test-token");
  });

  it("resolveTokenFromEnv reads the Workers env binding", () => {
    expect(resolveTokenFromEnv(undefined, { DIFFBOT_API_TOKEN: "env-token" })).toBe("env-token");
  });

  it("DiffbotKnowledgeGraphRetriever returns Documents with score in metadata", async () => {
    const client = new DiffbotClient({
      token: "test-token",
      fetch: createMockFetch(() =>
        jsonResponse({
          data: [
            {
              score: 12.5,
              entity: { id: "E1", type: "Organization", name: "Diffbot", description: "AI web data." },
            },
          ],
        }),
      ),
    });
    const retriever = new DiffbotKnowledgeGraphRetriever({ client, k: 1 });
    const docs = await retriever.invoke('type:Organization name:"Diffbot"');

    expect(docs).toHaveLength(1);
    expect(docs[0]?.metadata.score).toBe(12.5);
  });

  it("ChatDiffbot.stream() yields chunks via ReadableStream.getReader() under @langchain/core's callback machinery", async () => {
    const sse =
      'data: {"choices": [{"delta": {"content": "Hello"}}]}\n' +
      'data: {"choices": [{"delta": {"content": ", world"}}]}\n' +
      "data: [DONE]\n";
    const client = new DiffbotClient({
      token: "test-token",
      fetch: createMockFetch(() => sseResponse(sse)),
    });
    const chat = new ChatDiffbot({ client });

    const chunks: string[] = [];
    for await (const chunk of await chat.stream([new HumanMessage("hi")])) {
      chunks.push(String(chunk.content));
    }
    expect(chunks.join("")).toBe("Hello, world");
  });

  it("DiffbotOntologyTool with a KVOntologyStore serves a recycled isolate with zero fetches", async () => {
    let fetches = 0;
    const client = new DiffbotClient({
      token: "test-token",
      fetch: createMockFetch(() => {
        fetches++;
        return jsonResponse({ types: { Organization: {} } });
      }),
    });

    const first = new DiffbotOntologyTool({
      client,
      ontologyStore: new KVOntologyStore(client, fixtureEnv.ONTOLOGY),
    });
    expect(await first.invoke({ op: "types" })).toEqual(["Organization"]);
    expect(fetches).toBe(1);

    // A second, freshly constructed tool simulates a recycled Worker isolate.
    const second = new DiffbotOntologyTool({
      client,
      ontologyStore: new KVOntologyStore(client, fixtureEnv.ONTOLOGY),
    });
    expect(await second.invoke({ op: "types" })).toEqual(["Organization"]);
    expect(fetches).toBe(1);

    expect(await second.invoke({ op: "types", refresh: true })).toEqual(["Organization"]);
    expect(fetches).toBe(2);
  });
});
