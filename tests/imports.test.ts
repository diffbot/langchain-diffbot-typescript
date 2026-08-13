import { describe, expect, it } from "vitest";
import * as mod from "../src/index.js";
import { componentClassNames } from "./readme.js";

/*
  The package's public component surface. Adding a class means adding it here
  and to the README's `## Components reference` table — tests/readme_parity.test.ts
  enforces the second half of that.
*/
const EXPECTED = [
  "ChatDiffbot",
  "DiffbotAskTool",
  "DiffbotCrawlLoader",
  "DiffbotDQLProbeTool",
  "DiffbotEntitiesTool",
  "DiffbotExtractLoader",
  "DiffbotExtractTool",
  "DiffbotKnowledgeGraphRetriever",
  "DiffbotKnowledgeGraphTool",
  "DiffbotOntologyTool",
  "DiffbotWebSearchRetriever",
  "DiffbotWebSearchTool",
];

describe("public surface", () => {
  it("exports exactly the expected component classes", () => {
    expect(componentClassNames(mod as Record<string, unknown>)).toEqual(EXPECTED);
  });

  it("exports the shared base helpers", () => {
    expect(typeof mod.assertClient).toBe("function");
    expect(typeof mod.dictToDocument).toBe("function");
    expect(typeof mod.resolveK).toBe("function");
    expect(typeof mod.shapeExtractResponse).toBe("function");
    expect(mod.DEFAULT_KG_CONTENT_FIELDS).toEqual(["description", "summary", "name"]);
    expect(mod.DEFAULT_WEB_CONTENT_FIELDS).toEqual(["content", "snippet"]);
  });

  it("gives every component a distinct lc_name matching its export name", () => {
    for (const name of EXPECTED) {
      const cls = (mod as Record<string, unknown>)[name] as { lc_name(): string };
      expect(cls.lc_name()).toBe(name);
    }
  });
});
