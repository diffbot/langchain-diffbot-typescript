/*
  Loader that drives a Diffbot crawl and yields a `Document` per URL.

  By default `pageContent` is the crawled URL itself (the crawl SDK only
  yields URL events, not page contents). To fetch content per URL, chain this
  with `DiffbotExtractLoader`.

  Defaults `watch: true` into `crawlOptions` so URL events are actually
  emitted — without it the SDK only yields a single `job_created` event, which
  the default mapper skips. A caller-supplied `watch: false` is preserved.
*/

import {
  crawl,
  CrawlEventType,
  type CrawlEvent,
  type CrawlOptions,
  type DiffbotClient,
} from "@diffbot/typescript";
import { BaseDocumentLoader } from "@langchain/core/document_loaders/base";
import { Document } from "@langchain/core/documents";
import { assertClient, type DiffbotComponentFields } from "../base.js";

/* `(event) -> Document | null`. Return null to skip the event. */
export type CrawlEventMapper = (event: CrawlEvent) => Document | null;

/*
  Default `(event) -> Document | null` mapping, exported so tests (and
  callers building a custom mapper that wraps the default) can exercise it
  directly without driving HTTP.
*/
export function defaultCrawlMapper(event: CrawlEvent): Document | null {
  /*
    Non-URL events (e.g. job_created) are skipped by default. The Document's
    pageContent is the URL itself — the crawl SDK only surfaces URLs, not page
    contents. Chain with `DiffbotExtractLoader` to fetch content.
  */
  if (event.eventType !== CrawlEventType.UrlProcessed) {
    return null;
  }
  const url = typeof event.details.url === "string" ? event.details.url : "";
  return new Document({
    pageContent: url,
    metadata: {
      url,
      status: event.details.status,
      crawl_timestamp: event.timestamp,
    },
  });
}

export interface DiffbotCrawlLoaderFields extends DiffbotComponentFields {
  /* Seed URL for the crawl. */
  site: string;
  /*
    Extra options passed to `crawl(client, site, options)`.

    Defaults to `{watch: true}` if not overridden — see the module-level
    comment for why.
  */
  crawlOptions?: CrawlOptions;
  /* Optional `(event) -> Document | null` override. Return null to skip. */
  eventMapper?: CrawlEventMapper;
}

/*
  Loader that drives `crawl` and yields a `Document` per mapped event.

  Example:
    const docs = await new DiffbotCrawlLoader({
      client: new DiffbotClient({ token: ... }),
      site: "https://example.com",
    }).load();
*/
export class DiffbotCrawlLoader extends BaseDocumentLoader {
  static lc_name(): string {
    return "DiffbotCrawlLoader";
  }

  lc_namespace = ["langchain", "document_loaders", "diffbot"];

  client: DiffbotClient;
  site: string;
  crawlOptions: CrawlOptions;
  eventMapper?: CrawlEventMapper;

  constructor(fields: DiffbotCrawlLoaderFields) {
    super();
    this.client = assertClient(fields.client);
    this.site = fields.site;
    this.crawlOptions = { ...(fields.crawlOptions ?? {}) };
    if (this.crawlOptions.watch === undefined) {
      this.crawlOptions.watch = true;
    }
    this.eventMapper = fields.eventMapper;
  }

  private mapEvent(event: CrawlEvent): Document | null {
    const mapper = this.eventMapper ?? defaultCrawlMapper;
    return mapper(event);
  }

  /*
    Drive a crawl and yield a `Document` per mapped event. `crawl` is already
    an `AsyncGenerator<CrawlEvent>`, so this is a natural passthrough.
  */
  async *lazyLoad(): AsyncGenerator<Document> {
    for await (const event of crawl(this.client, this.site, this.crawlOptions)) {
      const doc = this.mapEvent(event);
      if (doc !== null) {
        yield doc;
      }
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
