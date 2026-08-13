import { webSearch, type DiffbotClient, type JsonObject } from "@diffbot/typescript";
import { type Document } from "@langchain/core/documents";
import { BaseRetriever, type BaseRetrieverInput } from "@langchain/core/retrievers";
import {
  assertClient,
  dictToDocument,
  resolveK,
  DEFAULT_WEB_CONTENT_FIELDS,
  type DiffbotComponentFields,
  type DocumentMapper,
} from "../base.js";

export interface DiffbotWebSearchRetrieverFields
  extends BaseRetrieverInput, DiffbotComponentFields {
  /* Number of results to fetch. Maps to the SDK's `numResults`. */
  k?: number;
  /* Optional cap on total content tokens. */
  maxTokens?: number;
  /*
    Allowlist of result keys to keep in `metadata`. Undefined keeps every field.
    Ignored when `documentMapper` is set.
  */
  fields?: string[];
  /*
    Ordered priority for selecting `pageContent`. First non-empty wins.
    Ignored when `documentMapper` is set.
  */
  contentFields?: string[];
  /* Full override mapping a raw search result to a `Document`. */
  documentMapper?: DocumentMapper;
}

/*
  Retriever backed by Diffbot's web search API.

  The query passed to `invoke` is a natural-language search string. Results come
  back as `Document`s whose `pageContent` is the page content (or snippet)
  Diffbot returned, with `title`, `pageUrl`, and `score` in `metadata` by default.
*/
export class DiffbotWebSearchRetriever extends BaseRetriever {
  static lc_name(): string {
    return "DiffbotWebSearchRetriever";
  }

  lc_namespace = ["langchain", "retrievers", "diffbot"];

  client: DiffbotClient;
  k: number;
  maxTokens?: number;
  fields?: string[];
  contentFields: string[];
  documentMapper?: DocumentMapper;

  constructor(fields: DiffbotWebSearchRetrieverFields) {
    super(fields);
    this.client = assertClient(fields.client);
    this.k = resolveK(fields.k ?? 10);
    this.maxTokens = fields.maxTokens;
    this.fields = fields.fields;
    this.contentFields = fields.contentFields ?? [...DEFAULT_WEB_CONTENT_FIELDS];
    this.documentMapper = fields.documentMapper;
  }

  async _getRelevantDocuments(query: string): Promise<Document[]> {
    const body = await webSearch(this.client, query, {
      numResults: this.k,
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
    });

    const results = Array.isArray(body.search_results) ? (body.search_results as JsonObject[]) : [];
    return results.slice(0, this.k).map((hit) => this.hitToDocument(hit));
  }

  private hitToDocument(hit: JsonObject): Document {
    if (this.documentMapper) {
      return this.documentMapper(hit as Record<string, unknown>);
    }
    /*
      No score injection here — unlike a KG hit, the score is already a
      top-level key of the search result itself.
    */
    return dictToDocument(hit as Record<string, unknown>, {
      contentFields: this.contentFields,
      fields: this.fields,
    });
  }
}
