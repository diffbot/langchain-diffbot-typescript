import { entities, type DiffbotClient, type JsonObject } from "@diffbot/typescript";
import { StructuredTool, type ToolParams } from "@langchain/core/tools";
import type { InferInteropZodOutput } from "@langchain/core/utils/types";
import { z } from "zod/v3";
import { assertClient, type DiffbotComponentFields } from "../base.js";

const schema = z.object({
  text: z.string().describe("Text to extract entities and sentiment from."),
  lang: z.string().default("auto").describe("Language hint (`auto` to detect)."),
});

export interface DiffbotEntitiesToolFields extends ToolParams, DiffbotComponentFields {}

/*
  Tool that identifies entities and sentiment in text via Diffbot NLP.

  Returns the SDK response object as-is — it's small (entity list + sentiment).
  Entity IDs in the response can be looked up in the KG via
  `DiffbotKnowledgeGraphTool` or `DiffbotKnowledgeGraphRetriever` using
  `id:or("id1","id2",...)`.
*/
export class DiffbotEntitiesTool extends StructuredTool<
  typeof schema,
  InferInteropZodOutput<typeof schema>,
  z.input<typeof schema>,
  JsonObject
> {
  static lc_name(): string {
    return "DiffbotEntitiesTool";
  }

  /* An accessor, not a field: the base class declares `lc_namespace` as a getter. */
  override get lc_namespace(): string[] {
    return ["langchain", "tools", "diffbot"];
  }

  name = "diffbot_entities";

  description =
    "Identify entities (people, organizations, places, ...) and sentiment " +
    "in a piece of text. Returns entity IDs that can be looked up in the " +
    "Diffbot Knowledge Graph.";

  schema = schema;

  client: DiffbotClient;

  constructor(fields: DiffbotEntitiesToolFields) {
    super(fields);
    this.client = assertClient(fields.client);
  }

  async _call(input: InferInteropZodOutput<typeof schema>): Promise<JsonObject> {
    return entities(this.client, input.text, input.lang);
  }
}
