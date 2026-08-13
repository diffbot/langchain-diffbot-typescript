import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  /*
    @langchain/core is a peer dependency and must never be bundled — a second
    copy in the output would break `instanceof` checks against the consumer's
    own core instance (Document, BaseMessage, …).
  */
  external: ["@langchain/core", "@diffbot/typescript", "zod"],
});
