import { describe, expect, it } from "vitest";
import {
  assertClient,
  dictToDocument,
  resolveK,
  shapeExtractResponse,
  DEFAULT_KG_CONTENT_FIELDS,
  DEFAULT_WEB_CONTENT_FIELDS,
} from "../src/base.js";

const KG = DEFAULT_KG_CONTENT_FIELDS;

describe("dictToDocument", () => {
  it("takes pageContent from the first non-empty content field", () => {
    const doc = dictToDocument(
      { name: "Diffbot", description: "A knowledge graph company." },
      { contentFields: KG },
    );
    expect(doc.pageContent).toBe("A knowledge graph company.");
  });

  it("falls through empty values to the next content field", () => {
    const doc = dictToDocument(
      { name: "Diffbot", description: "", summary: "Builds a knowledge graph." },
      { contentFields: KG },
    );
    expect(doc.pageContent).toBe("Builds a knowledge graph.");
  });

  it("falls all the way through to the last content field", () => {
    const doc = dictToDocument({ name: "Diffbot", id: "E1" }, { contentFields: KG });
    expect(doc.pageContent).toBe("Diffbot");
    expect(doc.metadata).toEqual({ id: "E1" });
  });

  it("leaves pageContent empty when no content field matches", () => {
    const doc = dictToDocument({ id: "E1" }, { contentFields: KG });
    expect(doc.pageContent).toBe("");
    expect(doc.metadata).toEqual({ id: "E1" });
  });

  it("excludes the winning content key from metadata", () => {
    const doc = dictToDocument(
      { id: "E1", name: "Diffbot", description: "Text." },
      { contentFields: KG },
    );
    expect(doc.metadata).toEqual({ id: "E1", name: "Diffbot" });
    expect(doc.metadata).not.toHaveProperty("description");
  });

  it("excludes the winning content key even when it is listed in fields", () => {
    const doc = dictToDocument(
      { id: "E1", name: "Diffbot", description: "Text." },
      { contentFields: KG, fields: ["id", "description"] },
    );
    expect(doc.metadata).toEqual({ id: "E1" });
  });

  it("keeps every remaining key when fields is undefined", () => {
    const doc = dictToDocument(
      { id: "E1", name: "Diffbot", nbEmployees: 40, description: "Text." },
      { contentFields: KG },
    );
    expect(Object.keys(doc.metadata).sort()).toEqual(["id", "name", "nbEmployees"]);
  });

  it("narrows metadata to the fields allowlist", () => {
    const doc = dictToDocument(
      { id: "E1", name: "Diffbot", nbEmployees: 40, homepageUri: "https://diffbot.com" },
      { contentFields: KG, fields: ["id", "nbEmployees"] },
    );
    expect(doc.metadata).toEqual({ id: "E1", nbEmployees: 40 });
  });

  it("ignores allowlist entries that are absent from the source", () => {
    const doc = dictToDocument({ id: "E1" }, { contentFields: KG, fields: ["id", "missing"] });
    expect(doc.metadata).toEqual({ id: "E1" });
  });

  it("stringifies a non-string content value", () => {
    const doc = dictToDocument({ description: { long: "nested" } }, { contentFields: KG });
    expect(doc.pageContent).toBe('{"long":"nested"}');
  });

  it("honours a caller-supplied content field priority", () => {
    const doc = dictToDocument(
      { content: "Full page text.", snippet: "Short." },
      { contentFields: DEFAULT_WEB_CONTENT_FIELDS },
    );
    expect(doc.pageContent).toBe("Full page text.");
  });

  it("falls back from content to snippet for web results", () => {
    const doc = dictToDocument(
      { snippet: "Short.", title: "A page" },
      { contentFields: DEFAULT_WEB_CONTENT_FIELDS },
    );
    expect(doc.pageContent).toBe("Short.");
    expect(doc.metadata).toEqual({ title: "A page" });
  });
});

describe("resolveK", () => {
  it("returns a positive integer unchanged", () => {
    expect(resolveK(5)).toBe(5);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects %p", (k) => {
    expect(() => resolveK(k)).toThrow(/`k` must be a positive integer/);
  });
});

describe("assertClient", () => {
  it("returns the client when present", () => {
    const client = { token: "t" } as never;
    expect(assertClient(client)).toBe(client);
  });

  it.each([undefined, null])("throws a directed message for %p", (client) => {
    expect(() => assertClient(client)).toThrow(/has no client/);
  });
});

describe("shapeExtractResponse", () => {
  it("prefers objects[0] over top-level fields", () => {
    const shaped = shapeExtractResponse({
      objects: [
        {
          text: "Object text.",
          title: "Object title",
          pageUrl: "https://example.com/a",
          resolvedPageUrl: "https://example.com/b",
          type: "article",
        },
      ],
      markdown: "Top-level markdown.",
      title: "Top-level title",
      url: "https://example.com/top",
      type: "other",
    });
    expect(shaped).toEqual({
      content: "Object text.",
      title: "Object title",
      pageUrl: "https://example.com/a",
      resolvedPageUrl: "https://example.com/b",
      type: "article",
    });
  });

  it("falls back to top-level markdown, title, url and type", () => {
    const shaped = shapeExtractResponse({
      markdown: "Top-level markdown.",
      title: "Top-level title",
      url: "https://example.com/top",
      type: "article",
    });
    expect(shaped.content).toBe("Top-level markdown.");
    expect(shaped.title).toBe("Top-level title");
    expect(shaped.pageUrl).toBe("https://example.com/top");
    expect(shaped.resolvedPageUrl).toBeUndefined();
    expect(shaped.type).toBe("article");
  });

  it("returns empty content when the response carries none", () => {
    expect(shapeExtractResponse({}).content).toBe("");
    expect(shapeExtractResponse({ objects: [] }).content).toBe("");
  });

  /*
    The default fmt: "markdown" sends mode=llm, and that response puts the body
    on objects[0].content with no `text` key at all. Reading only `text` (as an
    earlier version did) silently produced empty content for every page in the
    default format — a bug no mock caught, because the mocks were written
    against the fmt: "text" shape.
  */
  it("reads content from objects[0].content, as llm/markdown mode returns it", () => {
    const shaped = shapeExtractResponse({
      objects: [
        {
          content: "# Knowledge graph\n\nMarkdown body.",
          title: "Knowledge graph",
          pageUrl: "https://en.wikipedia.org/wiki/Knowledge_graph",
          type: "article",
        },
      ],
      title: "Knowledge graph",
    });
    expect(shaped.content).toBe("# Knowledge graph\n\nMarkdown body.");
    expect(shaped.title).toBe("Knowledge graph");
  });

  it("still reads objects[0].text, as text mode returns it", () => {
    const shaped = shapeExtractResponse({
      objects: [{ text: "Plain body.", title: "T" }],
    });
    expect(shaped.content).toBe("Plain body.");
  });

  it("prefers content over text when a response somehow carries both", () => {
    const shaped = shapeExtractResponse({
      objects: [{ content: "Markdown body.", text: "Plain body." }],
    });
    expect(shaped.content).toBe("Markdown body.");
  });
});
