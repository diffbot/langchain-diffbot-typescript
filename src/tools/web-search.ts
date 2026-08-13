import { webSearch, type DiffbotClient, type JsonObject } from "@diffbot/typescript";
import { StructuredTool, type ToolParams } from "@langchain/core/tools";
import type { InferInteropZodOutput } from "@langchain/core/utils/types";
import { z } from "zod/v3";
import { assertClient, type DiffbotComponentFields } from "../base.js";

const schema = z.object({
  text: z.string().describe("Natural-language search query."),
  numResults: z
    .number()
    .int()
    .optional()
    .describe("Max results to return. Server default if unset."),
  maxTokens: z.number().int().optional().describe("Optional total content-token cap."),
});

export interface DiffbotWebSearchToolFields extends ToolParams, DiffbotComponentFields {}

/*
  Tool that performs a Diffbot web search and returns the raw result list.

  Use this when the agent needs the search results as-is (with score, title,
  pageUrl, content). For LangChain `Document` output use
  `DiffbotWebSearchRetriever` instead.
*/
export class DiffbotWebSearchTool extends StructuredTool<
  typeof schema,
  InferInteropZodOutput<typeof schema>,
  z.input<typeof schema>,
  JsonObject[]
> {
  static lc_name(): string {
    return "DiffbotWebSearchTool";
  }

  /* An accessor, not a field: the base class declares `lc_namespace` as a getter. */
  override get lc_namespace(): string[] {
    return ["langchain", "tools", "diffbot"];
  }

  name = "diffbot_web_search";

  description =
    "Search the web via Diffbot. Returns a list of results, each with " +
    "title, pageUrl, score, and content.";

  schema = schema;

  client: DiffbotClient;

  constructor(fields: DiffbotWebSearchToolFields) {
    super(fields);
    this.client = assertClient(fields.client);
  }

  async _call(input: InferInteropZodOutput<typeof schema>): Promise<JsonObject[]> {
    /* The SDK sends `numResults` on the wire as `size`. */
    const body = await webSearch(this.client, input.text, {
      ...(input.numResults !== undefined ? { numResults: input.numResults } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    });
    const results = body.search_results;
    return Array.isArray(results) ? (results as JsonObject[]) : [];
  }
}
