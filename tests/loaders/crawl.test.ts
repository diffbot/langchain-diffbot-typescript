import { describe, expect, it } from "vitest";
import { CrawlEventType, DiffbotClient, type CrawlEvent } from "@diffbot/typescript";
import { Document } from "@langchain/core/documents";
import { DiffbotCrawlLoader, defaultCrawlMapper } from "../../src/loaders/crawl.js";
import { createMockFetch, jsonResponse, type MockHandler } from "../helpers/mock-fetch.js";

const CRAWL_URL = "https://api.diffbot.com/v3/crawl";

function makeClient(handler: MockHandler): DiffbotClient {
  return new DiffbotClient({ token: "test-token", fetch: createMockFetch(handler) });
}

describe("DiffbotCrawlLoader identity", () => {
  it("exposes the LangChain loader surface", () => {
    const loader = new DiffbotCrawlLoader({
      client: makeClient(() => jsonResponse({})),
      site: "https://example.com",
    });
    expect(DiffbotCrawlLoader.lc_name()).toBe("DiffbotCrawlLoader");
    expect(loader.lc_namespace).toEqual(["langchain", "document_loaders", "diffbot"]);
  });
});

describe("defaultCrawlMapper", () => {
  const jobEvent: CrawlEvent = {
    eventType: CrawlEventType.JobCreated,
    timestamp: "now",
    details: { job_name: "j1" },
  };
  const urlEvent: CrawlEvent = {
    eventType: CrawlEventType.UrlProcessed,
    timestamp: "2026-01-01T00:00:00Z",
    details: { url: "https://example.com/page", status: "ok" },
  };

  it("drops non-url_processed events", () => {
    expect(defaultCrawlMapper(jobEvent)).toBeNull();
  });

  it("maps a url_processed event to a Document keyed on the URL", () => {
    const doc = defaultCrawlMapper(urlEvent);
    expect(doc).not.toBeNull();
    expect(doc!.pageContent).toBe("https://example.com/page");
    expect(doc!.metadata).toEqual({
      url: "https://example.com/page",
      status: "ok",
      crawl_timestamp: "2026-01-01T00:00:00Z",
    });
  });
});

describe("DiffbotCrawlLoader custom eventMapper", () => {
  it("uses the caller-supplied mapper instead of the default", async () => {
    const db = makeClient(() => jsonResponse({ jobs: [{ name: "test-job" }] }));
    const loader = new DiffbotCrawlLoader({
      client: db,
      site: "https://example.com",
      crawlOptions: { jobName: "test-job", watch: false },
      eventMapper: (event) =>
        new Document({ pageContent: event.eventType, metadata: { ...event.details } }),
    });
    const docs = await loader.load();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.pageContent).toBe(CrawlEventType.JobCreated);
    expect(docs[0]!.metadata).toEqual({ job_name: "test-job" });
  });
});

describe("DiffbotCrawlLoader watch option defaulting", () => {
  it("defaults crawlOptions to {watch: true} when unset", () => {
    const loader = new DiffbotCrawlLoader({
      client: makeClient(() => jsonResponse({})),
      site: "https://example.com",
    });
    expect(loader.crawlOptions).toEqual({ watch: true });
  });

  it("preserves a user-supplied watch: false alongside other options", () => {
    const loader = new DiffbotCrawlLoader({
      client: makeClient(() => jsonResponse({})),
      site: "https://example.com",
      crawlOptions: { watch: false, hops: 3 },
    });
    expect(loader.crawlOptions).toEqual({ watch: false, hops: 3 });
  });

  it("watch: false reaches the wire as a single job-creation request with no polling", async () => {
    const requests: Array<{ url: string; params: URLSearchParams }> = [];
    const db = makeClient((req) => {
      requests.push({ url: req.url, params: req.params });
      return jsonResponse({ jobs: [{ name: "test-job" }] });
    });
    const loader = new DiffbotCrawlLoader({
      client: db,
      site: "https://example.com",
      crawlOptions: { watch: false, hops: 3, jobName: "test-job" },
    });

    const docs = await loader.load();

    /* Default mapper drops the lone job_created event. */
    expect(docs).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(CRAWL_URL);
    expect(requests[0]!.params.get("maxHops")).toBe("3");
    expect(requests[0]!.params.get("seeds")).toBe("https://example.com");
  });
});

describe("DiffbotCrawlLoader end-to-end with watch: true (the default)", () => {
  it("polls the job and yields a Document per crawled URL", async () => {
    /*
      Only the Url column gets its surrounding quotes stripped by the SDK's
      CSV parser (`parseUrlCsv`) — Crawled Time and Crawl Status are read
      verbatim, so leave those two unquoted here.
    */
    const csv =
      "Url,Crawled Time,Crawl Status\n" +
      '"https://example.com/page1",2026-01-01T00:00:00Z,200\n' +
      '"https://example.com/page2",2026-01-01T00:00:01Z,200\n';

    const requestKinds: string[] = [];
    const db = makeClient((req) => {
      if (req.url.endsWith("/data")) {
        requestKinds.push("data");
        expect(req.params.get("type")).toBe("urls");
        return new Response(csv, { status: 200, headers: { "Content-Type": "text/csv" } });
      }
      if (req.params.get("seeds")) {
        requestKinds.push("create");
        return jsonResponse({ jobs: [{ name: "test-job" }] });
      }
      requestKinds.push("status");
      /* Completed (not 0/pending, not 7/in-progress), no fail/error keyword. */
      return jsonResponse({
        jobs: [{ jobStatus: { status: 2, message: "Job complete." } }],
      });
    });

    /* No `crawlOptions.watch` set — must default to true for polling to occur. */
    const loader = new DiffbotCrawlLoader({
      client: db,
      site: "https://example.com",
      crawlOptions: { jobName: "test-job", pollInterval: 0 },
    });

    const docs = await loader.load();

    expect(requestKinds).toEqual(["create", "status", "data"]);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.pageContent).toBe("https://example.com/page1");
    expect(docs[0]!.metadata).toEqual({
      url: "https://example.com/page1",
      status: "200",
      crawl_timestamp: "2026-01-01T00:00:00Z",
    });
    expect(docs[1]!.pageContent).toBe("https://example.com/page2");
  });
});

describe("DiffbotCrawlLoader download mode (non-watch crawlDownload)", () => {
  const RECORDS = [
    {
      pageUrl: "https://example.com/a",
      title: "A",
      type: "article",
      content: "Body A",
      token: "test-token",
      timestamp: "2026-01-01T00:00:00Z",
    },
    { pageUrl: "https://example.com/b", title: "B", type: "article", content: "Body B" },
  ];

  it("creates the job, polls until finished, then downloads records as Documents", async () => {
    const kinds: string[] = [];
    let statusCalls = 0;
    const db = makeClient((req) => {
      if (req.url.endsWith("/data")) {
        kinds.push("data");
        expect(req.params.get("name")).toBe("dl-job");
        expect(req.params.get("num")).toBe("5");
        expect(req.params.get("type")).toBeNull();
        return jsonResponse(RECORDS);
      }
      if (req.params.get("seeds")) {
        kinds.push("create");
        return jsonResponse({ jobs: [{ name: "dl-job" }] });
      }
      kinds.push("status");
      statusCalls += 1;
      /* First poll still running (status 7), second poll done. */
      return jsonResponse({
        jobs: [{ jobStatus: statusCalls === 1 ? { status: 7 } : { status: 9, message: "done" } }],
      });
    });

    const docs = await new DiffbotCrawlLoader({
      client: db,
      site: "https://example.com",
      crawlOptions: { jobName: "dl-job" },
      download: { num: 5, pollInterval: 1 },
    }).load();

    expect(kinds).toEqual(["create", "status", "status", "data"]);
    expect(docs.map((d) => d.pageContent)).toEqual(["Body A", "Body B"]);
    expect(docs[0]!.metadata.url).toBe("https://example.com/a");
    /* The echoed token must never reach metadata. */
    expect(JSON.stringify(docs)).not.toContain("test-token");
  });

  it("downloads an already-finished job without creating one", async () => {
    const kinds: string[] = [];
    const db = makeClient((req) => {
      if (req.url.endsWith("/data")) {
        kinds.push("data");
        return jsonResponse(RECORDS);
      }
      expect(req.params.get("seeds")).toBeNull();
      kinds.push("status");
      return jsonResponse({ jobs: [{ jobStatus: { status: 9, message: "done" } }] });
    });

    const docs = await new DiffbotCrawlLoader({
      client: db,
      download: { jobName: "old-job" },
    }).load();

    expect(kinds).toEqual(["status", "data"]);
    expect(docs).toHaveLength(2);
  });

  it("applies a custom recordMapper and skips nulls", async () => {
    const db = makeClient((req) =>
      req.url.endsWith("/data")
        ? jsonResponse(RECORDS)
        : jsonResponse({ jobs: [{ jobStatus: { status: 9, message: "done" } }] }),
    );
    const docs = await new DiffbotCrawlLoader({
      client: db,
      download: {
        jobName: "old-job",
        recordMapper: (r) =>
          r.title === "A" ? new Document({ pageContent: String(r.title) }) : null,
      },
    }).load();
    expect(docs.map((d) => d.pageContent)).toEqual(["A"]);
  });

  it("throws when the finished job reports a failure", async () => {
    const db = makeClient(() =>
      jsonResponse({ jobs: [{ jobStatus: { status: 5, message: "Job failed: bad seed" } }] }),
    );
    await expect(
      new DiffbotCrawlLoader({ client: db, download: { jobName: "bad" } }).load(),
    ).rejects.toThrow(/failed/);
  });

  it("throws when the job does not exist", async () => {
    const db = makeClient(() => jsonResponse({ jobs: [] }));
    await expect(
      new DiffbotCrawlLoader({ client: db, download: { jobName: "nope" } }).load(),
    ).rejects.toThrow(/not found/);
  });

  it("gives up after maxWait", async () => {
    const db = makeClient(() => jsonResponse({ jobs: [{ jobStatus: { status: 7 } }] }));
    await expect(
      new DiffbotCrawlLoader({
        client: db,
        download: { jobName: "slow", pollInterval: 5, maxWait: 1 },
      }).load(),
    ).rejects.toThrow(/did not finish/);
  });

  it("requires site or download.jobName", () => {
    expect(() => new DiffbotCrawlLoader({ client: makeClient(() => jsonResponse({})) })).toThrow(
      /site/,
    );
  });

  it("leaves the default watch behavior alone when download is unset", () => {
    const loader = new DiffbotCrawlLoader({
      client: makeClient(() => jsonResponse({})),
      site: "https://example.com",
    });
    expect(loader.download).toBeUndefined();
    expect(loader.crawlOptions.watch).toBe(true);
  });

  it("falls back to `text` when a record has no `content`", async () => {
    const db = makeClient((req) =>
      req.url.endsWith("/data")
        ? jsonResponse([{ pageUrl: "https://example.com/c", type: "article", text: "Body C" }])
        : jsonResponse({ jobs: [{ jobStatus: { status: 9, message: "done" } }] }),
    );
    const docs = await new DiffbotCrawlLoader({
      client: db,
      download: { jobName: "old-job" },
    }).load();
    expect(docs.map((d) => d.pageContent)).toEqual(["Body C"]);
  });
});
