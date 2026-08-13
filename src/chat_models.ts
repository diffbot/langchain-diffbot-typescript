/*
  Chat model backed by Diffbot's LLM RAG (`ask`) endpoint.

  The SDK streams tokens natively, so this class implements
  `_streamResponseChunks`. `_generate` drains that stream and aggregates it
  into a single `ChatGeneration`. `stop` is accepted (as part of the parsed
  call options) but ignored — the endpoint takes only messages.

  Client-only, like every component in this package: build a `DiffbotClient`
  and pass it in. There are no fields beyond `client` — the SDK's `ask`
  hardcodes `model: "diffbot-small-xl"` and `stream: true` and exposes no
  other knobs.
*/

import { ask, type ChatMessage, type DiffbotClient } from "@diffbot/typescript";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { assertClient, type DiffbotComponentFields } from "./base.js";

function toDiffbotMessages(messages: BaseMessage[]): ChatMessage[] {
  return messages.map((message) => {
    let role: string;
    switch (message.getType()) {
      case "human":
        role = "user";
        break;
      case "ai":
        role = "assistant";
        break;
      case "system":
        role = "system";
        break;
      default:
        /* Fall back on the message's own type for anything exotic. */
        role = message.getType();
    }
    const content =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return { role, content };
  });
}

export interface ChatDiffbotFields extends BaseChatModelParams, DiffbotComponentFields {}

/*
  Chat model that calls Diffbot's LLM RAG (`ask`) endpoint.

  Example:
    const llm = new ChatDiffbot({ client: new DiffbotClient({ token: ... }) });
    await llm.invoke("What's the capital of France?");
*/
export class ChatDiffbot extends BaseChatModel {
  static lc_name(): string {
    return "ChatDiffbot";
  }

  lc_namespace = ["langchain", "chat_models", "diffbot"];

  client: DiffbotClient;

  constructor(fields: ChatDiffbotFields) {
    super(fields);
    this.client = assertClient(fields.client);
  }

  _llmType(): string {
    return "diffbot";
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const payload = toDiffbotMessages(messages);
    for await (const chunk of ask(this.client, payload)) {
      await runManager?.handleLLMNewToken(chunk);
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({ content: chunk }),
        text: chunk,
      });
    }
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let text = "";
    for await (const chunk of this._streamResponseChunks(messages, options, runManager)) {
      text += chunk.text;
    }
    return {
      generations: [{ message: new AIMessage({ content: text }), text }],
    };
  }
}
