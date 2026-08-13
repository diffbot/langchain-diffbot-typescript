/*
  Tools the agent can call.

  We give the agent five Diffbot-backed surfaces:

  - `inspectOntology(op, name?, search?)` — Diffbot KG ontology navigation.
  - `probeDql(queries)` — DQL hit-count probing.
  - `searchKg(dqlQuery)` — Diffbot Knowledge Graph via DQL.
  - `webSearch(query)` — Diffbot web search.
  - `extractUrl(url)` — Diffbot Analyze extract on a single URL.

  Each tool is a thin wrapper (built with `tool()` from `langchain`) that:
    1. Calls a `@diffbot/langchain` class, built once and reused for the whole
       process (one shared `DiffbotClient`, one connection pool).
    2. Shapes / truncates the response so a single tool call doesn't blow
       past the model's per-minute input-token budget. Diffbot KG entities,
       web search results, and extracted pages can each run thousands of
       tokens — without shaping, a multi-step agent will hit rate limits
       fast. The same projection-allowlist + content-truncation pattern is
       applied to each surface so the example demonstrates how to keep an
       agent loop token-efficient end-to-end.
*/

import { DiffbotClient, APIError } from "@diffbot/typescript";
import {
  DiffbotDQLProbeTool,
  DiffbotExtractTool,
  DiffbotKnowledgeGraphRetriever,
  DiffbotOntologyTool,
  DiffbotWebSearchRetriever,
} from "@diffbot/langchain";
import { tool } from "langchain";
import { z } from "zod/v3";

/*
  Projection allowlist for KG entities. Only these top-level fields ride
  along in metadata — full entities can easily be thousands of tokens each.
*/
const KG_FIELDS = [
  "id",
  "type",
  "name",
  "homepageUri",
  "nbEmployees",
  "industries",
  "location",
  "employments",
  "date",
];

const WEB_SEARCH_K = 5;
const WEB_SEARCH_CONTENT_CHARS = 800;
const EXTRACT_CONTENT_CHARS = 4000;

/*
  One client shared across every Diffbot-backed tool below, so the whole
  agent run reuses a single connection pool. Lazily constructed so importing
  this module doesn't require `DIFFBOT_API_TOKEN`. Unlike the Python original
  (which juggled a sync `Diffbot` and an async `DiffbotAsync`), the
  TypeScript SDK has one client that is async throughout, so a single
  instance covers the agent's whole tool loop.
*/
let client: DiffbotClient | undefined;

function db(): DiffbotClient {
  client ??= new DiffbotClient({ token: requireEnv("DIFFBOT_API_TOKEN") });
  return client;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

let kgRetriever: DiffbotKnowledgeGraphRetriever | undefined;

function getKgRetriever(): DiffbotKnowledgeGraphRetriever {
  kgRetriever ??= new DiffbotKnowledgeGraphRetriever({ client: db(), k: 5, fields: KG_FIELDS });
  return kgRetriever;
}

let webRetriever: DiffbotWebSearchRetriever | undefined;

function getWebRetriever(): DiffbotWebSearchRetriever {
  webRetriever ??= new DiffbotWebSearchRetriever({
    client: db(),
    k: WEB_SEARCH_K,
    fields: ["title", "pageUrl", "score"],
  });
  return webRetriever;
}

let extractTool: DiffbotExtractTool | undefined;

function getExtractTool(): DiffbotExtractTool {
  extractTool ??= new DiffbotExtractTool({ client: db() });
  return extractTool;
}

let ontologyTool: DiffbotOntologyTool | undefined;

function getOntologyTool(): DiffbotOntologyTool {
  /* Cached so the fetched ontology is reused across the whole agent run. */
  ontologyTool ??= new DiffbotOntologyTool({ client: db() });
  return ontologyTool;
}

let probeTool: DiffbotDQLProbeTool | undefined;

function getProbeTool(): DiffbotDQLProbeTool {
  probeTool ??= new DiffbotDQLProbeTool({ client: db() });
  return probeTool;
}

export const inspectOntology = tool(
  async ({ op, name, search }) => getOntologyTool().invoke({ op, name, search }),
  {
    name: "inspect_ontology",
    description:
      "Inspect the Diffbot KG schema so you can write DQL with real field paths. " +
      "Call this BEFORE guessing field names. Ops: `types`/`composites`/`enums`/" +
      "`taxonomies` — list available names. `fields` — fields of a type or " +
      'composite; pass `name` (e.g. "Organization", "Location"). Optionally pass ' +
      "`search` (regex) to filter. `taxonomy` — values of a taxonomy; pass `name` " +
      '(e.g. "OrganizationCategory"), optionally `search`. `enum` — values of an ' +
      'enum; pass `name` (e.g. "Language"). `search` — regex over every name in ' +
      "the ontology; pass the pattern as `name`. Returns a list of strings, or " +
      "`{error, hint}` if the name was wrong (list the valid names with the " +
      "matching list op, then retry).",
    schema: z.object({
      op: z
        .enum(["types", "composites", "enums", "taxonomies", "fields", "taxonomy", "enum", "search"])
        .describe("Which part of the ontology to inspect."),
      name: z.string().optional().describe("Target name for `fields`, `taxonomy`, or `enum`."),
      search: z.string().optional().describe("Optional regex to filter `fields` or `taxonomy` results."),
    }),
  },
);

export const probeDql = tool(async ({ queries }) => getProbeTool().invoke({ queries }), {
  name: "probe_dql",
  description:
    "Probe DQL variants in parallel and get the hit count for each (no entity " +
    "data). Use this to sanity-check a query's selectivity before running it " +
    "with `search_kg`: if a variant returns 0 hits it's too narrow; if it " +
    "returns a huge number it's too broad. Pass several variants at once to " +
    'compare them in a single round-trip. Returns `[{"query": ..., "hits": N}, ...]`.',
  schema: z.object({
    queries: z.array(z.string()).describe("DQL query variants to probe."),
  }),
});

export const searchKg = tool(
  async ({ dqlQuery }) => {
    try {
      const docs = await getKgRetriever().invoke(dqlQuery);
      return docs.map((doc) => ({ summary: doc.pageContent, ...doc.metadata }));
    } catch (exc) {
      /* Surface DQL syntax errors back to the model so it can refine and retry. */
      if (exc instanceof APIError) {
        return [
          {
            error:
              `Diffbot rejected the query (${exc.statusCode}): ` +
              `${exc.apiMessage ?? exc.body}. Refine the DQL and try again.`,
          },
        ];
      }
      throw exc;
    }
  },
  {
    name: "search_kg",
    description:
      "Search the Diffbot Knowledge Graph with a DQL query.\n\n" +
      "DQL (Diffbot Query Language) syntax cheatsheet:\n\n" +
      "- Filter by type: `type:Organization`, `type:Person`, `type:Article`\n" +
      '- Exact match: `name:"Diffbot"`\n' +
      "- Nested fields use dots: `location.city.name:\"Austin\"`\n" +
      "- Combine filters with spaces (AND): " +
      '`type:Organization industries:"Robotics"`\n' +
      "- Sort ascending with `sortBy:<field>`, descending with `revSortBy:<field>` " +
      "(e.g. `revSortBy:nbEmployees`). There is no `desc` keyword.\n\n" +
      "Examples:\n" +
      '    - `type:Organization location.city.name:"Austin" industries:"Robotics"`\n' +
      '    - `type:Person employments.{employer.name:"Diffbot" isCurrent:true}`\n' +
      '    - `type:Article tags.label:"Artificial Intelligence" revSortBy:date`\n\n' +
      "Returns a list of entity objects. Each entity has `summary` " +
      "(description/summary text), `id`, `type`, `name`, and a few projected " +
      "fields like `homepageUri`, `nbEmployees`, `industries`, `location`, " +
      "`employments`, `date`. Other KG fields are intentionally omitted to keep " +
      "responses small — refine the DQL query if you need different information.",
    schema: z.object({
      dqlQuery: z.string().describe("DQL query, e.g. `type:Organization name:\"Diffbot\"`."),
    }),
  },
);

export const webSearchTool = tool(
  async ({ query }) => {
    const docs = await getWebRetriever().invoke(query);
    return docs.map((doc) => ({
      ...doc.metadata,
      content: doc.pageContent.slice(0, WEB_SEARCH_CONTENT_CHARS),
    }));
  },
  {
    name: "web_search",
    description:
      "Search the web via Diffbot. Use when the KG comes up short or you need " +
      "current info. Returns up to 5 results, each with `title`, `pageUrl`, " +
      "`score`, and a truncated `content` snippet (~800 chars). If you need the " +
      "full page, pass the `pageUrl` to `extract_url`.",
    schema: z.object({
      query: z.string().describe("Natural-language search string."),
    }),
  },
);

export const extractUrl = tool(
  async ({ url }) => {
    const raw = await getExtractTool().invoke({ url });
    if ("error" in raw) {
      return raw;
    }
    return { ...raw, content: raw.content.slice(0, EXTRACT_CONTENT_CHARS) };
  },
  {
    name: "extract_url",
    description:
      "Fetch and read a single web page via Diffbot's Analyze API. Returns an " +
      "object with `content` (markdown), `title`, `pageUrl`, `type`. The content " +
      "is truncated (~4000 chars) to stay inside per-minute token budgets — call " +
      "this on specific URLs you want to drill into, not on everything.",
    schema: z.object({
      url: z.string().describe("Page to extract."),
    }),
  },
);
