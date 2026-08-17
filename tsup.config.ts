import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  /*
    Neutral, not node: this package has no node builtins of its own, and
    everything that touches the filesystem lives in @diffbot/typescript's
    separate /node entry, which we never import. Keeping this build target
    platform-neutral means an accidental node builtin import here fails the
    build instead of silently reintroducing a Workers incompatibility.
  */
  platform: "neutral",
  /*
    @langchain/core is a peer dependency and must never be bundled — a second
    copy in the output would break `instanceof` checks against the consumer's
    own core instance (Document, BaseMessage, …).
  */
  external: ["@langchain/core", "@diffbot/typescript", "zod"],
});
