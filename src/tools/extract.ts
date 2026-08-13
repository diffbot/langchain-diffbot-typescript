import { extract, ExtractionError, type DiffbotClient } from "@diffbot/typescript";
import { StructuredTool, type ToolParams } from "@langchain/core/tools";
import type { InferInteropZodOutput } from "@langchain/core/utils/types";
import { z } from "zod/v3";
import {
  assertClient,
  shapeExtractResponse,
  type DiffbotComponentFields,
  type ShapedExtractResponse,
} from "../base.js";

const schema = z.object({
  url: z.string().describe("URL to extract structured content from."),
  api: z
    .string()
    .default("analyze")
    .describe("Diffbot extract API to call. Defaults to `analyze` (auto-detects content type)."),
  fmt: z
    .string()
    .default("markdown")
    .describe("Output format. `markdown` uses Diffbot's LLM-optimized mode."),
});

/* Returned instead of the shaped response when Diffbot could not read the page. */
export interface DiffbotExtractToolError {
  error: string;
  errorCode: number;
}

export type DiffbotExtractToolOutput = ShapedExtractResponse | DiffbotExtractToolError;

export interface DiffbotExtractToolFields extends ToolParams, DiffbotComponentFields {}

/*
  Tool that extracts structured content from a URL via Diffbot's analyze API.

  Returns a small object so the agent doesn't have to wade through the full raw
  response. On extraction failure (a 200 response with an `errorCode` body)
  returns a structured error object instead of throwing, so the agent can react.
  Auth / rate-limit errors propagate as exceptions — those are infra problems,
  not per-call signals.
*/
export class DiffbotExtractTool extends StructuredTool<
  typeof schema,
  InferInteropZodOutput<typeof schema>,
  z.input<typeof schema>,
  DiffbotExtractToolOutput
> {
  static lc_name(): string {
    return "DiffbotExtractTool";
  }

  /* An accessor, not a field: the base class declares `lc_namespace` as a getter. */
  override get lc_namespace(): string[] {
    return ["langchain", "tools", "diffbot"];
  }

  name = "diffbot_extract";

  description =
    "Extract structured content (title, text, type, resolved URL) from a " +
    "single web page. Use for reading the contents of a known URL.";

  schema = schema;

  client: DiffbotClient;

  constructor(fields: DiffbotExtractToolFields) {
    super(fields);
    this.client = assertClient(fields.client);
  }

  async _call(input: InferInteropZodOutput<typeof schema>): Promise<DiffbotExtractToolOutput> {
    try {
      const raw = await extract(this.client, input.url, input.api, input.fmt);
      return shapeExtractResponse(raw);
    } catch (e) {
      /*
        Only extraction failures become data. AuthError / RateLimitError keep
        propagating — those are infra problems, not per-call signals.
      */
      if (e instanceof ExtractionError) {
        return { error: e.message, errorCode: e.errorCode };
      }
      throw e;
    }
  }
}
