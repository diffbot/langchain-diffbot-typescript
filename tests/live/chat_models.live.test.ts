/*
  Live integration tests against the real Diffbot LLM RAG (`ask`) endpoint.
  These hit a live, changing answer source and consume API quota, so
  assertions are shape-based rather than content-based. Requires
  DIFFBOT_API_TOKEN; the whole suite is skipped when it is unset (see
  vitest.live.config.ts for how this file is picked up).
*/

import { describe, expect, it } from "vitest";
import { DiffbotClient } from "@diffbot/typescript";
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { ChatDiffbot } from "../../src/chat_models.js";

const token = process.env.DIFFBOT_API_TOKEN;

/*
  Built even when `token` is undefined, since `describe.skipIf` still
  collects (but does not run) the tests inside — the SDK requires a
  non-empty token string at construction, so fall back to a placeholder
  that is never actually used because the tests it backs are skipped.
*/
/*
  The RAG LLM endpoint routinely runs 15-30s and sometimes longer, so the SDK's
  30s default timeout is too tight for it — the client is the one place to fix
  that. Anything driving `ask` (ChatDiffbot, DiffbotAskTool) wants a raised
  timeout in production too, not just in tests.
*/
const client = new DiffbotClient({
  token: token ?? "unused-token-suite-skipped",
  timeout: 120_000,
});

describe.skipIf(!token)("ChatDiffbot (live)", () => {
  it("invoke returns an AIMessage with non-empty string content", async () => {
    const llm = new ChatDiffbot({ client });

    const result = await llm.invoke([new HumanMessage("What is Diffbot?")]);

    expect(result).toBeInstanceOf(AIMessage);
    expect(typeof result.content).toBe("string");
    expect((result.content as string).length).toBeGreaterThan(0);
  });

  it("stream yields more than one chunk that join to a non-empty string", async () => {
    const llm = new ChatDiffbot({ client });

    const chunks: string[] = [];
    for await (const chunk of await llm.stream([new HumanMessage("What is Diffbot?")])) {
      if (chunk instanceof AIMessageChunk && typeof chunk.content === "string") {
        chunks.push(chunk.content);
      }
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").length).toBeGreaterThan(0);
  });
});
