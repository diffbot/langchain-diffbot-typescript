/*
  Execute the TypeScript code blocks in README.md against a stubbed `fetch`.

  README.md is this package's complete reference, so a renamed class, a changed
  option, or a wrong import should surface here as a failing block rather than
  as a reader copy-pasting something broken. The blocks are not mirrored by
  hand — they are extracted from the file, rewritten so `@diffbot/langchain`
  points at `src/index.ts`, written to a scratch module, and imported. Vitest
  transforms them on demand, so what runs is the exact text a reader sees.

  Two categories are skipped. Blocks that are documented but not executed
  (`isExecutable` — the crawl examples drive a real job, which does not fit the
  per-call mock pattern; `tests/loaders/crawl.test.ts` covers that path) and
  blocks importing anything outside `DIFFBOT_ONLY_IMPORTS` (the LCEL example
  pulls in `@langchain/anthropic`, which would spend third-party quota).

  Ported from ../langchain-diffbot/tests/unit_tests/test_readme_examples.py,
  where the same job is done with `exec()` under `respx`.
*/

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBlocks, isDiffbotOnly, isExecutable } from "./readme.js";
import {
  createMockFetch,
  jsonResponse,
  sseResponse,
  type MockRequest,
} from "./helpers/mock-fetch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BARREL = resolve(ROOT, "src", "index.ts");

/*
  Scratch modules live at the repo root, dot-prefixed: `tsconfig.json` only
  includes `src/` and `tests/`, eslint and prettier are pointed at those same
  two directories, and vite still resolves bare imports from the root
  `node_modules`. Anywhere under `tests/` would land in the typecheck graph.
*/
const SCRATCH = resolve(ROOT, ".readme-blocks");

/* Endpoint fixtures, mirroring the per-component unit tests. */
const DQL_URL = "https://kg.diffbot.com/kg/v3/dql";
const ONTOLOGY_URL = "https://kg.diffbot.com/kg/ontology";
const WEB_SEARCH_URL = "https://llm.diffbot.com/api/v1/web_search";
const ASK_URL = "https://llm.diffbot.com/rag/v1/chat/completions";
const NLP_URL = "https://nl.diffbot.com/v1/";
const EXTRACT_PREFIX = "https://api.diffbot.com/v3/";

const DQL_BODY = {
  /* `hits` lets the DQL-probe example (size=0) shape a real count. */
  hits: 42,
  data: [
    {
      score: 1000.0,
      entity: {
        id: "E1",
        type: "Organization",
        name: "Acme AI",
        description: "Boston-based AI company.",
        homepageUri: "https://acme.example",
        nbEmployees: 42,
        industries: ["Artificial Intelligence"],
      },
      entity_ctx: {},
    },
  ],
};

const ONTOLOGY_BODY = {
  types: {
    Organization: {
      fields: {
        name: { type: "String" },
        location: { type: "Location", isComposite: true },
      },
    },
    Person: { fields: { name: { type: "String" } } },
  },
  composites: { Location: { fields: { city: { type: "City", isComposite: true } } } },
  enums: { Language: { values: ["EN", "FR"] } },
  taxonomies: { OrganizationCategory: { categories: [{ name: "Technology" }] } },
};

const WEB_SEARCH_BODY = {
  search_results: [
    {
      score: 0.91,
      title: "Diffbot Knowledge Graph",
      pageUrl: "https://www.diffbot.com/kg/",
      content: "Diffbot KG is the largest commercial knowledge graph...",
    },
  ],
};

const ANALYZE_BODY = {
  objects: [
    {
      text: "Hello world",
      title: "Example",
      type: "article",
      pageUrl: "https://example.com",
    },
  ],
};

const NLP_BODY = [
  {
    entities: [{ name: "Diffbot", type: "Organization", id: "E1" }],
    sentiment: 0.4,
  },
];

const SSE_BODY =
  'data: {"choices": [{"delta": {"content": "Hello"}}]}\n' +
  'data: {"choices": [{"delta": {"content": ", world"}}]}\n' +
  "data: [DONE]\n";

function route(request: MockRequest): Response {
  if (request.url === DQL_URL) return jsonResponse(DQL_BODY);
  if (request.url === ONTOLOGY_URL) return jsonResponse(ONTOLOGY_BODY);
  if (request.url === WEB_SEARCH_URL) return jsonResponse(WEB_SEARCH_BODY);
  if (request.url === ASK_URL) return sseResponse(SSE_BODY);
  if (request.url === NLP_URL) return jsonResponse(NLP_BODY);
  if (request.url.startsWith(EXTRACT_PREFIX)) return jsonResponse(ANALYZE_BODY);
  throw new Error(`README example hit an unmocked endpoint: ${request.url}`);
}

/*
  `@diffbot/langchain` is this package — it is not in `node_modules`, so the
  block's own import specifier has to be pointed at the barrel source. Every
  other specifier resolves normally from the repo root.
*/
function rewriteImports(source: string): string {
  return source.replace(/(["'])@diffbot\/langchain\1/g, JSON.stringify(BARREL));
}

const BLOCKS = extractBlocks();

/*
  Blocks are decided at module scope so each one becomes its own `it`, named
  after its line number in README.md — a failure points straight at the text.
*/
const CASES = BLOCKS.map((block) => ({
  ...block,
  skip: !isExecutable(block.source)
    ? "documented but not executed (drives a real crawl job)"
    : !isDiffbotOnly(block.source)
      ? "imports a non-Diffbot package — covered by the live suite"
      : null,
}));

describe("README examples", () => {
  beforeAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
  });

  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("DIFFBOT_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", createMockFetch(route));
    /* Examples print for illustration; swallow it to keep test output clean. */
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("extracts the code blocks from README.md", () => {
    /*
      Guard against the extraction silently matching nothing (e.g. a fence
      style change), which would make every case below vanish rather than fail.
    */
    expect(BLOCKS.length).toBeGreaterThanOrEqual(12);
  });

  for (const { id, source, skip } of CASES) {
    if (skip) {
      it.skip(`${id} — ${skip}`, () => {});
      continue;
    }

    it(`${id} runs`, async () => {
      const file = resolve(SCRATCH, `${id}.ts`);
      writeFileSync(file, rewriteImports(source), "utf8");
      await import(/* @vite-ignore */ pathToFileURL(file).href);
    });
  }
});
