# Contributing

## Prerequisites

- Node.js >= 20 (see `engines.node` in `package.json`)
- [pnpm](https://pnpm.io/)

This package requires a Node.js runtime — it is not meant to run in a browser
or edge runtime. The underlying `@diffbot/typescript` SDK statically imports
`node:fs`, `node:os`, and `node:path`.

## Getting started

```
pnpm install
```

## Local development loop

```
pnpm test         # unit tests (vitest, no network)
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint src/ tests/
pnpm format        # prettier --write src tests
pnpm build         # tsup — builds dist/
```

Run these before opening a PR. CI (`.github/workflows/ci.yml`) runs `pnpm lint`
and `pnpm typecheck` once (Node 22), then `pnpm test` and `pnpm build` across
the Node 20 / 22 / 24 matrix.

## Live/integration tests

```
DIFFBOT_API_TOKEN=your-token pnpm test:live
```

`test:live` hits the real Diffbot APIs and consumes real quota. In CI
(`.github/workflows/integration.yml`) it only runs on a nightly schedule and
via manual `workflow_dispatch` — never on `push` or `pull_request`. Neither of
those two triggers can be invoked by a fork PR, so the repo-level
`DIFFBOT_API_TOKEN` secret is never exposed to untrusted code.

## Layout convention

One public class lives in one file, and every public class is re-exported
from `src/index.ts`. For example:

```
src/
├── base.ts               # shared helpers/types, not user-facing classes
├── retrievers/
│   ├── knowledge-graph.ts   # DiffbotKnowledgeGraphRetriever
│   └── web-search.ts        # DiffbotWebSearchRetriever
├── tools/
│   ├── entities.ts           # DiffbotEntitiesTool
│   ├── extract.ts            # DiffbotExtractTool
│   ├── knowledge-graph.ts    # DiffbotKnowledgeGraphTool
│   └── web-search.ts         # DiffbotWebSearchTool
└── loaders/                  # document loaders, one class per file
```

When you add a new public class, put it in its own file under the matching
directory and add its export to `src/index.ts`.

## Releasing

Unlike the Python sibling package (`langchain-diffbot`), there is no local
publish path — publishing only happens through the tagged release workflow
(`.github/workflows/release.yml`). To cut a release:

1. Bump `version` in `package.json`.
2. Commit the bump.
3. Tag the commit `vX.Y.Z` (matching the new `package.json` version exactly)
   and push the tag:
   ```
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
4. The release workflow builds the package, verifies the tag matches
   `package.json`, publishes to npm with provenance, and creates the
   corresponding GitHub release.

There is no manual `npm publish` / `pnpm publish` step — if the tag and
`package.json` version disagree, the workflow fails before anything is
published.
