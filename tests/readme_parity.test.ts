/*
  Keep README.md in lockstep with the package surface.

  README.md is this package's complete reference, so a class that is added,
  renamed, or removed must not silently miss it. These tests fail on drift
  between the barrel (`src/index.ts`) and the README's components table,
  examples, and client-only contract.

  Ported from ../langchain-diffbot/tests/unit_tests/test_readme_parity.py.
*/

import { describe, expect, it } from "vitest";
import * as mod from "../src/index.js";
import { componentClassNames, componentsTableClasses, extractBlocks } from "./readme.js";

const COMPONENTS = componentClassNames(mod as Record<string, unknown>);
const BLOCKS = extractBlocks();

describe("README parity", () => {
  it("lists exactly the exported component classes in the components table", () => {
    expect([...componentsTableClasses()].sort()).toEqual([...COMPONENTS].sort());
  });

  it("uses every exported component class in at least one example", () => {
    const text = BLOCKS.map((block) => block.source).join("\n");
    for (const name of COMPONENTS) {
      expect(
        new RegExp(`\\b${name}\\b`).test(text),
        `${name} is not used in any README example`,
      ).toBe(true);
    }
  });

  /*
    The most damaging regression this can catch: an example that constructs a
    component without a client. The package is client-only, so such a snippet
    throws the moment a reader runs it.
  */
  it("builds a client in every example that constructs a component", () => {
    for (const { id, source } of BLOCKS) {
      const constructsComponent = COMPONENTS.some((name) =>
        new RegExp(`\\b${name}\\s*\\(`).test(source),
      );
      if (!constructsComponent) continue;

      expect(
        source.includes("new DiffbotClient("),
        `example ${id} constructs a component without a client`,
      ).toBe(true);
    }
  });
});
