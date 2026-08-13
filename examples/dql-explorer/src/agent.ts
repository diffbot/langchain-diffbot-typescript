/*
  The DQL-authoring agent.

  Unlike `company-research`, this agent does NOT run the Knowledge Graph query
  itself. It only *authors* it: it inspects the ontology and probes hit counts,
  then returns a structured `DQLPlan` (the final DQL plus the columns to show).
  The server (see `server.ts`) runs that DQL deterministically and builds the
  table, so the rendered rows are always real KG data — never model output.
*/

import { z } from "zod/v3";
import { APIError, type DiffbotClient } from "@diffbot/typescript";
import { DiffbotDQLProbeTool, DiffbotOntologyTool } from "@diffbot/langchain";
import { createAgent, initChatModel, tool } from "langchain";

/*
  Override with DQL_EXPLORER_MODEL=anthropic:claude-sonnet-4-6 (or any
  `provider:model` string `initChatModel` understands). Default to Haiku for the
  same reason as the CLI example: a multi-step authoring loop on a fresh Tier 1
  Anthropic account can blow past Sonnet's 30k input-tokens/minute cap.
*/
const DEFAULT_MODEL = process.env.DQL_EXPLORER_MODEL ?? "anthropic:claude-haiku-4-5";

const columnSchema = z.object({
  path: z
    .string()
    .describe(
      "Dot-path into a KG entity, e.g. 'name', 'nbEmployees', or " +
        "'location.city.name'. Must be a real field path you confirmed via " +
        "inspect_ontology — do not invent paths.",
    ),
  label: z.string().describe("Human-readable column header, e.g. 'City'."),
});

/* The agent's structured answer: a query plus how to display its results. */
export const dqlPlanSchema = z.object({
  entityType: z
    .string()
    .describe("The primary KG entity type the query targets, e.g. 'Organization'."),
  dql: z.string().describe("The final, validated DQL query to run."),
  columns: z
    .array(columnSchema)
    .describe("4-6 high-level columns to show. Keep it concise and readable."),
  notes: z
    .string()
    .optional()
    .describe("Optional one-line note about the query (assumptions, caveats)."),
});

export type DQLPlan = z.infer<typeof dqlPlanSchema>;

/*
  Cap ontology list results. Full ontology dumps (every type, or every field of
  a big type) run thousands of tokens; re-sent each agent turn they pile up fast
  and trip per-minute input-token rate limits. Capping keeps the loop affordable;
  the agent is told to narrow with `search` when a result is truncated.
*/
const ONTOLOGY_MAX_ITEMS = 80;

const inspectOntologySchema = z.object({
  op: z
    .enum(["types", "composites", "enums", "taxonomies", "fields", "taxonomy", "enum", "search"])
    .describe(
      "types/composites/enums/taxonomies list names; fields lists the fields of " +
        "a type or composite; taxonomy/enum list a named taxonomy's/enum's " +
        "values; search matches any name anywhere in the ontology by regex.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      'Target name for `fields` (e.g. "Organization", "Location"), `taxonomy` ' +
        '(e.g. "OrganizationCategory"), or `enum` (e.g. "Language"); the regex ' +
        "pattern for `search`. Unused by the list ops.",
    ),
  search: z
    .string()
    .optional()
    .describe("Optional regex to filter `fields` or `taxonomy` results."),
});

function buildInspectOntologyTool(ontologyTool: DiffbotOntologyTool) {
  return tool(
    async ({ op, name, search }) => {
      const result = await ontologyTool.invoke({ op, name, search });
      if (Array.isArray(result) && result.length > ONTOLOGY_MAX_ITEMS) {
        const kept = result.slice(0, ONTOLOGY_MAX_ITEMS);
        kept.push(
          `... (${result.length - ONTOLOGY_MAX_ITEMS} more truncated — ` +
            "pass a `search` regex to narrow this list)",
        );
        return kept;
      }
      return result;
    },
    {
      name: "inspect_ontology",
      description:
        "Inspect the Diffbot KG schema so you can write DQL with real field paths. " +
        "Call this BEFORE guessing field names or column paths. Ops: `types` / " +
        "`composites` / `enums` / `taxonomies` — list available names. `fields` — " +
        'fields of a type or composite; pass `name` (e.g. "Organization", ' +
        '"Location"). Optionally pass `search` (regex) to filter. `taxonomy` — ' +
        'values of a taxonomy; pass `name` (e.g. "OrganizationCategory"), ' +
        'optionally `search`. `enum` — values of an enum; pass `name` (e.g. ' +
        '"Language"). `search` — regex over every name in the ontology; pass ' +
        "the pattern as `name`. Returns a list of strings, or `{error: ...}` if " +
        "the name was wrong (list the valid names with the matching list op, " +
        "then retry). Long results are capped; if you see a truncation marker, " +
        "pass a `search` regex to narrow them.",
      schema: inspectOntologySchema,
    },
  );
}

const probeDqlSchema = z.object({
  queries: z.array(z.string()).describe("DQL query variants to probe."),
});

function buildProbeDqlTool(probeTool: DiffbotDQLProbeTool) {
  return tool(
    async ({ queries }) => {
      try {
        return await probeTool.invoke({ queries });
      } catch (exc) {
        if (exc instanceof APIError) {
          /*
            One bad variant fails the whole batch. Surface the error so the
            agent can fix the syntax and re-probe, rather than crashing the run.
          */
          return [
            {
              error:
                `Diffbot rejected a query (${exc.statusCode}): ` +
                `${exc.apiMessage ?? "syntax error"}. Fix the DQL and re-probe.`,
            },
          ];
        }
        throw exc;
      }
    },
    {
      name: "probe_dql",
      description:
        "Probe DQL variants in parallel and get the hit count for each (no " +
        "entity data). Use this to sanity-check a query's selectivity before " +
        "settling on it: if a variant returns 0 hits it's too narrow; if it " +
        "returns a huge number it's too broad. Pass several variants at once " +
        'to compare them in a single round-trip. Returns `[{query, hits}, ...]`. ' +
        "If Diffbot rejects a variant (DQL syntax error), this returns an " +
        "`error` instead of raising — read it, fix the offending variant, and " +
        "probe again.",
      schema: probeDqlSchema,
    },
  );
}

const SYSTEM_PROMPT = `\
You are a DQL-authoring assistant for the Diffbot Knowledge Graph. The user
gives you a question in plain English. Your job is to turn it into ONE valid DQL
query and choose a small set of high-level columns to display — then return a
DQLPlan. You do NOT run the query yourself; the server runs it and renders the
results, so getting the DQL and column paths right is the whole task.

You have two tools:
- inspect_ontology(op, name?, search?) — look up the KG schema: entity types,
  the fields of a type/composite, taxonomy values, enum values. Use this to find
  the EXACT field path or taxonomy value before writing DQL — don't guess.
- probe_dql(queries) — run several DQL variants at once and get just their hit
  counts. Use it to check a query is well-shaped (not 0 hits, not millions).

DQL syntax cheatsheet:
- Filter by type: type:Organization, type:Person, type:Article
- Exact match: name:"Diffbot"
- Nested fields use dots: location.city.name:"Austin"
- Combine filters with spaces (AND): type:Organization industries:"Robotics"
- Sort ascending with sortBy:<field>; sort descending with revSortBy:<field>
  (e.g. revSortBy:nbEmployees for the largest first). There is NO desc
  keyword — "sortBy:nbEmployees desc" is invalid.

Workflow (do this, don't hand-wave the DQL):
  1. Decide the entity type. If unsure a field path or taxonomy/enum value
     exists, confirm it with inspect_ontology first. E.g. op="fields",
     name="Organization" to see an Organization's fields, or op="taxonomy",
     name="OrganizationCategory", search="semiconductor" for a category value.
  2. Draft 2-3 DQL variants and probe_dql them together. Keep the variant whose
     hit count looks right; loosen if 0, tighten if huge.
  3. Choose 4-6 high-level columns. Each column path MUST be a real field path
     you confirmed in the ontology (e.g. name, nbEmployees,
     location.city.name, homepageUri). Prefer short, recognizable fields;
     include name first when the type has one.
  4. If a sort makes the table more useful (e.g. largest companies first), add
     revSortBy:<field> (descending) or sortBy:<field> (ascending) to the DQL.

MANDATORY before you answer: probe_dql your FINAL query (the exact string you'll
return) and confirm it returns hits > 0 and no error. If probe reports an error,
the query is invalid — read the message, fix the syntax (re-check the ontology if
it's a bad field path), and probe again. Never return a query you haven't probed
successfully. If after a few attempts you can't get hits, loosen the filters and
return the best probed variant with a notes explaining the compromise.

Return a DQLPlan with entityType, the final dql, the columns, and an optional
one-line notes. Do not include columns whose paths you did not verify.`;

/*
  Build the structured DQL-authoring agent.

  `client` is shared with the rest of the app (see server.ts) — the ontology and
  probe tools reuse its connection pool.
*/
export async function buildDqlAgent(client: DiffbotClient) {
  /*
    Bound retries so a rate-limited (429) request fails fast and surfaces a
    clear error in the UI, instead of the SDK silently honoring `retry-after`
    and hanging for minutes. Tight Anthropic tiers hit this easily — see the
    rate-limit note in the README.
  */
  const model = await initChatModel(DEFAULT_MODEL, { maxRetries: 1 });

  const ontologyTool = new DiffbotOntologyTool({ client });
  const probeTool = new DiffbotDQLProbeTool({ client });

  return createAgent({
    model,
    tools: [buildInspectOntologyTool(ontologyTool), buildProbeDqlTool(probeTool)],
    systemPrompt: SYSTEM_PROMPT,
    responseFormat: dqlPlanSchema,
  });
}
