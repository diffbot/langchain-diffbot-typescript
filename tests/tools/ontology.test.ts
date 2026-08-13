import { describe, expect, it } from "vitest";
import { DiffbotClient } from "@diffbot/typescript";
import { DiffbotOntologyTool } from "../../src/tools/ontology.js";
import { createMockFetch, jsonResponse } from "../helpers/mock-fetch.js";

const ONTOLOGY_URL = "https://kg.diffbot.com/kg/ontology";

/*
  Mirrors the Python suite's _FIXTURE_ONTOLOGY: two types, one composite, one
  enum, one nested taxonomy — the minimum that exercises every op.
*/
const FIXTURE_ONTOLOGY = {
  types: {
    Organization: {
      fields: {
        name: { type: "String" },
        location: { type: "Location", isComposite: true },
      },
    },
    Person: { fields: { name: { type: "String" } } },
  },
  composites: {
    Location: { fields: { city: { type: "City", isComposite: true } } },
  },
  enums: { Language: { values: ["EN", "FR"] } },
  taxonomies: {
    OrganizationCategory: {
      categories: [
        {
          name: "Technology",
          children: [{ name: "Semiconductor Companies" }],
        },
      ],
    },
  },
};

/* Returns the tool plus a live view of how many times the ontology was fetched. */
function makeTool(): { tool: DiffbotOntologyTool; calls: () => number } {
  let count = 0;
  const client = new DiffbotClient({
    token: "test-token",
    fetch: createMockFetch((req) => {
      expect(req.url).toBe(ONTOLOGY_URL);
      expect(req.method).toBe("GET");
      count += 1;
      return jsonResponse(FIXTURE_ONTOLOGY);
    }),
  });
  return { tool: new DiffbotOntologyTool({ client }), calls: () => count };
}

describe("DiffbotOntologyTool identity", () => {
  it("exposes the LangChain tool surface", () => {
    const { tool } = makeTool();
    expect(DiffbotOntologyTool.lc_name()).toBe("DiffbotOntologyTool");
    expect(tool.name).toBe("diffbot_ontology");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.lc_namespace).toEqual(["langchain", "tools", "diffbot"]);
  });
});

describe("DiffbotOntologyTool caching", () => {
  it("fetches the ontology once across two different ops", async () => {
    const { tool, calls } = makeTool();

    expect(await tool.invoke({ op: "types" })).toEqual(["Organization", "Person"]);
    /* Second call is served from the in-memory cache — no second HTTP fetch. */
    expect(await tool.invoke({ op: "enums" })).toEqual(["Language"]);

    expect(calls()).toBe(1);
  });

  it("re-fetches when refresh is true", async () => {
    const { tool, calls } = makeTool();

    await tool.invoke({ op: "types" });
    expect(calls()).toBe(1);

    expect(await tool.invoke({ op: "types", refresh: true })).toEqual(["Organization", "Person"]);
    expect(calls()).toBe(2);

    /* The refreshed ontology is cached again. */
    await tool.invoke({ op: "types" });
    expect(calls()).toBe(2);
  });
});

describe("DiffbotOntologyTool list ops", () => {
  it("lists types, composites, enums, and taxonomies sorted by name", async () => {
    const { tool } = makeTool();
    expect(await tool.invoke({ op: "types" })).toEqual(["Organization", "Person"]);
    expect(await tool.invoke({ op: "composites" })).toEqual(["Location"]);
    expect(await tool.invoke({ op: "enums" })).toEqual(["Language"]);
    expect(await tool.invoke({ op: "taxonomies" })).toEqual(["OrganizationCategory"]);
  });
});

describe("DiffbotOntologyTool drill-down ops", () => {
  it("formats fields of a type", async () => {
    const { tool } = makeTool();
    const fields = await tool.invoke({ op: "fields", name: "Organization" });
    expect(fields).toEqual(["name: [String]", "location: [Location] [isComposite]"]);
  });

  it("formats fields of a composite and filters them by regex", async () => {
    const { tool } = makeTool();
    expect(await tool.invoke({ op: "fields", name: "Location" })).toEqual([
      "city: [City] [isComposite]",
    ]);
    expect(await tool.invoke({ op: "fields", name: "Organization", search: "^loc" })).toEqual([
      "location: [Location] [isComposite]",
    ]);
  });

  it("walks nested taxonomy children and filters case-insensitively", async () => {
    const { tool } = makeTool();
    expect(await tool.invoke({ op: "taxonomy", name: "OrganizationCategory" })).toEqual([
      "Technology",
      "Semiconductor Companies",
    ]);
    expect(
      await tool.invoke({
        op: "taxonomy",
        name: "OrganizationCategory",
        search: "semi",
      }),
    ).toEqual(["Semiconductor Companies"]);
  });

  it("lists enum values", async () => {
    const { tool } = makeTool();
    expect(await tool.invoke({ op: "enum", name: "Language" })).toEqual(["EN", "FR"]);
  });

  it("matches names anywhere in the ontology by regex", async () => {
    const { tool } = makeTool();
    /* `name` is the pattern for `search`, matched case-insensitively. */
    expect(await tool.invoke({ op: "search", name: "^tech" })).toEqual(["Technology"]);
    expect(await tool.invoke({ op: "search", name: "compan" })).toEqual([
      "Semiconductor Companies",
    ]);
    expect(await tool.invoke({ op: "search", name: "nothing-matches-this" })).toEqual([]);
  });
});

describe("DiffbotOntologyTool recoverable errors", () => {
  const HINT =
    "Valid ops: types, composites, enums, taxonomies, fields, " +
    "taxonomy, enum, search. List names first (e.g. op='types') " +
    "before drilling into fields/taxonomy/enum.";

  it("returns an error object for an unknown entity type", async () => {
    const { tool } = makeTool();
    const out = await tool.invoke({ op: "fields", name: "Nope" });
    expect(Array.isArray(out)).toBe(false);
    expect(out).toEqual({
      error: "Nope is not a known entity type or composite",
      hint: HINT,
    });
  });

  it("returns an error object for an unknown taxonomy or enum", async () => {
    const { tool } = makeTool();
    expect(await tool.invoke({ op: "taxonomy", name: "Nope" })).toEqual({
      error: "Unknown taxonomy: Nope",
      hint: HINT,
    });
    expect(await tool.invoke({ op: "enum", name: "Nope" })).toEqual({
      error: "Unknown enum: Nope",
      hint: HINT,
    });
  });

  it("returns an error object when `name` is missing", async () => {
    const { tool } = makeTool();
    const cases: Array<[string, string]> = [
      ["fields", "op='fields' requires `name` (the entity type or composite)."],
      ["taxonomy", "op='taxonomy' requires `name` (the taxonomy)."],
      ["enum", "op='enum' requires `name` (the enum)."],
      ["search", "op='search' requires `name` (the regex to match)."],
    ];
    for (const [op, error] of cases) {
      /* Never thrown — the agent is expected to read the hint and retry. */
      expect(await tool.invoke({ op: op as "fields" })).toEqual({
        error,
        hint: HINT,
      });
    }
  });
});
