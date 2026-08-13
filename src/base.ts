/*
  Shared contract for every @diffbot/langchain component.

  Client-only, by design: the caller builds a `DiffbotClient` and hands it in.
  Components never construct a client, never close one, and expose no token or
  timeout of their own — the client you build is the single place to configure
  the SDK (token, timeout, custom URLs, injected `fetch`). Share one client
  across many components to reuse a single connection pool.

  The Python package expresses this as a pydantic mixin that every class
  inherits alongside its LangChain base. TypeScript has no equivalent, so the
  shared surface lives here as a fields interface plus free helpers, and each
  class stores `client` itself.
*/

import type { DiffbotClient, JsonObject } from "@diffbot/typescript";
import { Document } from "@langchain/core/documents";

/* Mixed into every component's constructor-fields interface. */
export interface DiffbotComponentFields {
  /*
    A `DiffbotClient` from `@diffbot/typescript`. The component borrows it for
    the duration of each call and never closes it — lifecycle is the caller's.
  */
  client: DiffbotClient;
}

/* Ordered priority for selecting `pageContent` from a Knowledge Graph entity. */
export const DEFAULT_KG_CONTENT_FIELDS = ["description", "summary", "name"] as const;

/* Ordered priority for selecting `pageContent` from a web search result. */
export const DEFAULT_WEB_CONTENT_FIELDS = ["content", "snippet"] as const;

/* Full override for mapping a raw result object to a `Document`. */
export type DocumentMapper = (source: Record<string, unknown>) => Document;

/* Options for {@link dictToDocument}. */
export interface DictToDocumentOptions {
  /* First key with a non-empty value becomes `pageContent`. */
  contentFields: readonly string[];
  /*
    Allowlist of top-level keys to keep in `metadata`. `undefined` keeps every
    key. Diffbot KG entities and web-search results can run thousands of tokens
    each, so narrowing this matters when documents feed an LLM tool call.
  */
  fields?: readonly string[] | undefined;
}

/*
  TypeScript enforces `client` at compile time; this guards JavaScript callers
  and anyone casting through `any`.
*/
export function assertClient(client: DiffbotClient | undefined | null): DiffbotClient {
  if (!client) {
    throw new Error(
      "This component has no client. Pass `client: new DiffbotClient({ token: ... })` " +
        "(build it from the `@diffbot/typescript` SDK).",
    );
  }
  return client;
}

/*
  Map a flat object to a `Document` using a content-field priority list.

  `pageContent` is the first non-empty value among `contentFields`, stringified
  if it is not already a string. The winning key is excluded from `metadata` so
  the same data is not carried twice. `metadata` is the remaining top-level
  keys, narrowed to `fields` when that allowlist is given.
*/
export function dictToDocument(
  source: Record<string, unknown>,
  { contentFields, fields }: DictToDocumentOptions,
): Document {
  let pageContent = "";
  let contentFieldUsed: string | undefined;

  for (const field of contentFields) {
    const value = source[field];
    if (isNonEmpty(value)) {
      pageContent = typeof value === "string" ? value : stringify(value);
      contentFieldUsed = field;
      break;
    }
  }

  const metadata: Record<string, unknown> = {};
  const keys = fields ?? Object.keys(source);
  for (const key of keys) {
    if (key === contentFieldUsed) continue;
    if (!(key in source)) continue;
    metadata[key] = source[key];
  }

  return new Document({ pageContent, metadata });
}

/*
  Validate a retriever's result count.

  Unlike the Python package, `k` is constructor-only: the JavaScript
  `BaseRetriever._getRelevantDocuments(query, runManager)` signature has no
  kwargs channel, so there is no per-call override to validate.
*/
export function resolveK(k: number): number {
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`\`k\` must be a positive integer, got ${JSON.stringify(k)}.`);
  }
  return k;
}

/* The fields {@link shapeExtractResponse} pulls out of an Extract response. */
export interface ShapedExtractResponse {
  content: string;
  title?: string | undefined;
  pageUrl?: string | undefined;
  resolvedPageUrl?: string | undefined;
  type?: string | undefined;
}

/*
  Reduce a raw Extract response to the handful of fields callers actually want.

  Diffbot returns the interesting content under `objects[0]`, but which key
  holds the body depends on the requested format, and the two are mutually
  exclusive in practice:

    fmt: "markdown"  (the default; sends mode=llm)  ->  objects[0].content
    fmt: "text"                                     ->  objects[0].text

  `content` is checked first because it backs the default format. The top-level
  `markdown` fallback is kept for older/alternate response shapes.

  Shared by `DiffbotExtractTool` and `DiffbotExtractLoader`, which differ only
  in how they key the result.
*/
export function shapeExtractResponse(raw: JsonObject): ShapedExtractResponse {
  const objects = Array.isArray(raw.objects) ? (raw.objects as JsonObject[]) : [];
  const first = objects[0] ?? {};
  return {
    content: asString(first.content) ?? asString(first.text) ?? asString(raw.markdown) ?? "",
    title: asString(first.title) ?? asString(raw.title),
    pageUrl: asString(first.pageUrl) ?? asString(raw.url),
    resolvedPageUrl: asString(first.resolvedPageUrl),
    type: asString(first.type) ?? asString(raw.type),
  };
}

/*
  Mirrors Python's truthiness test, which is what the content-field priority
  list is written against: empty strings, empty arrays, empty objects, 0, and
  null/undefined all fall through to the next candidate field.
*/
function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function stringify(value: unknown): string {
  if (typeof value === "object") return JSON.stringify(value) ?? String(value);
  return String(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
