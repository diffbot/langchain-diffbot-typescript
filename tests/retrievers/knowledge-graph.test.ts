import { describe, expect, it } from "vitest";
import { DiffbotClient, dql } from "@diffbot/typescript";
import { Document } from "@langchain/core/documents";
import { DiffbotKnowledgeGraphRetriever } from "../../src/retrievers/knowledge-graph.js";
import { createMockFetch, jsonResponse, type MockHandler } from "../helpers/mock-fetch.js";

const DQL_URL = "https://kg.diffbot.com/kg/v3/dql";

function makeClient(handler: MockHandler): DiffbotClient {
  return new DiffbotClient({
    token: "test-token",
    fetch: createMockFetch(handler),
  });
}

const SAMPLE_BODY = {
  data: [
    {
      score: 1000.0,
      entity: {
        id: "E1",
        type: "Organization",
        name: "Acme AI",
        description: "Boston-based AI company.",
        homepageUri: "https://acme.example",
      },
      entity_ctx: {},
    },
    {
      score: 500.0,
      entity: {
        id: "E2",
        type: "Organization",
        name: "Beta Labs",
        summary: "Robotics startup.",
      },
      entity_ctx: {},
    },
  ],
};

/*
  A single fat entity, mirroring the Python suite's FAT_BODY: enough noisy
  fields that a `fields` allowlist has something meaningful to drop.
*/
const FAT_BODY = {
  data: [
    {
      score: 1234.5,
      entity: {
        id: "E1",
        type: "Organization",
        name: "Acme AI",
        description: "Boston-based AI company.",
        homepageUri: "https://acme.example",
        nbEmployees: 42,
        suppliers: [{ name: "X" }, { name: "Y" }],
        industries: ["AI", "Robotics"],
        tags: Array.from({ length: 100 }, () => ({ label: "ML" })),
      },
      entity_ctx: {},
    },
  ],
};

describe("DiffbotKnowledgeGraphRetriever document mapping", () => {
  it("maps nested {score, entity} hits into documents", async () => {
    const db = makeClient((req) => {
      expect(req.url).toBe(DQL_URL);
      expect(req.method).toBe("GET");
      expect(req.params.get("query")).toBe("type:Organization");
      return jsonResponse(SAMPLE_BODY);
    });
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
      k: 2,
    }).invoke("type:Organization");

    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d instanceof Document)).toBe(true);
    expect(docs[0]!.pageContent).toBe("Boston-based AI company.");
    expect(docs[0]!.metadata.name).toBe("Acme AI");
    expect(docs[0]!.metadata.id).toBe("E1");
    expect(docs.map((d) => d.metadata.id)).toEqual(["E1", "E2"]);
  });

  it("maps flat hits whose entity fields sit at the top level", async () => {
    const db = makeClient(() =>
      jsonResponse({
        data: [{ id: "E9", type: "Organization", name: "Flat Co", description: "x" }],
      }),
    );
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
    }).invoke("type:Organization");

    expect(docs).toHaveLength(1);
    expect(docs[0]!.pageContent).toBe("x");
    expect(docs[0]!.metadata.name).toBe("Flat Co");
  });

  it("prefers description for pageContent", async () => {
    const db = makeClient(() =>
      jsonResponse({
        data: [
          {
            entity: {
              id: "E1",
              name: "Acme",
              description: "Long description.",
              summary: "Short summary.",
            },
          },
        ],
      }),
    );
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
    }).invoke("q");
    expect(docs[0]!.pageContent).toBe("Long description.");
  });

  it("falls back to summary when description is absent", async () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
      k: 2,
    }).invoke("q");
    expect(docs[1]!.pageContent).toBe("Robotics startup.");
  });

  it("falls all the way through to name when description and summary are absent", async () => {
    const db = makeClient(() =>
      jsonResponse({ data: [{ entity: { id: "E3", name: "Gamma Corp" } }] }),
    );
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
    }).invoke("q");
    expect(docs[0]!.pageContent).toBe("Gamma Corp");
    expect(docs[0]!.metadata).toEqual({ id: "E3" });
  });

  it("puts the outer hit score into metadata", async () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
      k: 2,
    }).invoke("q");
    expect(docs[0]!.metadata.score).toBe(1000.0);
    expect(docs[1]!.metadata.score).toBe(500.0);
  });

  it("keeps the score even when a narrow fields allowlist omits it", async () => {
    const db = makeClient(() => jsonResponse(FAT_BODY));
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
      fields: ["id", "name", "homepageUri", "nbEmployees"],
    }).invoke("type:Organization");

    expect(docs[0]!.pageContent).toBe("Boston-based AI company.");
    expect(Object.keys(docs[0]!.metadata).sort()).toEqual([
      "homepageUri",
      "id",
      "name",
      "nbEmployees",
      "score",
    ]);
    expect(docs[0]!.metadata).not.toHaveProperty("suppliers");
    expect(docs[0]!.metadata).not.toHaveProperty("tags");
  });

  it("excludes the chosen content key from metadata even when fields lists it", async () => {
    const db = makeClient(() => jsonResponse(FAT_BODY));
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
      fields: ["id", "name", "description"],
    }).invoke("type:Organization");

    expect(docs[0]!.pageContent).toBe("Boston-based AI company.");
    expect(docs[0]!.metadata).not.toHaveProperty("description");
    expect(Object.keys(docs[0]!.metadata).sort()).toEqual(["id", "name", "score"]);
  });

  it("respects a custom contentFields priority", async () => {
    const db = makeClient(() =>
      jsonResponse({
        data: [
          {
            id: "E1",
            name: "Acme",
            description: "Long description.",
            summary: "Short summary.",
          },
        ],
      }),
    );
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
      contentFields: ["summary", "description", "name"],
    }).invoke("type:Organization");

    expect(docs[0]!.pageContent).toBe("Short summary.");
    /* `summary` was consumed; `description` rides along in metadata. */
    expect(docs[0]!.metadata.description).toBe("Long description.");
    expect(docs[0]!.metadata).not.toHaveProperty("summary");
  });

  it("lets documentMapper override both fields and contentFields", async () => {
    const db = makeClient(() => jsonResponse(FAT_BODY));
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
      /* Both ignored while documentMapper is set. */
      fields: ["nbEmployees"],
      contentFields: ["description"],
      documentMapper: (entity) =>
        new Document({
          pageContent: `${String(entity.name)} (${String(entity.id)})`,
          metadata: { id: entity.id },
        }),
    }).invoke("type:Organization");

    expect(docs[0]!.pageContent).toBe("Acme AI (E1)");
    expect(docs[0]!.metadata).toEqual({ id: "E1" });
  });
});

describe("DiffbotKnowledgeGraphRetriever request wiring", () => {
  it("sends k as the size wire param", async () => {
    const db = makeClient((req) => {
      expect(req.params.get("size")).toBe("3");
      return jsonResponse(SAMPLE_BODY);
    });
    await new DiffbotKnowledgeGraphRetriever({ client: db, k: 3 }).invoke("type:Organization");
  });

  it("defaults size to 10 when k is not given", async () => {
    const db = makeClient((req) => {
      expect(req.params.get("size")).toBe("10");
      return jsonResponse(SAMPLE_BODY);
    });
    await new DiffbotKnowledgeGraphRetriever({ client: db }).invoke("type:Organization");
  });

  it("truncates the returned documents to k", async () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    const docs = await new DiffbotKnowledgeGraphRetriever({
      client: db,
      k: 1,
    }).invoke("q");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.metadata.id).toBe("E1");
  });

  it("rejects a non-positive k at construction time", () => {
    const db = makeClient(() => jsonResponse(SAMPLE_BODY));
    expect(() => new DiffbotKnowledgeGraphRetriever({ client: db, k: 0 })).toThrow(
      /`k` must be a positive integer/,
    );
  });

  it("sends from, filter, exportspec and extra as wire params", async () => {
    const db = makeClient((req) => {
      expect(req.params.get("size")).toBe("5");
      expect(req.params.get("from")).toBe("10");
      expect(req.params.get("filter")).toBe("type:Organization");
      expect(req.params.get("exportspec")).toBe("csv-spec");
      expect(req.params.get("revision")).toBe("2024-01");
      /* `format` defaults to json, which the SDK omits from the wire. */
      expect(req.params.get("format")).toBeNull();
      return jsonResponse(SAMPLE_BODY);
    });
    await new DiffbotKnowledgeGraphRetriever({
      client: db,
      k: 5,
      from: 10,
      filter: "type:Organization",
      exportspec: "csv-spec",
      extra: { revision: "2024-01" },
    }).invoke("name:Acme");
  });

  it("reuses the supplied client across calls and never closes it", async () => {
    let calls = 0;
    const db = makeClient(() => {
      calls += 1;
      return jsonResponse(SAMPLE_BODY);
    });
    const retriever = new DiffbotKnowledgeGraphRetriever({ client: db, k: 1 });

    await retriever.invoke("name:Acme");
    await retriever.invoke("name:Beta");
    expect(calls).toBe(2);

    /* A direct SDK call still works — proof the retriever left the client open. */
    await expect(dql(db, "name:Charlie", { size: 1 })).resolves.toEqual(SAMPLE_BODY);
    expect(calls).toBe(3);

    /* And the retriever is still usable after that. */
    await expect(retriever.invoke("name:Delta")).resolves.toHaveLength(1);
    expect(calls).toBe(4);
  });

  it("throws when the endpoint returns a non-JSON-object body", async () => {
    const db = makeClient((req) => {
      expect(req.params.get("format")).toBe("csv");
      /* A CSV export is not a JSON object, so the retriever refuses it. */
      return jsonResponse("id,name\nE1,Acme AI");
    });
    await expect(
      new DiffbotKnowledgeGraphRetriever({ client: db, format: "csv" }).invoke("type:Organization"),
    ).rejects.toThrow(/non-JSON body/);
  });
});
