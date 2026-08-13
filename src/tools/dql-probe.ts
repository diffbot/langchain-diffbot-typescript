import { z } from "zod/v3";
import { dqlParallel, type DiffbotClient } from "@diffbot/typescript";
import { StructuredTool, type ToolParams } from "@langchain/core/tools";
import type { InferInteropZodInput, InferInteropZodOutput } from "@langchain/core/utils/types";
import { assertClient, type DiffbotComponentFields } from "../base.js";

const schema = z.object({
  queries: z
    .array(z.string())
    .describe("DQL query variants to probe. Each is run with size=0 (hit count only)."),
  workers: z.number().int().default(8).describe("Max concurrent requests."),
});

/* One probed query and its match count (`null` when the response carried none). */
export interface DQLProbeResult {
  query: string;
  hits: unknown;
}

export interface DiffbotDQLProbeToolFields extends ToolParams, DiffbotComponentFields {}

/*
  Tool that probes DQL query variants in parallel, returning hit counts only.

  Each query runs with `size: 0`, so the response carries the match count but no
  entity data — cheap and fast. Use it to check a query's selectivity (too
  broad? too narrow?) and compare variants before committing to a full
  `diffbot_knowledge_graph` query. Backed by the SDK's `dqlParallel()`.
*/
export class DiffbotDQLProbeTool extends StructuredTool<
  typeof schema,
  InferInteropZodOutput<typeof schema>,
  InferInteropZodInput<typeof schema>,
  DQLProbeResult[]
> {
  static lc_name(): string {
    return "DiffbotDQLProbeTool";
  }

  override get lc_namespace(): string[] {
    return ["langchain", "tools", "diffbot"];
  }

  name = "diffbot_dql_probe";

  description =
    "Probe one or more DQL query variants in parallel and get the hit count " +
    "for each (size=0, no entity data). Use to validate that a query is " +
    "well-shaped — not matching zero results or millions — before running it.";

  schema = schema;

  client: DiffbotClient;

  constructor(fields: DiffbotDQLProbeToolFields) {
    super(fields);
    this.client = assertClient(fields.client);
  }

  async _call({
    queries,
    workers,
  }: InferInteropZodOutput<typeof schema>): Promise<DQLProbeResult[]> {
    const results = await dqlParallel(
      this.client,
      queries.map((query) => ({ query, size: 0 })),
      workers,
    );

    /*
      `dqlParallel` preserves input order, so results zip positionally with the
      queries. A non-JSON body (raw bytes) has no hit count — report `null`
      rather than inventing one.
    */
    return queries.map((query, i) => {
      const result = results[i];
      const hits =
        result && typeof result === "object" && !(result instanceof Uint8Array)
          ? ((result as Record<string, unknown>).hits ?? null)
          : null;
      return { query, hits };
    });
  }
}
