/*
  Loader that calls Diffbot's Extract API on each of `urls` and yields a
  `Document` per URL.

  Client-only, like every component in this package: build a `DiffbotClient`
  and pass it in. URLs are extracted serially, in order.
*/

import { extract, type DiffbotClient, type JsonObject } from "@diffbot/typescript";
import { BaseDocumentLoader } from "@langchain/core/document_loaders/base";
import { Document } from "@langchain/core/documents";
import { assertClient, shapeExtractResponse, type DiffbotComponentFields } from "../base.js";

/* `(url, rawResponse) -> Document`. */
export type ExtractDocumentMapper = (url: string, raw: JsonObject) => Document;

function defaultExtractMapper(url: string, raw: JsonObject): Document {
  const shaped = shapeExtractResponse(raw);
  return new Document({
    pageContent: shaped.content,
    metadata: {
      url,
      title: shaped.title,
      pageUrl: shaped.pageUrl,
      resolvedPageUrl: shaped.resolvedPageUrl,
      type: shaped.type,
    },
  });
}

export interface DiffbotExtractLoaderFields extends DiffbotComponentFields {
  /* URLs to extract. */
  urls: string[];
  /* Diffbot extract API. Defaults to `analyze`. */
  api?: string;
  /* Output format. `markdown` uses Diffbot's LLM-optimized mode. */
  fmt?: string;
  /* Optional `(url, rawResponse) -> Document` override. */
  documentMapper?: ExtractDocumentMapper;
}

/*
  Loader that calls `extract` on each of `urls` and yields a `Document`.

  Example:
    const docs = await new DiffbotExtractLoader({
      client: new DiffbotClient({ token: ... }),
      urls: ["https://example.com", "https://diffbot.com"],
    }).load();
*/
export class DiffbotExtractLoader extends BaseDocumentLoader {
  static lc_name(): string {
    return "DiffbotExtractLoader";
  }

  lc_namespace = ["langchain", "document_loaders", "diffbot"];

  client: DiffbotClient;
  urls: string[];
  api: string;
  fmt: string;
  documentMapper?: ExtractDocumentMapper;

  constructor(fields: DiffbotExtractLoaderFields) {
    super();
    this.client = assertClient(fields.client);
    this.urls = fields.urls;
    this.api = fields.api ?? "analyze";
    this.fmt = fields.fmt ?? "markdown";
    this.documentMapper = fields.documentMapper;
  }

  private toDoc(url: string, raw: JsonObject): Document {
    const mapper = this.documentMapper ?? defaultExtractMapper;
    return mapper(url, raw);
  }

  /*
    Yield one `Document` per URL, calling `extract` serially.

    JavaScript's `BaseDocumentLoader` has only `load()` as its abstract
    contract (unlike Python, where `lazy_load` is primary), so `lazyLoad` is
    an addition on top rather than the method being overridden.
  */
  async *lazyLoad(): AsyncGenerator<Document> {
    for (const url of this.urls) {
      const raw = await extract(this.client, url, this.api, this.fmt);
      yield this.toDoc(url, raw);
    }
  }

  async load(): Promise<Document[]> {
    const docs: Document[] = [];
    for await (const doc of this.lazyLoad()) {
      docs.push(doc);
    }
    return docs;
  }
}
