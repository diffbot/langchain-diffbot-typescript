# Changelog

## [0.2.0] - 2026-11-17

Ship the unpublished 0.2.0 line against `@diffbot/typescript` ^0.6.0.

Peer, devDependency, `examples/company-research`, `examples/dql-explorer`, and `fixtures/worker` move off ^0.5.0 and ^0.2.0. DQL tests already assert POST with a JSON body; the token stays on the query string.

The dev-only `.pnpmfile.cjs` sibling link is removed. Refresh the root lock and the example/fixture locks after 0.6.0 is on npm (`pnpm install` / `pnpm update @diffbot/typescript`). Example `link:../..` entries for `@diffbot/langchain` itself stay local dev links.

Publishing is npm trusted publishing from `.github/workflows/release.yml` (no token, no GitHub environment). Tag `v0.2.0`.
