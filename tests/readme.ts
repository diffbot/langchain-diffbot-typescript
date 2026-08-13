/*
  Shared helpers for testing the TypeScript code blocks in README.md.

  README.md is this package's complete reference, and two suites keep it honest:
  `readme_examples.test.ts` runs every block against a mocked `fetch`
  (deterministic, no token), and `readme_parity.test.ts` checks the components
  table stays in lockstep with the package surface (`src/index.ts`). The
  execution suite decides which blocks to run by inspecting each block's imports
  and whether it is executable.

  Ported from ../langchain-diffbot/tests/readme.py.
*/

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const README_PATH = resolve(HERE, "..", "README.md");

/*
  A block whose imports all fall in this set needs only Diffbot to run: it is
  mockable in the unit suite and safe to execute live with just a
  DIFFBOT_API_TOKEN — no Anthropic or other third-party calls, so CI never
  consumes non-Diffbot quota. Blocks importing anything else (the agent example
  pulls in @langchain/anthropic) are skipped by the execution suite.
*/
export const DIFFBOT_ONLY_IMPORTS = new Set([
  "@diffbot/langchain",
  "@diffbot/typescript",
  "@langchain/core",
  "langchain",
  "node:process",
]);

/*
  Components that construct one of these are documented but not executed.
  DiffbotCrawlLoader drives a real crawl job, which is slow and costly live and
  does not fit the per-call mock pattern the rest of the suite uses — the crawl
  path is covered directly in tests/loaders/crawl.test.ts instead.
*/
const NON_EXECUTABLE_CONSTRUCTORS = ["DiffbotCrawlLoader"];

const TS_BLOCK = /```(?:ts|typescript)\n([\s\S]*?)```/g;
const TABLE_ROW = /^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/gm;
/* Matches `from "x"` (import and re-export) and bare side-effect `import "x"`. */
const IMPORT_SOURCE = /(?:\bfrom\s+|^\s*import\s+)["']([^"']+)["']/gm;

export interface ReadmeBlock {
  /* Stable id derived from the block's line number, e.g. "L142". */
  id: string;
  source: string;
}

/* Return the raw text of README.md. */
export function read(): string {
  return readFileSync(README_PATH, "utf8");
}

/* Return every ```ts block, id'd by its line number in README.md. */
export function extractBlocks(): ReadmeBlock[] {
  const text = read();
  const blocks: ReadmeBlock[] = [];
  for (const match of text.matchAll(TS_BLOCK)) {
    const line = countLines(text.slice(0, match.index)) + 1;
    blocks.push({ id: `L${line}`, source: match[1] ?? "" });
  }
  return blocks;
}

/* Whether the README suites should execute this block, or only display it. */
export function isExecutable(source: string): boolean {
  return !NON_EXECUTABLE_CONSTRUCTORS.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source));
}

/*
  Package specifiers imported by a block, normalized to their package root:
  "@langchain/core/documents" → "@langchain/core", "langchain/agents" → "langchain".
*/
export function importRoots(source: string): Set<string> {
  const roots = new Set<string>();
  for (const match of source.matchAll(IMPORT_SOURCE)) {
    const specifier = match[1];
    if (!specifier) continue;
    roots.add(packageRoot(specifier));
  }
  return roots;
}

/* Whether every import in the block is satisfied by Diffbot + LangChain core. */
export function isDiffbotOnly(source: string): boolean {
  return [...importRoots(source)].every((root) => DIFFBOT_ONLY_IMPORTS.has(root));
}

/*
  Class names listed in the `## Components reference` table — the first
  backtick-wrapped cell of each row, stopping at the next H2 so later
  backticked cells are not picked up.
*/
export function componentsTableClasses(): string[] {
  const text = read();
  const start = text.indexOf("## Components reference");
  if (start === -1) {
    throw new Error("README.md has no `## Components reference` heading.");
  }
  let section = text.slice(start);
  const nextH2 = section.slice(3).search(/\n## /);
  if (nextH2 !== -1) {
    section = section.slice(0, nextH2 + 3);
  }
  return [...section.matchAll(TABLE_ROW)].map((m) => m[1] as string);
}

/*
  The component classes exported from the barrel, taken from the live module
  rather than parsed out of the source: prettier is free to collapse or expand
  the export blocks, and a source regex would also sweep up the DEFAULT_*
  constants. Every LangChain component declares `static lc_name()`, which is
  exactly the thing that distinguishes them from the helpers and constants.
*/
export function componentClassNames(mod: Record<string, unknown>): string[] {
  return Object.entries(mod)
    .filter(([, value]) => typeof value === "function" && "lc_name" in value)
    .map(([name]) => name)
    .sort();
}

function packageRoot(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0] as string;
}

function countLines(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === "\n") count += 1;
  }
  return count;
}
