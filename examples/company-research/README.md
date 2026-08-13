# Company Research CLI

A one-shot command-line agent for company research over the Diffbot Knowledge
Graph and the live web. Ask a question in plain English; the agent picks its own
approach, may iterate, and cites the entity IDs / URLs it used. Useful for shell
scripting or quick spot checks.

This is a TypeScript port of the [`company_research`](https://github.com/diffbot/langchain-diffbot/tree/main/examples/company_research)
example from the Python `langchain-diffbot` package.

## Prerequisites

- Node.js >= 20 and [pnpm](https://pnpm.io/).
- `DIFFBOT_API_TOKEN` and `ANTHROPIC_API_KEY` in the environment. Copy
  `../.env.example` to `../.env` and fill them in (the CLI loads `examples/.env`).
- The parent package must be built: `@diffbot/langchain`'s entry points
  resolve to `dist/`, which isn't produced until you build it.

## Setup

From the repo root:

```bash
pnpm build
```

Then, from this directory:

```bash
cd examples/company-research
pnpm install
```

## Run it

```bash
pnpm start "What companies in Austin work on robotics?"
pnpm start --quiet "Who are the executives at Diffbot?"
pnpm start "What did Diffbot announce most recently?"
```

By default the agent prints its tool calls and intermediate responses as it
works. Pass `--quiet` to print only the final answer.

### Example invocation

```
$ pnpm start "Who founded Diffbot and what does the company do?"

  ▸ calling: search_kg({"dqlQuery":"type:Organization name:\"Diffbot\""})
  ↳ tool search_kg: [{"summary":"Diffbot is a...","id":"<entity-id>","type":"Organization",...}]...
  ▸ calling: web_search({"query":"Diffbot founder"})
  ↳ tool web_search: [{"title":"Diffbot - Wikipedia","pageUrl":"https://en.wikipedia.org/wiki/Diffbot",...}]...

Diffbot was founded by Mike Tung (Diffbot, id=<entity-id>). The company
builds a Knowledge Graph of the public web using computer vision and
machine learning to extract structured data from web pages (diffbot.com).
```

This transcript is illustrative (shaped by hand to show the trace format), not
a captured run — this environment has no `DIFFBOT_API_TOKEN` /
`ANTHROPIC_API_KEY`, so the example has not been executed live. Run it
yourself with real credentials to see actual output.

## Tools

The agent has five tools backed by Diffbot, and chooses which to use per
question:

- `inspect_ontology(op, name?, search?)` — look up the KG schema (entity types,
  a type's fields, taxonomy/enum values) so it writes DQL with real field paths.
- `probe_dql(queries)` — get hit counts for several DQL variants at once, to
  check a query is well-shaped before committing.
- `search_kg(dqlQuery)` — Knowledge Graph search via DQL.
- `web_search(query)` — natural-language web search, for current/news-y info or
  when the KG comes up short.
- `extract_url(url)` — fetch and read a single web page.

The intended loop is **introspect (ontology) → probe → search → refine**, with
`web_search` + `extract_url` as the fallback when the KG doesn't have it.

## Model

Defaults to `anthropic:claude-haiku-4-5` because a multi-step agent loop on a
fresh Anthropic account can blow past Sonnet's 30k input-tokens-per-minute Tier
1 limit. Override with any `provider:model` string `createAgent` understands:

```bash
COMPANY_RESEARCH_MODEL=anthropic:claude-sonnet-4-6 pnpm start "..."
```

## Package classes exercised

From `@diffbot/langchain`:

- `DiffbotKnowledgeGraphRetriever` (via `search_kg`)
- `DiffbotWebSearchRetriever` (via `web_search`)
- `DiffbotExtractTool` (via `extract_url`)
- `DiffbotOntologyTool` (via `inspect_ontology`)
- `DiffbotDQLProbeTool` (via `probe_dql`)

All five share a single `DiffbotClient` from `@diffbot/typescript`, built once
and reused for the whole process so the agent's tool loop shares one
connection pool.

## Layout

```
company-research/
├── src/
│   ├── agent.ts    # createAgent + system prompt + model selection
│   ├── tools.ts     # the five Diffbot-backed tools
│   └── cli.ts        # argv parsing, runs one question, renders the trace
├── package.json
├── tsconfig.json
└── README.md
```
