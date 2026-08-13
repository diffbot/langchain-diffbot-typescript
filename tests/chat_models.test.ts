import { describe, expect, it } from "vitest";
import { DiffbotClient } from "@diffbot/typescript";
import { AIMessageChunk, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatDiffbot } from "../src/chat_models.js";
import { createMockFetch, sseResponse, type MockHandler } from "./helpers/mock-fetch.js";

const ASK_URL = "https://llm.diffbot.com/rag/v1/chat/completions";

const SSE_BODY =
  'data: {"choices": [{"delta": {"content": "Hello"}}]}\n' +
  'data: {"choices": [{"delta": {"content": ", "}}]}\n' +
  'data: {"choices": [{"delta": {"content": "world"}}]}\n' +
  "data: [DONE]\n";

function makeClient(handler: MockHandler): DiffbotClient {
  return new DiffbotClient({ token: "test-token", fetch: createMockFetch(handler) });
}

describe("ChatDiffbot identity", () => {
  it("reports its LangChain type and namespace", () => {
    const llm = new ChatDiffbot({ client: makeClient(() => sseResponse(SSE_BODY)) });
    expect(ChatDiffbot.lc_name()).toBe("ChatDiffbot");
    expect(llm.lc_namespace).toEqual(["langchain", "chat_models", "diffbot"]);
    expect(llm._llmType()).toBe("diffbot");
  });
});

describe("ChatDiffbot.stream", () => {
  it("yields chunks that join to the full streamed answer", async () => {
    const db = makeClient((req) => {
      expect(req.url).toBe(ASK_URL);
      expect(req.method).toBe("POST");
      return sseResponse(SSE_BODY);
    });
    const llm = new ChatDiffbot({ client: db });

    const parts: string[] = [];
    for await (const chunk of await llm.stream([new HumanMessage("hi")])) {
      if (chunk instanceof AIMessageChunk && typeof chunk.content === "string") {
        parts.push(chunk.content);
      }
    }
    expect(parts.join("")).toBe("Hello, world");
  });
});

describe("ChatDiffbot.invoke", () => {
  it("aggregates the stream into a single AIMessage", async () => {
    const db = makeClient(() => sseResponse(SSE_BODY));
    const llm = new ChatDiffbot({ client: db });

    const result = await llm.invoke([new HumanMessage("hi")]);

    expect(result.content).toBe("Hello, world");
  });
});

describe("ChatDiffbot message role mapping", () => {
  it("maps SystemMessage -> system and HumanMessage -> user on the wire", async () => {
    let body: string | undefined;
    const db = makeClient((req) => {
      body = req.body;
      return sseResponse(SSE_BODY);
    });
    const llm = new ChatDiffbot({ client: db });

    await llm.invoke([new SystemMessage("you are a bot"), new HumanMessage("hi")]);

    const payload = JSON.parse(body ?? "{}") as {
      messages: Array<{ role: string; content: string }>;
    };
    const roles = payload.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user"]);
    expect(payload.messages[0]!.content).toBe("you are a bot");
    expect(payload.messages[1]!.content).toBe("hi");
  });
});
