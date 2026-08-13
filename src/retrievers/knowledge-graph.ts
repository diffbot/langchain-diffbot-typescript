import { dql, type DiffbotClient, type JsonObject } from "@diffbot/typescript";
import { type Document } from "@langchain/core/documents";
import { BaseRetriever, type BaseRetrieverInput } from "@langchain/core/retrievers";
import {
  assertClient,
  dictToDocument,
  resolveK,
  DEFAULT_KG_CONTENT_FIELDS,
  type DiffbotComponentFields,
  type DocumentMapper,
} from "../base.js";

export interface DiffbotKnowledgeGraphRetrieverFields
  extends BaseRetrieverInput, DiffbotComponentFields {
  /*
    Number of results to fetch. Unlike the Python package there is no per-call
    override: the JavaScript retriever signature has no kwargs channel, so `k`
    is fixed at construction.
  */
  k?: number;
  /* Result offset. */
  from?: number;
  /* DQL filter expression. */
  filter?: string;
  /* Export spec for non-JSON formats. */
  exportspec?: string;
  /* Response format. Defaults to `json`; other values return raw bytes. */
  format?: string;
  /* Extra query params merged into the DQL request. */
  extra?: Record<string, string>;
  /*
    Allowlist of top-level entity keys to keep in `metadata`. Undefined keeps
    every field. Set this to something like ["id", "type", "name"] to shrink
    documents drastically — full Diffbot KG entities run thousands of tokens
    each, which matters when the retriever feeds an LLM tool call.

    Ignored when `documentMapper` is set.
  */
  fields?: string[];
  /*
    Ordered priority for selecting `pageContent` from an entity. The first key
    with a non-empty value wins, and is excluded from `metadata`.

    Ignored when `documentMapper` is set.
  */
  contentFields?: string[];
  /* Full override mapping a raw entity to a `Document`. */
  documentMapper?: DocumentMapper;
}

/*
  Retriever backed by the Diffbot Knowledge Graph DQL endpoint.

  The query passed to `invoke` is a DQL expression, e.g.
  `type:Organization industries:"Artificial Intelligence"`.
  See https://docs.diffbot.com/reference/dql-quickstart.

  Build a `DiffbotClient` and pass it in; one client can be shared across many
  components to reuse a single connection pool.
*/
export class DiffbotKnowledgeGraphRetriever extends BaseRetriever {
  static lc_name(): string {
    return "DiffbotKnowledgeGraphRetriever";
  }

  lc_namespace = ["langchain", "retrievers", "diffbot"];

  client: DiffbotClient;
  k: number;
  from: number;
  filter?: string;
  exportspec?: string;
  format: string;
  extra?: Record<string, string>;
  fields?: string[];
  contentFields: string[];
  documentMapper?: DocumentMapper;

  constructor(fields: DiffbotKnowledgeGraphRetrieverFields) {
    super(fields);
    this.client = assertClient(fields.client);
    this.k = resolveK(fields.k ?? 10);
    this.from = fields.from ?? 0;
    this.filter = fields.filter;
    this.exportspec = fields.exportspec;
    this.format = fields.format ?? "json";
    this.extra = fields.extra;
    this.fields = fields.fields;
    this.contentFields = fields.contentFields ?? [...DEFAULT_KG_CONTENT_FIELDS];
    this.documentMapper = fields.documentMapper;
  }

  async _getRelevantDocuments(query: string): Promise<Document[]> {
    const body = await dql(this.client, query, {
      size: this.k,
      from: this.from,
      format: this.format,
      /*
        `format` is only a wire param — the SDK decides whether to parse the
        body by `raw` alone. Without this, a non-JSON format would blow up
        inside the SDK's JSON.parse instead of reaching the directed error
        below, so ask for raw bytes whenever we are not expecting JSON.
      */
      raw: this.format !== "json",
      ...(this.filter !== undefined ? { filter: this.filter } : {}),
      ...(this.exportspec !== undefined ? { exportspec: this.exportspec } : {}),
      ...(this.extra !== undefined ? { extra: this.extra } : {}),
    });

    if (body instanceof Uint8Array || typeof body !== "object" || body === null) {
      throw new TypeError(
        "DQL returned a non-JSON body; set `format: 'json'` to use this retriever.",
      );
    }

    const data = Array.isArray(body.data) ? (body.data as JsonObject[]) : [];
    return data.slice(0, this.k).map((hit) => this.hitToDocument(hit));
  }

  private hitToDocument(hit: JsonObject): Document {
    /*
      Diffbot returns each result as {score, entity, entity_ctx}. Older shapes
      embed the entity fields at the top level, so fall back to the hit itself.
    */
    const entity = isPlainObject(hit.entity) ? hit.entity : hit;

    if (this.documentMapper) {
      return this.documentMapper(entity as Record<string, unknown>);
    }

    const doc = dictToDocument(entity as Record<string, unknown>, {
      contentFields: this.contentFields,
      fields: this.fields,
    });

    /*
      Deliberately after the `fields` projection: the outer hit's score always
      rides along, even when the allowlist omits it.
    */
    if ("score" in hit) {
      doc.metadata.score = hit.score;
    }
    return doc;
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
