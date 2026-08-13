/*
  Live integration tests against the real Diffbot Extract API. These hit a
  live, changing web, and consume API quota, so assertions are shape-based
  rather than content-based. Requires DIFFBOT_API_TOKEN; the whole suite is
  skipped when it is unset (see vitest.live.config.ts for how this file is
  picked up).

  DiffbotCrawlLoader is deliberately not tested here: a real crawl job is
  slow (it runs asynchronously against Diffbot's crawler infrastructure) and
  costly in quota, and would make the nightly live run unreliable and slow.
*/

import { describe, expect, it } from "vitest";
import { DiffbotClient } from "@diffbot/typescript";
import { Document } from "@langchain/core/documents";
import { DiffbotExtractLoader } from "../../src/loaders/extract.js";

const token = process.env.DIFFBOT_API_TOKEN;

/*
  Built even when `token` is undefined, since `describe.skipIf` still
  collects (but does not run) the tests inside — the SDK requires a
  non-empty token string at construction, so fall back to a placeholder
  that is never actually used because the tests it backs are skipped.
*/
const client = new DiffbotClient({ token: token ?? "unused-token-suite-skipped" });

describe.skipIf(!token)("DiffbotExtractLoader (live)", () => {
  it("loads one Document per URL with the requested url in metadata", async () => {
    /*
      Wikipedia articles are the most stable extract fixtures available: long
      lived, unauthenticated, and reliably rich in body text. An earlier
      fixture (https://www.diffbot.com/about/) 404s.
    */
    const urls = [
      "https://en.wikipedia.org/wiki/Knowledge_graph",
      "https://en.wikipedia.org/wiki/Web_scraping",
    ];
    const loader = new DiffbotExtractLoader({ client, urls });

    const docs = await loader.load();

    expect(docs).toHaveLength(urls.length);
    docs.forEach((doc, i) => {
      expect(doc).toBeInstanceOf(Document);
      expect(typeof doc.pageContent).toBe("string");
      expect(doc.metadata.url).toBe(urls[i]);
    });
  });
});
