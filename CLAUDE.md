# @diffbot/langchain

LangChain.js integration package for the Diffbot APIs (Knowledge Graph, Extract, Web Search, NLP entities, Crawl, and the Diffbot LLM RAG endpoint). TypeScript sibling of the Python package `langchain-diffbot` (expected at `../langchain-diffbot`).

## Stack

- **Package manager**: `pnpm`. Never npm or yarn.
- **Build**: `tsup` (`tsup.config.ts`) — dual ESM/CJS output plus declarations into `dist/`. `package.json` `exports` maps `import`/`require` to the matching build and types.
- **Tests**: `vitest`. `vitest.config.ts` runs `tests/**/*.test.ts` and excludes `tests/**/*.live.test.ts`; `vitest.live.config.ts` runs only the live suite. Network is stubbed by injecting a fake `fetch` into `DiffbotClient` (`tests/helpers/mock-fetch.ts`) — the analog of the Python package's `respx`.
- **Tool schemas**: `zod`, imported as `zod/v3` so the schemas keep working under both the zod 3 and zod 4 ranges the package allows.
- **`@langchain/core` is a peer dependency**, not a dependency. LangChain does `instanceof` checks across package boundaries, and a second copy of `@langchain/core` in the tree silently breaks them. It stays a devDependency here so the repo can build and test.
- **`@diffbot/typescript` is a direct dependency** — this package is a layer over it, not a re-implementation.
- **Node >= 20**, ESM-first (`"type": "module"`, `moduleResolution: "bundler"`, `.js` extensions on relative imports).

## Architectural decisions

### Thin layer over @diffbot/typescript

Every public class calls a `@diffbot/typescript` function directly. There is no wrapper mirroring the SDK, no transport of our own, no retry or caching layer of this package's own — the one exception, ontology caching, lives in the SDK's `OntologyStore` (see below), not here. Adding a LangChain surface for a new SDK function should be a single new file plus one line in the barrel — no plumbing edits.

Each class accepts the SDK's option names as-is (`from`, `filter`, `format`, `exportspec`, `extra`, `maxTokens`, `api`, `fmt`, `lang`). The only renames are LangChain-convention: `size` → `k` on the KG retriever, `numResults` → `k` on the web-search retriever.

### The SDK is a set of free functions, not methods

`@diffbot/typescript` exposes `dql(client, query, options)`, not `client.dql(...)`. The client is a configuration object plus an `HttpClient`; the API surface is standalone functions that take it as their first argument, so bundlers can tree-shake the ones you don't import. Component code therefore reads `await dql(this.client, query, {...})`, `await webSearch(this.client, ...)`, `await extract(this.client, ...)`, `for await (... of ask(this.client, ...))`.

Do not add methods to `DiffbotClient` or reach for a method-style call — it does not exist.

### Client-only: the SDK client is the single configuration surface

`src/base.ts` defines `DiffbotComponentFields`, which contributes exactly one field: `client: DiffbotClient`. The caller builds the client and passes it in; components borrow it per call and **never close it** (the caller owns the lifecycle). There is no `token` or `timeout` on components and no per-call client construction.

This is deliberate: one way to give a component HTTP access (hand it a client), one place to configure the SDK (the client you build). Everything the SDK supports — token, `timeout`, custom URLs (`analyzeUrl`, `llmUrl`, `crawlerUrl`, `webSearchUrl`, `nlpUrl`), and an injected `fetch` for retries/logging/headers/mocking — is set on that client, not mirrored as component fields. Share one client across many components to reuse a single connection pool.

TypeScript enforces `client` at compile time, so `assertClient()` exists for JavaScript callers and anyone casting through `any`.

The Python package expresses this as a pydantic mixin (`_BaseDiffbotComponent`) that every class inherits alongside its LangChain base. TypeScript has no multiple inheritance, so the shared surface is a fields interface plus free helpers in `src/base.ts`, and each class stores `client` itself.

### One client, not two

The Python package carries both `client` and `async_client` because its HTTP layer is split into sync and async transports and every component has to be told which one it is using. `@diffbot/typescript` is uniformly promise-based, so there is a single `client` and every call site is awaited. There is no `ainvoke` / `astream` / `alazyLoad` twin to write, and no thread-pool fallback question to answer — the async path is the only path.

### One class per file, barrel in src/index.ts

```
src/
├── index.ts               # public barrel — every user-facing class is re-exported here
├── base.ts                # DiffbotComponentFields, assertClient, dictToDocument, resolveK, shapeExtractResponse
├── chat_models.ts         # ChatDiffbot (wraps `ask`)
├── loaders/
│   ├── extract.ts         # DiffbotExtractLoader
│   └── crawl.ts           # DiffbotCrawlLoader, defaultCrawlMapper
├── retrievers/
│   ├── knowledge-graph.ts # DiffbotKnowledgeGraphRetriever
│   └── web-search.ts      # DiffbotWebSearchRetriever
└── tools/
    ├── ask.ts             # DiffbotAskTool
    ├── dql-probe.ts       # DiffbotDQLProbeTool
    ├── entities.ts        # DiffbotEntitiesTool
    ├── extract.ts         # DiffbotExtractTool
    ├── knowledge-graph.ts # DiffbotKnowledgeGraphTool
    ├── ontology.ts        # DiffbotOntologyTool
    └── web-search.ts      # DiffbotWebSearchTool
```

A new public class goes in its own file under the matching directory and gets exported from `src/index.ts`. Each class also exports its `*Fields` constructor-options interface, so callers can type a factory without re-deriving the options.

`tests/imports.test.ts` asserts the exact list of exported component classes and that each one's `lc_name()` matches its export name. `tests/readme_parity.test.ts` asserts the README's components table matches the same list. Both find the component classes by looking for exports that are functions carrying `lc_name` — that is what distinguishes a component from the helpers, constants, and types in the barrel.

### Output shaping on the retrievers

Both retrievers accept `fields` (metadata allowlist), `contentFields` (priority list for `pageContent`), and `documentMapper` (full override). Diffbot KG entities and web-search results can run thousands of tokens each — unshaped, a single retrieval can blow past an LLM's input limit when fed into a tool call. Defaults preserve everything; agent-style users are expected to pass `fields`.

`dictToDocument` in `base.ts` implements the shaping and mirrors Python's truthiness rules for "non-empty", so the two packages pick the same content field for the same entity. The KG retriever copies the outer hit's `score` into `metadata` _after_ the `fields` projection, so narrowing `fields` never drops the relevance score.

### DQL authoring tools: ontology + probe

An agent that writes DQL from memory guesses field names, and a guessed field name returns zero results rather than an error — a silent failure that looks like an answer. Two tools close that gap:

- `DiffbotOntologyTool` — navigates the KG ontology via an SDK `OntologyStore` (`ontologyStore.load({ refresh })` → `Ontology`). Defaults to `new OntologyStore(client)`, an in-memory cache for the tool instance's lifetime — the promise-caching and rejection-clears-the-cache behavior this used to implement itself now lives in that class. Pass `ontologyStore: new KVOntologyStore(client, kv)` for a durable cache across instances (a Cloudflare Worker's recycled isolates, for example). Recoverable failures (unknown type, missing argument) are returned as `{ error, hint }` instead of thrown, so an agent can correct itself.
- `DiffbotDQLProbeTool` — wraps `dqlParallel()` to probe query variants at `size: 0` (hit counts only), so an agent can check selectivity before committing.

The intended agent loop is **introspect (ontology) → probe → run (`DiffbotKnowledgeGraphTool`) → refine**.

### Admin / utility SDK functions are not wrapped

`crawlListJobs`, `crawlGetJob`, and `crawlDeleteJob` don't fit as LangChain primitives — they are not retrievers, loaders, tools, or chat models, and forcing them into one of those shapes would be worse than leaving them out. They stay unwrapped, but every component exposes its `.client`, so users can call them directly: `await crawlListJobs(loader.client)`.

### Cloudflare Workers

This package runs in a Worker with **no compatibility flags required** — verified in CI by `fixtures/worker/` (`wrangler deploy --dry-run` against an empty `compatibility_flags` array). That property comes entirely from `@diffbot/typescript`: its main entry imports no node builtins and has no import-time side effects (enforced there via `platform: "neutral"` in its build and a post-build grep). This package's own `src/` has never had a node builtin dependency; the only historical blocker was transitive.

Two things change in a Worker, both because there's no filesystem: token resolution uses `resolveTokenFromEnv(undefined, env)` instead of `resolveToken` (the credentials-file version lives behind `@diffbot/typescript/node`, which this package never imports), and `DiffbotOntologyTool`'s cache should be backed by `KVOntologyStore` rather than the in-memory default, since Worker isolates recycle between requests.

`fixtures/worker/vitest.config.ts` documents a known, upstream, unrelated limitation: `@cloudflare/vitest-pool-workers` can't run this fixture's full test suite yet because of a Vite bug in resolving `langsmith`'s legacy `browser` field (vitejs/vite#18340). The `wrangler deploy --dry-run` check is unaffected and is what CI relies on.

## Differences from the Python package

Three intentional divergences. All three are documented in `README.md` under `## Differences from the Python package`; keep the two in sync.

1. **`k` is constructor-only on both retrievers.** Python allows `retriever.invoke(query, k=3)`. LangChain.js defines the hook as `_getRelevantDocuments(query, runManager)` — a fixed signature with no kwargs channel — so a per-call `k` has nowhere to travel. `resolveK()` therefore validates once at construction rather than per call. The tools are unaffected: `size` / `numResults` live in their zod call schemas, which _are_ a per-call channel.
2. **KG and ontology URLs are not overridable.** `DiffbotClient` honors `analyzeUrl`, `llmUrl`, `crawlerUrl`, `webSearchUrl`, and `nlpUrl`, but the SDK's `dql`, `dqlParallel`, and `dqlFetchOntology` read `KG_DQL_ENDPOINT` / `KG_ONTOLOGY_ENDPOINT` from module constants rather than from the client. Only an injected `fetch` can redirect that traffic. This is why the README's KG examples and the test suites mock at the `fetch` layer rather than pointing the client at a local server.
3. **`DiffbotOntologyTool` supports `refresh: true`.** The Python tool's docstring promises a cache-busting argument that was never implemented. Here `refresh` is a real field on the call schema: it passes `{ refresh: true }` through to `ontologyStore.load()`, which discards the cache and re-fetches before the op runs.

Beyond those four, names track the SDK where it and the Python package disagree: `from` (not `from_` — TypeScript has no keyword conflict), `numResults`, `maxTokens`, `contentFields`, `documentMapper`.

## Documentation

`README.md` is this package's complete reference — install, auth, every class, and a worked example each. Two suites keep it honest:

- `tests/readme_parity.test.ts` — the `## Components reference` table matches the barrel's component classes, every class appears in some code block, and every block that constructs a component also constructs a client (the package is client-only, so an example missing `client` would throw at call time).
- `tests/readme_examples.test.ts` — every ` ```ts ` block is extracted, its `@diffbot/langchain` import is rewritten to `src/index.ts`, and the block is executed against a stubbed global `fetch`. Blocks that construct `DiffbotCrawlLoader` are documented but not executed (`isExecutable` in `tests/readme.ts`), and blocks importing anything outside `DIFFBOT_ONLY_IMPORTS` — the LCEL example pulls in `@langchain/anthropic` — are skipped so CI never spends third-party quota.

`tests/readme.ts` holds the shared extraction helpers. Changing the fence style, the table shape, or the components list in `README.md` will fail one of these suites — that is the point.

When the README and the Python package's `README.md` describe the same behavior, keep the prose aligned; when they describe different behavior, say so explicitly rather than quietly diverging.

## Commands

```
pnpm test        # unit tests (vitest, no network)
pnpm test:live   # live tests — needs DIFFBOT_API_TOKEN, consumes real quota
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint src/ tests/
pnpm format      # prettier --write src tests
pnpm build       # tsup
```

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm exec prettier --check src tests` before opening a PR.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and PR: `pnpm lint` + `pnpm typecheck` once, then `pnpm test` and `pnpm build` across the Node 20 / 22 / 24 matrix. `.github/workflows/integration.yml` runs the live suite nightly and on `workflow_dispatch` only — neither trigger can be fired by a fork PR, so the repo-level `DIFFBOT_API_TOKEN` secret is never exposed to untrusted code.

## Releasing

There is no local publish path. Bump `version` in `package.json`, commit, tag `vX.Y.Z` matching it exactly, and push the tag; `.github/workflows/release.yml` builds, verifies the tag against `package.json`, publishes to npm with provenance, and creates the GitHub release. A mismatched tag fails the workflow before anything is published. See `CONTRIBUTING.md`.

## Style

- Block comments use `/*` on its own line, content indented one level, no leading `*` per line, `*/` on its own line. Reserve the `*`-per-line style for JSDoc.
- Explain _why_, not _what_. A comment that restates the code is noise; a comment that records the constraint behind an odd-looking line is what keeps the next change from undoing it.
- Prettier owns formatting (`.prettierrc`: 100 columns, double quotes, trailing commas, semicolons). Don't hand-format around it.
