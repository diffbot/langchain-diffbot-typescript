import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/*
  KNOWN LIMITATION, not a defect in this package: langsmith (a transitive
  dependency via @langchain/core) remaps a Node-only file to a browser-safe
  one via package.json's legacy `browser` field using the object-map form.
  Vite's SSR resolver only supports the string form of `browser` and doesn't
  apply it here, so vitest-pool-workers loads langsmith's Node file, which
  statically imports `node:worker_threads` — unresolvable even under
  nodejs_compat. `resolve.alias` and `deps.optimizer.ssr.include` do not
  intercept it either; the failing file is loaded via workerd's own module
  fallback service, bypassing Vite's resolver entirely.

  This is upstream and already filed: vitejs/vite#18340,
  cloudflare/workers-sdk#6581 (same root cause, different package).

  It does NOT affect the actual "does this need nodejs_compat" claim: `pnpm
  check` in this fixture runs the real bundler (wrangler deploy --dry-run)
  against the exact same source and succeeds with an empty
  compatibility_flags array — that is wrangler's production code path, not
  Vite's, and it isn't subject to this bug. The SDK's own fixture
  (../../../diffbot-typescript/fixtures/worker) has no @langchain/core in its
  graph and runs green under this same tool, so KVOntologyStore, dql, ask,
  and token resolution are all verified against real workerd already.

  Re-enable `pnpm test` in CI once the upstream Vite issue lands a fix.
*/
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.jsonc" },
      },
    },
  },
});
