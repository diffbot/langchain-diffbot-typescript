import { describe, expect, it } from "vitest";
import { DiffbotClient } from "@diffbot/typescript";
import { DiffbotAskTool } from "../../src/tools/ask.js";
import {
  createMockFetch,
  jsonResponse,
  sseResponse,
  type MockHandler,
} from "../helpers/mock-fetch.js";

const ASK_URL = "https://llm.diffbot.com/rag/v1/chat/completions";

const ASK_SSE =
  'data: {"choices": [{"delta": {"content": "Diffbot was "}}]}\n' +
  'data: {"choices": [{"delta": {"content": "founded in 2008."}}]}\n' +
  "data: [DONE]\n";

function makeClient(handler: MockHandler): DiffbotClient {
  return new DiffbotClient({
    token: "test-token",
    fetch: createMockFetch(handler),
  });
}

describe("DiffbotAskTool identity", () => {
  it("exposes the LangChain tool surface", () => {
    const tool = new DiffbotAskTool({
      client: makeClient(() => jsonResponse({})),
    });
    expect(DiffbotAskTool.lc_name()).toBe("DiffbotAskTool");
    expect(tool.name).toBe("diffbot_ask");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.lc_namespace).toEqual(["langchain", "tools", "diffbot"]);
  });
});

describe("DiffbotAskTool", () => {
  it("aggregates a multi-chunk stream into one answer", async () => {
    const db = makeClient((req) => {
      expect(req.url).toBe(ASK_URL);
      expect(req.method).toBe("POST");
      const payload = JSON.parse(req.body ?? "{}") as {
        messages: Array<{ role: string; content: string }>;
        stream: boolean;
      };
      expect(payload.messages).toEqual([{ role: "user", content: "When was Diffbot founded?" }]);
      expect(payload.stream).toBe(true);
      return sseResponse(ASK_SSE);
    });

    const out = await new DiffbotAskTool({ client: db }).invoke({
      question: "When was Diffbot founded?",
    });

    expect(out).toBe("Diffbot was founded in 2008.");
  });

  it("returns an empty string when the stream carries no content", async () => {
    const db = makeClient(() => sseResponse("data: [DONE]\n"));
    const out = await new DiffbotAskTool({ client: db }).invoke({
      question: "anything?",
    });
    expect(out).toBe("");
  });
});
