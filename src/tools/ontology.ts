import { z } from "zod/v3";
import { Ontology, OntologyStore, type DiffbotClient } from "@diffbot/typescript";
import { StructuredTool, type ToolParams } from "@langchain/core/tools";
import type { InferInteropZodInput, InferInteropZodOutput } from "@langchain/core/utils/types";
import { assertClient, type DiffbotComponentFields } from "../base.js";

const schema = z.object({
  op: z
    .enum(["types", "composites", "enums", "taxonomies", "fields", "taxonomy", "enum", "search"])
    .describe(
      "Which part of the ontology to inspect: `types`/`composites`/`enums`/" +
        "`taxonomies` list names; `fields` lists the fields of a type or " +
        "composite; `taxonomy`/`enum` list a named taxonomy's/enum's values; " +
        "`search` matches any name anywhere in the ontology by regex.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Target name for `fields` (a type/composite), `taxonomy`, or `enum`; " +
        "the regex pattern for `search`. Unused by the list ops.",
    ),
  search: z
    .string()
    .optional()
    .describe("Optional case-insensitive regex to filter `fields` or `taxonomy` results."),
  refresh: z
    .boolean()
    .optional()
    .describe(
      "Discard the cached ontology and re-fetch it before running this op. " +
        "The ontology changes rarely; leave this unset unless a previous " +
        "answer looks stale.",
    ),
});

/* A recoverable failure, handed back to the agent instead of thrown. */
export interface OntologyLookupError {
  error: string;
  hint: string;
}

/* What {@link DiffbotOntologyTool} returns: a name list, or a recoverable error. */
export type OntologyLookupResult = string[] | OntologyLookupError;

const HINT =
  "Valid ops: types, composites, enums, taxonomies, fields, " +
  "taxonomy, enum, search. List names first (e.g. op='types') " +
  "before drilling into fields/taxonomy/enum.";

/*
  Run one ontology navigation op, returning a list or a recoverable error object.

  Unknown type/taxonomy/enum names and missing-argument errors are returned as
  `{error, hint}` so the agent can correct itself and retry rather than the tool
  call raising. The SDK's `Ontology` throws plain `Error`s, so this catches
  broadly rather than matching on an error class.
*/
function ontologyLookup(
  ont: Ontology,
  op: string,
  name: string | undefined,
  search: string | undefined,
): OntologyLookupResult {
  try {
    switch (op) {
      case "types":
        return ont.types();
      case "composites":
        return ont.composites();
      case "enums":
        return ont.enums();
      case "taxonomies":
        return ont.taxonomies();
      case "fields": {
        if (!name) {
          throw new Error("op='fields' requires `name` (the entity type or composite).");
        }
        const fields = ont.fieldsFor(name);
        return Ontology.filterFields(fields, search).map(([n, m]) => Ontology.formatField(n, m));
      }
      case "taxonomy": {
        if (!name) {
          throw new Error("op='taxonomy' requires `name` (the taxonomy).");
        }
        return ont.taxonomyValues(name, search);
      }
      case "enum": {
        if (!name) {
          throw new Error("op='enum' requires `name` (the enum).");
        }
        return ont.enumValues(name);
      }
      case "search": {
        if (!name) {
          throw new Error("op='search' requires `name` (the regex to match).");
        }
        return ont.findNamed(name);
      }
      default:
        throw new Error(`Unknown op '${op}'.`);
    }
  } catch (exc) {
    return {
      error: exc instanceof Error ? exc.message : String(exc),
      hint: HINT,
    };
  }
}

export interface DiffbotOntologyToolFields extends ToolParams, DiffbotComponentFields {
  /*
    Defaults to `new OntologyStore(client)` — an in-memory cache for the
    life of this tool instance, matching the tool's prior built-in behavior.
    In a Cloudflare Worker, where isolates are recycled between requests,
    pass a durable store instead: `new KVOntologyStore(client, env.ONTOLOGY)`.
  */
  ontologyStore?: OntologyStore;
}

/*
  Tool that navigates the Diffbot Knowledge Graph ontology.

  Lets an agent discover real entity types, field paths, taxonomy values, and
  enum values *before* writing a DQL query — so it constructs valid queries
  instead of guessing field names. Fetching and caching the ontology is the
  SDK's `OntologyStore`'s job, not this tool's — this tool just calls
  `ontologyStore.load({ refresh })`.
*/
export class DiffbotOntologyTool extends StructuredTool<
  typeof schema,
  InferInteropZodOutput<typeof schema>,
  InferInteropZodInput<typeof schema>,
  OntologyLookupResult
> {
  static lc_name(): string {
    return "DiffbotOntologyTool";
  }

  override get lc_namespace(): string[] {
    return ["langchain", "tools", "diffbot"];
  }

  name = "diffbot_ontology";

  description =
    "Inspect the Diffbot Knowledge Graph schema to build valid DQL. Ops: " +
    "`types`/`composites`/`enums`/`taxonomies` (list names), `fields` " +
    "(fields of a type/composite — pass `name`), `taxonomy`/`enum` (values " +
    "of a named taxonomy/enum — pass `name`), `search` (regex over all " +
    "names — pass the pattern as `name`). Look fields up here before " +
    "writing a DQL query.";

  schema = schema;

  client: DiffbotClient;
  ontologyStore: OntologyStore;

  constructor(fields: DiffbotOntologyToolFields) {
    super(fields);
    this.client = assertClient(fields.client);
    this.ontologyStore = fields.ontologyStore ?? new OntologyStore(this.client);
  }

  async _call({
    op,
    name,
    search,
    refresh,
  }: InferInteropZodOutput<typeof schema>): Promise<OntologyLookupResult> {
    const ont = await this.ontologyStore.load({ refresh });
    return ontologyLookup(ont, op, name, search);
  }
}
