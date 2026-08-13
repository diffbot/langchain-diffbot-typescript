# @diffbot/langchain

[![CI](https://github.com/diffbot/diffbot-langchain-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/diffbot/diffbot-langchain-typescript/actions/workflows/ci.yml)

A thin LangChain.js integration over the official [`@diffbot/typescript`](https://github.com/diffbot/diffbot-typescript) SDK. Every Diffbot API gets the closest LangChain primitive:

| Diffbot API           | LangChain class(es)                                           |
| --------------------- | ------------------------------------------------------------- |
| Knowledge Graph (DQL) | `DiffbotKnowledgeGraphRetriever`, `DiffbotKnowledgeGraphTool` |
| Web Search            | `DiffbotWebSearchRetriever`, `DiffbotWebSearchTool`           |
| Extract (Analyze)     | `DiffbotExtractTool`, `DiffbotExtractLoader`                  |
| NLP entities          | `DiffbotEntitiesTool`                                         |
| Crawl                 | `DiffbotCrawlLoader`                                          |
| LLM RAG (`ask`)       | `ChatDiffbot` (with native streaming), `DiffbotAskTool`       |

This is the TypeScript sibling of the Python package [`langchain-diffbot`](https://github.com/diffbot/langchain-diffbot). The class names and options line up deliberately; the handful of places they diverge are listed under [Differences from the Python package](#differences-from-the-python-package).

## Installation

```bash
pnpm add @diffbot/langchain @langchain/core @diffbot/typescript
```

`@langchain/core` is a **peer dependency** — you install it, and only one copy of it ends up in your tree. That matters: LangChain does `instanceof` checks across package boundaries, and two copies of `@langchain/core` break them in ways that are painful to debug.

`@diffbot/typescript` is a **peer dependency** too, for the same reason. This package never builds a client for you — you construct `DiffbotClient` yourself and hand it in (see below), so the SDK is something you import directly rather than an implementation detail hidden behind us. Making it a peer keeps exactly one copy of the SDK in your tree; as a plain dependency, installing your own alongside ours would resolve two.

Requires **Node.js >= 20**. This package does not run in a browser, edge runtime, or Cloudflare Workers — see [Differences from the Python package](#differences-from-the-python-package).

## Authentication & clients

Get an API token at https://app.diffbot.com/get-started/.

Every component takes a pre-built SDK client — you build a `DiffbotClient` and pass it via `client`. That's the only way to give a component HTTP access, and it keeps configuration in one place: customize the client (token, `timeout`, custom URLs, an injected `fetch`) however the SDK allows, and share one client across many components to reuse a single connection pool. The component uses the client as-is and never closes it — you own its lifecycle.

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";

const client = new DiffbotClient({ token: resolveToken() });
```

`resolveToken()` takes the token from its argument, then `$DIFFBOT_API_TOKEN`, then a `DIFFBOT_API_TOKEN=` line in `~/.diffbot/credentials`. Pass a literal string instead if you resolve secrets yourself.

**One client, not two.** The Python package has both `client` and `async_client`, because Python's HTTP surface is split into a sync and an async transport and every component has to be told which one it is using. `@diffbot/typescript` is uniformly promise-based — there is no sync surface to pick — so there is a single `client` field and every call site is `await`ed. `invoke`, `stream`, `load`, and `lazyLoad` are all async here; there are no `ainvoke` / `astream` / `alazyLoad` twins to reach for.

## Quickstart — Knowledge Graph retriever

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotKnowledgeGraphRetriever } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });
const retriever = new DiffbotKnowledgeGraphRetriever({ client, k: 5 });

const docs = await retriever.invoke(
  'type:Organization industries:"Artificial Intelligence" location.city.name:"Boston"',
);
for (const doc of docs) {
  console.log(doc.metadata.name, "—", doc.pageContent.slice(0, 120));
}
```

The query string is a [DQL (Diffbot Query Language)](https://docs.diffbot.com/reference/dql-quickstart) expression.

## Shaping the output

Diffbot KG entities and web-search results are large — a single entity routinely runs into the thousands of tokens once its supplier lists, tag arrays, and nested composites are included. Dumping ten of them straight into an LLM prompt can blow past a model's per-request input limit, or your per-minute token budget, in one call. That is the failure this section exists to prevent, and it is why agent-style users should always pass `fields`.

Both retrievers expose three shaping knobs:

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { Document } from "@langchain/core/documents";
import { DiffbotKnowledgeGraphRetriever } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });

/*
  1. Project only the top-level fields you care about. Everything else is
     dropped from `metadata`. Recommended for agent / tool-use scenarios.
*/
const projected = new DiffbotKnowledgeGraphRetriever({
  client,
  k: 5,
  fields: ["id", "type", "name", "homepageUri", "nbEmployees"],
});

/* 2. Choose which field becomes `pageContent`. First non-empty value wins. */
const contentFirst = new DiffbotKnowledgeGraphRetriever({
  client,
  contentFields: ["summary", "description", "name"],
});

/*
  3. For total control, pass a `documentMapper` that turns a raw entity object
     into whatever Document shape you want.
*/
const mapped = new DiffbotKnowledgeGraphRetriever({
  client,
  documentMapper: (entity) =>
    new Document({
      pageContent: String(entity.summary ?? ""),
      metadata: { id: entity.id, name: entity.name },
    }),
});

console.log(projected.k, contentFirst.contentFields, typeof mapped.documentMapper);
```

`fields` and `contentFields` are ignored when `documentMapper` is set. The same knobs work on `DiffbotWebSearchRetriever`, with different defaults: the KG retriever picks `pageContent` from `description`, `summary`, `name`; the web-search retriever from `content`, `snippet`.

One detail worth knowing: a KG hit's `score` lives on the outer hit rather than on the entity, and it is copied into `metadata.score` _after_ the `fields` projection — so narrowing `fields` never costs you the relevance score.

## Web search

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotWebSearchRetriever } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });
const web = new DiffbotWebSearchRetriever({
  client,
  k: 5,
  fields: ["title", "pageUrl", "score"],
});

const docs = await web.invoke("diffbot knowledge graph llm grounding");
console.log(docs.map((doc) => doc.metadata.pageUrl));
```

New accounts include 100,000 free web searches per month. Pass `maxTokens` to cap the total content Diffbot returns across all results.

## Extract a URL

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotExtractLoader, DiffbotExtractTool } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });

/* Single URL. */
const tool = new DiffbotExtractTool({ client });
const page = await tool.invoke({ url: "https://www.diffbot.com/products/extract/" });
console.log(page);

/* Batch — one Document per URL, reusing the same client. */
const loader = new DiffbotExtractLoader({
  client,
  urls: ["https://example.com", "https://diffbot.com"],
});
for await (const doc of loader.lazyLoad()) {
  console.log(doc.metadata.title, doc.pageContent.slice(0, 200));
}
```

`DiffbotExtractTool` returns a structured `{ error, errorCode }` object when Diffbot reports an extraction failure (a 200 response carrying an `errorCode`), so an agent can react and try another URL instead of having to catch an exception. Auth and rate-limit failures still throw — those are infrastructure problems, not per-call signals.

`DiffbotExtractLoader` implements `lazyLoad()` as well as `load()`. Prefer `lazyLoad()` for long URL lists: it yields each `Document` as its request finishes, instead of buffering the whole batch.

## Crawl a site

`DiffbotCrawlLoader` drives a Diffbot crawl job and yields one `Document` per crawled URL. The `pageContent` is the URL itself (the crawl API surfaces URLs, not page contents) — chain it with `DiffbotExtractLoader` to fetch the content of each URL.

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotCrawlLoader } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });
const loader = new DiffbotCrawlLoader({ client, site: "https://www.diffbot.com" });

for await (const doc of loader.lazyLoad()) {
  console.log(doc.metadata.url, doc.metadata.status);
}
```

The loader defaults `watch: true` into its `crawlOptions`, because without it the SDK emits a single `job_created` event and nothing else. Pass `crawlOptions: { watch: false, ... }` if you want to fire a job and walk away, and `eventMapper` to keep events the default mapper skips.

## ChatDiffbot

```ts
import process from "node:process";
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { HumanMessage } from "@langchain/core/messages";
import { ChatDiffbot } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken(), timeout: 120_000 });
const llm = new ChatDiffbot({ client });

const stream = await llm.stream([new HumanMessage("What is the Diffbot Knowledge Graph?")]);
for await (const chunk of stream) {
  process.stdout.write(String(chunk.content));
}
```

**Raise the client timeout for the RAG endpoint.** The SDK defaults to 30 seconds, which is generous for Extract or a DQL query but marginal for `ask` — answers routinely take 15–30 seconds and sometimes longer, so on the default the call intermittently aborts mid-answer. Give any client that drives `ChatDiffbot` or `DiffbotAskTool` a `timeout` in the two-minute range. This is the client-only design paying off: one field, set in one place, rather than a per-component knob.

Streaming is native: the SDK's `ask` endpoint returns server-sent events and `ChatDiffbot` implements `_streamResponseChunks` directly, so tokens surface as they arrive. `invoke()` drains that same stream and aggregates it into one message — the streaming path is the only path.

`ChatDiffbot` takes no model parameters. The `ask` endpoint pins its own model and does not expose temperature, max-tokens, or tool-calling knobs, so there is nothing to configure beyond the client. A `stop` sequence passed through call options is accepted and ignored.

To let a tool-calling agent _consult_ Diffbot's LLM (rather than use it as the primary model), hand it `DiffbotAskTool` instead — it answers a natural-language question from the Knowledge Graph plus the live web and returns a synthesized string:

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotAskTool } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken(), timeout: 120_000 });
const ask = new DiffbotAskTool({ client });

console.log(await ask.invoke({ question: "Who founded Diffbot, and when?" }));
```

## Agent tools

Every Diffbot API is also exposed as an agent-callable `StructuredTool` with a zod schema. Hand a tool-calling agent only the tools you want — they all share whatever client you pass. `DiffbotExtractTool` and `DiffbotAskTool` are shown above; the rest:

### DiffbotWebSearchTool

Runs a [Diffbot web search](https://docs.diffbot.com/reference/web-search-get) and returns the result list — each item with `title`, `pageUrl`, `score`, and `content`. (Use `DiffbotWebSearchRetriever` when you want `Document` output instead.)

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotWebSearchTool } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });
const tool = new DiffbotWebSearchTool({ client });

const results = await tool.invoke({ text: "diffbot knowledge graph" });
console.log(results.length);
```

### DiffbotKnowledgeGraphTool

Runs a DQL query against the Knowledge Graph from within an agent and returns the raw response object. (Use `DiffbotKnowledgeGraphRetriever` when you want `Document` output instead.)

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotKnowledgeGraphTool } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });
const tool = new DiffbotKnowledgeGraphTool({ client });

const body = await tool.invoke({ query: 'type:Organization name:"Diffbot"' });
console.log(body.hits);
```

The result offset is spelled `from` here. Python has to call it `from_` because `from` is a reserved keyword there; TypeScript has no such problem, so the SDK's own name survives.

### DiffbotEntitiesTool

Identifies named entities and sentiment in text via Diffbot's NLP API. The returned entity IDs can be looked up in the Knowledge Graph (e.g. `id:or("E1","E2")`), which makes this a cheap first hop from unstructured text into the graph.

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotEntitiesTool } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });
const tool = new DiffbotEntitiesTool({ client });

const result = await tool.invoke({ text: "Diffbot was founded in Menlo Park." });
console.log(result.entities);
```

### Authoring DQL on the fly: DiffbotOntologyTool + DiffbotDQLProbeTool

An agent that writes DQL from memory guesses field names, and a guessed field name returns zero results rather than an error — the worst possible failure mode, because it looks like a valid answer. Two tools exist to close that gap. The intended loop is **introspect (`DiffbotOntologyTool`) → probe (`DiffbotDQLProbeTool`) → run (`DiffbotKnowledgeGraphTool`) → refine**: discover the real type and field names, check that a candidate query matches a sane number of entities, only then pay for the full query, and narrow or widen based on what came back.

`DiffbotOntologyTool` navigates the KG ontology — discover real entity types, field paths, taxonomy values, and enum values before querying. Ops mirror the SDK's ontology helpers: `types`, `composites`, `enums`, `taxonomies` list names; `fields` lists the fields of a type or composite; `taxonomy` and `enum` list a named taxonomy's or enum's values; `search` matches any name anywhere by regex.

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotOntologyTool } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });
const tool = new DiffbotOntologyTool({ client });

const types = await tool.invoke({ op: "types" });
const orgFields = await tool.invoke({ op: "fields", name: "Organization" });
console.log(types, orgFields);
```

The ontology is fetched once over HTTP and cached in memory on the tool instance for the rest of its lifetime. What is cached is the in-flight _promise_, not the resolved document, so concurrent first calls share one request instead of racing; a failed fetch clears the cache so the next call retries. Pass `refresh: true` on any call to discard the cache and re-fetch.

Unknown type names and missing arguments come back as `{ error, hint }` objects rather than thrown exceptions, so an agent can correct itself and retry inside its own loop.

`DiffbotDQLProbeTool` probes query variants at `size: 0` (hit counts only, no entity data), so an agent can check selectivity — not zero, not millions — before committing to a full query. The variants run in parallel and results come back positionally aligned with the input.

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotDQLProbeTool } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });
const tool = new DiffbotDQLProbeTool({ client });

const counts = await tool.invoke({
  queries: ['type:Organization name:"Diffbot"', "type:Person"],
});
console.log(counts);
```

## Using a retriever in a chain

The retrievers are standard `BaseRetriever`s, so they slot into LCEL like any other:

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { ChatAnthropic } from "@langchain/anthropic";
import type { Document } from "@langchain/core/documents";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnablePassthrough, RunnableSequence } from "@langchain/core/runnables";
import { DiffbotKnowledgeGraphRetriever } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });
const retriever = new DiffbotKnowledgeGraphRetriever({
  client,
  k: 5,
  fields: ["id", "name", "homepageUri", "nbEmployees", "industries"],
});

const prompt = ChatPromptTemplate.fromTemplate(
  "Answer using only this Diffbot KG context:\n\n{context}\n\nQuestion: {question}",
);

const format = (docs: Document[]) =>
  docs
    .map((doc) => `${doc.metadata.name} (id=${doc.metadata.id}): ${doc.pageContent}`)
    .join("\n---\n");

const chain = RunnableSequence.from([
  {
    context: RunnableSequence.from([retriever, format]),
    question: new RunnablePassthrough(),
  },
  prompt,
  new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  new StringOutputParser(),
]);

console.log(
  await chain.invoke('type:Organization location.city.name:"Boston" industries:"Biotech"'),
);
```

## Sharing a client across components

Because every component takes a client, you configure the SDK once and hand the same client to as many components as you like — they share its connection pool, and there's no per-call pool churn. Build the tools and retrievers you actually want and add only those to your agent; the client is the shared resource, not a bundle.

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import {
  DiffbotAskTool,
  DiffbotKnowledgeGraphTool,
  DiffbotWebSearchRetriever,
} from "@diffbot/langchain";

/* One client, configured once (timeout, custom URLs, injected fetch, ...). */
const client = new DiffbotClient({ token: resolveToken(), timeout: 60_000 });

const kg = new DiffbotKnowledgeGraphTool({ client });
const ask = new DiffbotAskTool({ client });
const web = new DiffbotWebSearchRetriever({ client, k: 5 });

console.log([kg.name, ask.name, web.k]);

/* Close it when you're done — the components never close it for you. */
await client.close();
```

`DiffbotClient` also implements `Symbol.asyncDispose`, so `await using client = new DiffbotClient({ ... })` closes it at the end of the enclosing scope if your toolchain supports explicit resource management.

Anything the SDK supports is configured on the client you build — there's no second configuration surface to learn. Injecting `fetch` is the general-purpose hook: use it for retries, custom headers, request logging, or a fake transport in tests.

## Differences from the Python package

Four intentional divergences from `langchain-diffbot`. If you are porting Python code, you will hit all four.

### 1. `k` is constructor-only on both retrievers

In Python you can override the result count per call: `retriever.invoke(query, k=3)`. There is no equivalent here. LangChain.js defines the retriever hook as `_getRelevantDocuments(query, runManager)` — a fixed two-argument signature with no kwargs channel — so a per-call `k` has nowhere to travel. Set it at construction, and build a second retriever if you need a second size:

```ts
import { DiffbotClient, resolveToken } from "@diffbot/typescript";
import { DiffbotKnowledgeGraphRetriever } from "@diffbot/langchain";

const client = new DiffbotClient({ token: resolveToken() });
const narrow = new DiffbotKnowledgeGraphRetriever({ client, k: 3 });
const wide = new DiffbotKnowledgeGraphRetriever({ client, k: 25 });

console.log(narrow.k, wide.k);
```

The same applies to `DiffbotWebSearchRetriever`. The agent-facing tools are unaffected: `DiffbotKnowledgeGraphTool` takes `size` in its call schema, and `DiffbotWebSearchTool` takes `numResults`, because a tool's arguments _are_ a per-call channel.

### 2. Node only — no browser, edge, or Workers

This package requires a Node.js runtime, version 20 or newer. The reason is upstream: `@diffbot/typescript` ships a single barrel module that statically imports `node:fs`, `node:os`, and `node:path` (for `resolveToken`'s credentials-file lookup and for the KG export helpers). Because those imports are static and the barrel is the only entry point, merely _importing_ the SDK pulls `node:*` into your bundle — there is no tree-shaking path around it and no browser shim. Bundling this for a browser, an edge runtime, or Cloudflare Workers will fail at build time or blow up at first import.

Python's `diffbot` SDK has no equivalent constraint, so a working Python integration may be running in a context this package cannot.

### 3. Knowledge Graph and ontology URLs are not overridable

`DiffbotClient` accepts `analyzeUrl`, `llmUrl`, `crawlerUrl`, `webSearchUrl`, and `nlpUrl`, and those are honored everywhere. The Knowledge Graph is the exception: the SDK's `dql`, `dqlParallel`, and `dqlFetchOntology` read their endpoints from module constants rather than from the client, so `https://kg.diffbot.com/kg/v3/dql` and `https://kg.diffbot.com/kg/ontology` are fixed.

In practice this only bites when you want to point KG traffic at a proxy or a recorded fixture server. The escape hatch is the injected `fetch`, which sees every request regardless of who chose the URL:

```ts
import { DiffbotClient } from "@diffbot/typescript";
import { DiffbotKnowledgeGraphTool } from "@diffbot/langchain";

const client = new DiffbotClient({
  token: "token",
  fetch: (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.hostname === "kg.diffbot.com") {
      url.hostname = "kg.internal.example";
    }
    return fetch(url, init);
  },
});

console.log(new DiffbotKnowledgeGraphTool({ client }).name);
```

### 4. `DiffbotOntologyTool` supports `refresh: true`

The Python tool's docstring promises a way to bust its in-memory ontology cache, but no such argument was ever implemented — the cache lives for the life of the tool instance, full stop. Here `refresh` is a real field on the call schema: pass `refresh: true` and the tool discards the cached ontology and re-fetches before running the op.

The ontology changes rarely, so leave it unset in normal use; it exists for long-lived processes whose cached answers have gone stale.

### Naming

Beyond those four, names track the SDK rather than the Python package where the two disagree: `from` instead of `from_`, `numResults` and `maxTokens` instead of `num_results` and `max_tokens`, `contentFields` and `documentMapper` instead of `content_fields` and `document_mapper`. The one LangChain-convention rename is preserved: the retrievers call the result count `k`, mapping to the SDK's `size` (KG) and `numResults` (web search).

## Components reference

| Class                            | Abstraction     | Import path                                                           |
| -------------------------------- | --------------- | --------------------------------------------------------------------- |
| `ChatDiffbot`                    | Chat model      | `import { ChatDiffbot } from "@diffbot/langchain"`                    |
| `DiffbotKnowledgeGraphRetriever` | Retriever       | `import { DiffbotKnowledgeGraphRetriever } from "@diffbot/langchain"` |
| `DiffbotWebSearchRetriever`      | Retriever       | `import { DiffbotWebSearchRetriever } from "@diffbot/langchain"`      |
| `DiffbotExtractLoader`           | Document loader | `import { DiffbotExtractLoader } from "@diffbot/langchain"`           |
| `DiffbotCrawlLoader`             | Document loader | `import { DiffbotCrawlLoader } from "@diffbot/langchain"`             |
| `DiffbotExtractTool`             | Tool            | `import { DiffbotExtractTool } from "@diffbot/langchain"`             |
| `DiffbotWebSearchTool`           | Tool            | `import { DiffbotWebSearchTool } from "@diffbot/langchain"`           |
| `DiffbotKnowledgeGraphTool`      | Tool            | `import { DiffbotKnowledgeGraphTool } from "@diffbot/langchain"`      |
| `DiffbotEntitiesTool`            | Tool            | `import { DiffbotEntitiesTool } from "@diffbot/langchain"`            |
| `DiffbotAskTool`                 | Tool            | `import { DiffbotAskTool } from "@diffbot/langchain"`                 |
| `DiffbotOntologyTool`            | Tool            | `import { DiffbotOntologyTool } from "@diffbot/langchain"`            |
| `DiffbotDQLProbeTool`            | Tool            | `import { DiffbotDQLProbeTool } from "@diffbot/langchain"`            |

The barrel also exports the shared helpers the components are built from — `assertClient`, `dictToDocument`, `resolveK`, `shapeExtractResponse`, `defaultCrawlMapper`, and the `DEFAULT_KG_CONTENT_FIELDS` / `DEFAULT_WEB_CONTENT_FIELDS` constants — plus a `*Fields` type for every class, so you can type a factory function without re-deriving its options.

Admin and utility SDK calls (`crawlListJobs`, `crawlGetJob`, `crawlDeleteJob`, `dqlRefreshOntology`) are deliberately not wrapped — they aren't retrievers, loaders, tools, or chat models, and forcing them into one of those shapes would be worse than not having them. Every component exposes its `.client`, so call them directly:

```ts
import { DiffbotClient, crawlListJobs, resolveToken } from "@diffbot/typescript";
import { DiffbotCrawlLoader } from "@diffbot/langchain";

const loader = new DiffbotCrawlLoader({
  client: new DiffbotClient({ token: resolveToken() }),
  site: "https://www.diffbot.com",
});

console.log(await crawlListJobs(loader.client));
```

## Examples

The [`examples/`](./examples) folder has runnable demos, each a standalone package with its own README:

- [`examples/dql-explorer/`](./examples/dql-explorer) — a browser app over the Knowledge Graph with three tabs: a **DQL Builder** where an agent inspects the ontology and probes variants before committing to a query (the agent only _authors_ it; the server runs it, so the rows are always real KG data), an **M&A / IPO dashboard** rolled up deterministically from two fixed DQL templates, and an **Ask** tab streaming from `ChatDiffbot`. Hono backend, React + TypeScript frontend, one port.
- [`examples/company-research/`](./examples/company-research) — a one-shot CLI agent that answers a plain-English company question by combining KG search, web search, and URL extract, then cites the entity IDs and URLs it used.

Examples need `langchain` and `@langchain/anthropic` on top of the base package, and they resolve `@diffbot/langchain` through `dist/` — run `pnpm build` at the repo root first. Copy `examples/.env.example` to `examples/.env` and fill in `DIFFBOT_API_TOKEN` and `ANTHROPIC_API_KEY`.

## Development

```bash
pnpm install
pnpm test        # unit tests (vitest, no network)
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint src/ tests/
pnpm format      # prettier --write src tests
pnpm build       # tsup — builds dist/
```

Live tests hit the real Diffbot APIs and require a token:

```bash
DIFFBOT_API_TOKEN=your-token pnpm test:live
```

Two suites keep this README honest, so an example that drifts fails CI rather than a user's copy-paste: `tests/readme_parity.test.ts` checks the components table against the package's public surface and asserts every example builds a client, and `tests/readme_examples.test.ts` executes every TypeScript block against a mocked `fetch`.

## Releasing

Publishing happens only through the tagged release workflow — there is no local publish path. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full procedure and for the repo's layout conventions.

## License

MIT
