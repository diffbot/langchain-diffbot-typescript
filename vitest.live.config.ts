import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.live.test.ts"],
    // Live calls hit the real Diffbot APIs; LLM streaming in particular can run
    // well past vitest's 5s default.
    testTimeout: 150_000, // above the 120s client timeout used for the slow RAG LLM endpoint
  },
});
