# Contributing

## Prerequisites

- Node.js >= 20 (see `engines.node` in `package.json`)
- [pnpm](https://pnpm.io/)

Node.js is required to build and install this package. At runtime it isn't
Node-only: `@diffbot/typescript`'s main entry imports no node builtins, so
this package runs in a Cloudflare Worker with no compatibility flags — see
`fixtures/worker/` and the "Cloudflare Workers" section of `CLAUDE.md`.

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
and `pnpm typecheck` once (Node 22), `pnpm test` and `pnpm build` across the
Node 20 / 22 / 24 matrix, and a `workers` job that builds `fixtures/worker/`
with `wrangler deploy --dry-run` to prove the package needs no Cloudflare
compatibility flags.

## Cloudflare Worker fixture

```
pnpm build                        # fixture resolves the package through dist/
cd fixtures/worker
pnpm install
pnpm exec wrangler deploy --dry-run   # the CI check — no Cloudflare credentials needed
pnpm exec vitest run                  # runs in workerd; see vitest.config.ts for a known, unrelated blocker
```

## Live/integration tests

```
DIFFBOT_API_TOKEN=your-token pnpm test:live
```

`test:live` hits the real Diffbot APIs and consumes real quota. In CI
(`.github/workflows/integration.yml`) it runs on push to `main`, on a
twice-monthly drift schedule (1st and 15th), and via manual
`workflow_dispatch` — never on `pull_request`. Fork PRs cannot push to
`main` or dispatch this workflow, so the repo-level `DIFFBOT_API_TOKEN`
secret is never exposed to untrusted code.

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
publish path. Publishing only happens through the tagged release workflow
(`.github/workflows/release.yml`), which follows the shared npm release
workflow standard for the Diffbot TypeScript packages
(`docs/conventions/npm-release-workflow.md` in diffbot-dev-docs).

To cut a final release:

1. Bump `version` in `package.json` to `X.Y.Z`.
2. Add a `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`. It becomes the
   GitHub Release notes.
3. Commit, merge to `main`, then tag the merge commit `vX.Y.Z` (matching
   `package.json` exactly) and push the tag:
   ```
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

To cut a release candidate, use a version such as `X.Y.Z-rc.0` and tag
`vX.Y.Z-rc.0`. Its CHANGELOG section may be the base `## [X.Y.Z]` one. Any
version containing `-` is published under the npm `next` dist-tag (`latest`
is untouched), and its GitHub Release is marked as a prerelease. A final
version is published as `latest` and then also moves `next`.

On a tag push the workflow:

1. `verify`: checks the tag matches `package.json` and that `CHANGELOG.md` has
   a section for the version.
2. `gates`: runs `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`
   on Node 22 and uploads the built package as an artifact. A sibling
   `workers` job runs the Cloudflare worker fixture's `wrangler deploy
   --dry-run`, as `ci.yml` does (its vitest suite is still skipped; see
   `fixtures/worker/vitest.config.ts`).
3. `publish`: publishes that artifact to npm with provenance via trusted
   publishing (no token). It skips the publish if the version is already on
   npm, so a failed run can be re-run.
4. `github-release`: creates the GitHub Release with the CHANGELOG notes and
   attaches `dist/*`.

There is no manual `npm publish` / `pnpm publish` step. If the tag and
`package.json` version disagree, or the CHANGELOG section is missing, the
workflow fails before anything is published. A manual `workflow_dispatch`
(action `dry-run`) runs the same gates and a publish rehearsal (`npm publish --dry-run`, or `npm pack` if the version is already on npm) and
publishes nothing; action `move-next` only re-points `next` at an
already-published version.
