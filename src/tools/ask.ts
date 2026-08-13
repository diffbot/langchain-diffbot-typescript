import { z } from "zod/v3";
import { ask, type DiffbotClient } from "@diffbot/typescript";
import { StructuredTool, type ToolParams } from "@langchain/core/tools";
import type { InferInteropZodInput, InferInteropZodOutput } from "@langchain/core/utils/types";
import { assertClient, type DiffbotComponentFields } from "../base.js";

const schema = z.object({
  question: z.string().describe("Natural-language question for Diffbot's RAG LLM."),
});

export interface DiffbotAskToolFields extends ToolParams, DiffbotComponentFields {}

/*
  Tool that asks Diffbot's LLM RAG (`ask`) endpoint a natural-language question.

  Where `DiffbotKnowledgeGraphTool` runs a precise DQL query, this delegates a
  fuzzy question to Diffbot's own LLM — grounded in the Knowledge Graph and the
  live web — and returns a synthesized answer. Drop it into any tool-calling
  agent so the agent can *consult* Diffbot for things it can't express in DQL.

  The SDK streams the answer; this tool aggregates the stream into a single
  string (use `ChatDiffbot` when you want the chat-model surface with streaming).
*/
export class DiffbotAskTool extends StructuredTool<
  typeof schema,
  InferInteropZodOutput<typeof schema>,
  InferInteropZodInput<typeof schema>,
  string
> {
  static lc_name(): string {
    return "DiffbotAskTool";
  }

  override get lc_namespace(): string[] {
    return ["langchain", "tools", "diffbot"];
  }

  name = "diffbot_ask";

  description =
    "Ask Diffbot's LLM a natural-language question. It answers using " +
    "Diffbot's Knowledge Graph and a live web search, returning a synthesized " +
    "answer with sources. Use for open-ended questions you can't express as a " +
    "precise Knowledge Graph (DQL) query.";

  schema = schema;

  client: DiffbotClient;

  constructor(fields: DiffbotAskToolFields) {
    super(fields);
    this.client = assertClient(fields.client);
  }

  async _call({ question }: InferInteropZodOutput<typeof schema>): Promise<string> {
    const parts: string[] = [];
    for await (const chunk of ask(this.client, [{ role: "user", content: question }])) {
      parts.push(chunk);
    }
    return parts.join("");
  }
}
