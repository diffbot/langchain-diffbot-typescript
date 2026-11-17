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
  crawlDownload,
  crawlGetJob,
  CrawlEventType,
  JobError,
  type CrawlDataRecord,
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

/* `(record) -> Document | null`. Return null to skip the record. */
export type CrawlRecordMapper = (record: CrawlDataRecord) => Document | null;

/*
  Default mapping for downloaded crawl records: `content` becomes `pageContent`
  and the rest of the identifying fields become metadata. The record's `token`
  is deliberately never copied — the crawl API echoes the caller's token into
  every record, and metadata tends to end up in logs and vector stores.
*/
export function defaultCrawlRecordMapper(record: CrawlDataRecord): Document | null {
  const url = record.pageUrl ?? "";
  if (!url && !record.content) {
    return null;
  }
  return new Document({
    pageContent: record.content ?? "",
    metadata: {
      url,
      title: record.title,
      type: record.type,
      parentUrl: record.parentUrl,
      id: record.id,
      crawl_timestamp: record.timestamp,
    },
  });
}

/*
  Opt-in non-watch path. Instead of streaming URL events from `crawl`, create
  the job (or reuse a finished one), poll `crawlGetJob` until it reaches a
  terminal status, then fetch the extracted records once with `crawlDownload`.
  Suited to runtimes that can't sit in a watch loop.
*/
export interface DiffbotCrawlDownloadOptions {
  /*
    Name of an existing crawl job to download. When set, no job is created and
    `site` / `crawlOptions` are ignored (the job is still polled, so passing an
    unfinished job waits for it).
  */
  jobName?: string;
  /* Only the N most recently processed URLs (`crawlDownload`'s `num`). */
  num?: number;
  /* Milliseconds between status polls. Defaults to 2000. */
  pollInterval?: number;
  /* Give up polling after this many milliseconds. Defaults to no limit. */
  maxWait?: number;
  /* Optional `(record) -> Document | null` override. Return null to skip. */
  recordMapper?: CrawlRecordMapper;
}

export interface DiffbotCrawlLoaderFields extends DiffbotComponentFields {
  /* Seed URL for the crawl. Optional only when `download.jobName` is set. */
  site?: string;
  /*
    Switches the loader to the poll-then-`crawlDownload` path. Omit (the
    default) for the existing watch-style stream.
  */
  download?: DiffbotCrawlDownloadOptions;
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
  site?: string;
  download?: DiffbotCrawlDownloadOptions;
  crawlOptions: CrawlOptions;
  eventMapper?: CrawlEventMapper;

  constructor(fields: DiffbotCrawlLoaderFields) {
    super();
    this.client = assertClient(fields.client);
    if (fields.site === undefined && fields.download?.jobName === undefined) {
      throw new Error(
        "DiffbotCrawlLoader needs `site`, or `download.jobName` for an existing job.",
      );
    }
    this.site = fields.site;
    this.download = fields.download;
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
    if (this.download) {
      yield* this.lazyLoadDownload(this.download);
      return;
    }
    for await (const event of crawl(this.client, this.site!, this.crawlOptions)) {
      const doc = this.mapEvent(event);
      if (doc !== null) {
        yield doc;
      }
    }
  }

  private async *lazyLoadDownload(opts: DiffbotCrawlDownloadOptions): AsyncGenerator<Document> {
    let jobName = opts.jobName;
    if (jobName === undefined) {
      /* `watch: false` always: polling is done here, not inside the SDK stream. */
      for await (const event of crawl(this.client, this.site!, {
        ...this.crawlOptions,
        watch: false,
      })) {
        if (event.eventType === CrawlEventType.JobCreated) {
          const name = event.details.job_name;
          if (typeof name === "string") jobName = name;
        }
      }
      if (jobName === undefined) {
        throw new Error("Crawl did not report a job name.");
      }
    }
    await this.waitForJob(jobName, opts);

    const records = await crawlDownload(this.client, jobName, {
      ...(opts.num !== undefined ? { num: opts.num } : {}),
    });
    const mapper = opts.recordMapper ?? defaultCrawlRecordMapper;
    for (const record of records) {
      const doc = mapper(record);
      if (doc !== null) {
        yield doc;
      }
    }
  }

  /*
    Poll until the job leaves the pending/in-progress states (status 0 / 7,
    matching the SDK's own watch loop). A terminal message mentioning
    fail/error is a failed job, not an empty result.
  */
  private async waitForJob(jobName: string, opts: DiffbotCrawlDownloadOptions): Promise<void> {
    const pollInterval = opts.pollInterval ?? 2000;
    const deadline = opts.maxWait === undefined ? undefined : Date.now() + opts.maxWait;
    for (;;) {
      const job = await crawlGetJob(this.client, jobName);
      if (!job) {
        throw new JobError(jobName, "Crawler job not found");
      }
      const status = job.jobStatus?.status ?? 0;
      if (status !== 0 && status !== 7) {
        const message = job.jobStatus?.message ?? "";
        if (/fail|error/i.test(message)) {
          throw new JobError(jobName, `Crawler job failed: ${message}`);
        }
        return;
      }
      if (deadline !== undefined && Date.now() + pollInterval > deadline) {
        throw new JobError(jobName, `Crawler job did not finish within ${opts.maxWait}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
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
