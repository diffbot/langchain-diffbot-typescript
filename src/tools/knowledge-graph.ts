import { dql, type DiffbotClient, type JsonObject } from "@diffbot/typescript";
import { StructuredTool, type ToolParams } from "@langchain/core/tools";
import type { InferInteropZodOutput } from "@langchain/core/utils/types";
import { z } from "zod/v3";
import { assertClient, type DiffbotComponentFields } from "../base.js";

const schema = z.object({
  query: z.string().describe('DQL query, e.g. `type:Organization name:"Diffbot"`.'),
  size: z.number().int().default(10).describe("Max results."),
  /* Python names this `from_` to dodge the keyword; TypeScript can use `from`. */
  from: z.number().int().default(0).describe("Result offset."),
  filter: z.string().optional().describe("Optional DQL filter expression."),
});

export interface DiffbotKnowledgeGraphToolFields extends ToolParams, DiffbotComponentFields {}

/*
  Tool that runs a DQL query against the Diffbot Knowledge Graph.

  Returns the raw response object (with `data`, `hits`, etc.). For LangChain
  `Document` output use `DiffbotKnowledgeGraphRetriever` instead.

  Best for agents that have been instructed in DQL syntax.
*/
export class DiffbotKnowledgeGraphTool extends StructuredTool<
  typeof schema,
  InferInteropZodOutput<typeof schema>,
  z.input<typeof schema>,
  JsonObject
> {
  static lc_name(): string {
    return "DiffbotKnowledgeGraphTool";
  }

  /* An accessor, not a field: the base class declares `lc_namespace` as a getter. */
  override get lc_namespace(): string[] {
    return ["langchain", "tools", "diffbot"];
  }

  name = "diffbot_knowledge_graph";

  description =
    "Query the Diffbot Knowledge Graph with a DQL expression " +
    '(e.g. `type:Organization location.city.name:"Boston"`). ' +
    "Returns the raw response — use only if you know DQL syntax.";

  schema = schema;

  client: DiffbotClient;

  constructor(fields: DiffbotKnowledgeGraphToolFields) {
    super(fields);
    this.client = assertClient(fields.client);
  }

  async _call(input: InferInteropZodOutput<typeof schema>): Promise<JsonObject> {
    const body = await dql(this.client, input.query, {
      size: input.size,
      from: input.from,
      ...(input.filter !== undefined ? { filter: input.filter } : {}),
    });

    if (body instanceof Uint8Array || typeof body !== "object" || body === null) {
      throw new TypeError("Unexpected non-JSON DQL response.");
    }
    return body;
  }
}
