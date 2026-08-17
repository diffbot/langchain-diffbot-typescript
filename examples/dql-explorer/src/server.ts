/*
  Hono app: author DQL with the agent, run it, return a table.

  POST /api/query runs the structured DQL-authoring agent, then runs the DQL it
  produced against the Diffbot KG and projects the chosen columns into rows. The
  built React SPA (in web/dist) is served from `/` so the whole thing runs on a
  single port: build once, run the server, open the browser.
*/

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { APIError, DiffbotClient, type JsonObject } from "@diffbot/typescript";
import { resolveToken } from "@diffbot/typescript/node";
import { ChatDiffbot, DiffbotKnowledgeGraphTool } from "@diffbot/langchain";
import { config as loadEnv } from "dotenv";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "langchain";
import { Client as LangSmithClient } from "langsmith";
import { buildDqlAgent, type DQLPlan } from "./agent.js";
import { buildDashboard, defaultRange } from "./dashboard.js";
import { buildRows } from "./projection.js";

/*
  Read examples/.env (DIFFBOT_API_TOKEN, ANTHROPIC_API_KEY, optional LANGSMITH_*).
  Resolved relative to this file (not the process CWD) so `tsx src/server.ts`
  finds the same shared `examples/.env` regardless of where it's launched from.
*/
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(here, "..", "..", ".env") });

/* Default number of result rows to fetch and render. */
const DEFAULT_K = 25;
/* Truncate tool outputs shown in the collapsible "steps" panel. */
const STEP_OUTPUT_CHARS = 300;

const DIST_DIR = path.join(here, "..", "web", "dist");

/*
  120s rather than the SDK's 30s default. One client serves every endpoint here,
  and the Ask tab drives Diffbot's RAG LLM, which routinely runs 15-30s and
  sometimes longer — on the default it intermittently aborts mid-answer. The KG
  and dashboard calls are fast and unaffected by the higher ceiling.
*/
const client = new DiffbotClient({ token: resolveToken(), timeout: 120_000 });

/*
  The authoring agent is built lazily (it calls `initChatModel`, which is
  async) and cached for the life of the process — `DiffbotOntologyTool`'s
  fetched ontology is cached on the tool instance, so building the agent once
  means the ontology is fetched once, not on every request.
*/
let agentPromise: ReturnType<typeof buildDqlAgent> | undefined;
function getAgent() {
  agentPromise ??= buildDqlAgent(client);
  return agentPromise;
}

const kgTool = new DiffbotKnowledgeGraphTool({ client });

/*
  Diffbot's own RAG LLM. Unlike the DQL Builder's Anthropic agent, this needs no
  API key beyond DIFFBOT_API_TOKEN — the graph is the model's knowledge.
*/
const chat = new ChatDiffbot({ client });

interface Step {
  tool: string;
  args: Record<string, unknown>;
  output: string;
}

/* Flatten the agent's message trace into tool-call/result steps for the UI. */
function extractSteps(messages: readonly BaseMessage[]): Step[] {
  /* Map tool_call_id -> truncated output so each call shows its result. */
  const outputs = new Map<string, string>();
  for (const msg of messages) {
    if (msg.getType() === "tool") {
      const tm = msg as ToolMessage;
      const text = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content);
      outputs.set(tm.tool_call_id, text.slice(0, STEP_OUTPUT_CHARS));
    }
  }

  const steps: Step[] = [];
  for (const msg of messages) {
    if (msg.getType() !== "ai") continue;
    for (const call of (msg as AIMessage).tool_calls ?? []) {
      steps.push({
        tool: call.name,
        args: call.args,
        output: (call.id && outputs.get(call.id)) ?? "",
      });
    }
  }
  return steps;
}

/*
  LangGraph defaults to 25 steps, which a real authoring loop overruns: ontology
  listings are capped at ONTOLOGY_MAX_ITEMS, so the agent narrows them
  iteratively (types -> fields -> search) and probes several query variants
  before committing. A broad question like "AI companies in California with more
  than 500 employees" exhausts 25 and fails with no plan at all. Each step is
  small and capped, so a higher ceiling costs little and turns a hard failure
  into a slightly longer run.
*/
const RECURSION_LIMIT = 60;

/* Build a LangSmith run URL when tracing is enabled. Never throws. */
async function traceUrl(runId: string): Promise<string | null> {
  if (!process.env.LANGSMITH_TRACING) return null;
  try {
    const ls = new LangSmithClient();
    return await ls.getRunUrl({ runId });
  } catch {
    /* Tracing is a nice-to-have; a hiccup here must not fail the query. */
    return null;
  }
}

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const app = new Hono();

app.post("/api/query", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    question?: unknown;
    k?: unknown;
  };
  const question = typeof body.question === "string" ? body.question : "";
  const k = clamp(typeof body.k === "number" ? body.k : DEFAULT_K, 1, 100);

  /* Pre-generate the run id so a LangSmith trace URL can be built after the
     agent finishes, without needing a custom callback handler to recover it. */
  const runId = randomUUID();

  let messages: BaseMessage[];
  let plan: DQLPlan;
  try {
    const agent = await getAgent();
    const result = await agent.invoke(
      { messages: [new HumanMessage(question)] },
      { runId, recursionLimit: RECURSION_LIMIT },
    );
    plan = result.structuredResponse as DQLPlan;
    messages = result.messages;
  } catch (exc) {
    return c.json({
      question,
      entity_type: "",
      dql: "",
      notes: null,
      columns: [],
      rows: [],
      hits: 0,
      steps: [],
      trace_url: null,
      error: `The agent failed to build a query: ${errorMessage(exc)}`,
    });
  }

  const base = {
    question,
    entity_type: plan.entityType,
    dql: plan.dql,
    notes: plan.notes ?? null,
    columns: plan.columns,
    steps: extractSteps(messages),
    trace_url: await traceUrl(runId),
  };

  const paths = plan.columns.map((column) => column.path);
  try {
    const kgBody = await kgTool.invoke({ query: plan.dql, size: k });
    const data = Array.isArray(kgBody.data) ? (kgBody.data as JsonObject[]) : [];
    return c.json({
      ...base,
      rows: buildRows(data, paths),
      hits: typeof kgBody.hits === "number" ? kgBody.hits : 0,
      error: null,
    });
  } catch (exc) {
    if (exc instanceof APIError) {
      /* Surface DQL errors to the UI alongside the query that failed. */
      return c.json({
        ...base,
        rows: [],
        hits: 0,
        error: `Diffbot rejected the query (${exc.statusCode}): ${exc.apiMessage ?? "see body"}.`,
      });
    }
    throw exc;
  }
});

app.post("/api/dashboard", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    min_employees?: unknown;
    date_from?: unknown;
    date_to?: unknown;
  };
  const [defaultFrom, defaultTo] = defaultRange();
  const minEmployees = clamp(
    typeof body.min_employees === "number" ? body.min_employees : 4000,
    0,
    1_000_000,
  );
  const dateFrom =
    typeof body.date_from === "string" && body.date_from ? body.date_from : defaultFrom;
  const dateTo = typeof body.date_to === "string" && body.date_to ? body.date_to : defaultTo;

  return c.json(await buildDashboard(client, minEmployees, dateFrom, dateTo));
});

/*
  Answer `question` with Diffbot's RAG LLM, streaming tokens as SSE.

  This is the showcase for `ChatDiffbot`: where the DQL Builder authors a precise
  query, this just asks Diffbot's own LLM, which is grounded in the Knowledge
  Graph and the live web. `ChatDiffbot`'s streaming iterator forwards each chunk
  to the browser as it arrives instead of buffering the answer.
*/
app.post("/api/ask", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { question?: unknown };
  const question = typeof body.question === "string" ? body.question : "";

  /* Disable proxy/nginx buffering so tokens reach the browser as they stream. */
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of await chat.stream([new HumanMessage(question)])) {
        const text = typeof chunk.content === "string" ? chunk.content : String(chunk.content);
        if (text) {
          await stream.writeSSE({ event: "token", data: JSON.stringify({ text }) });
        }
      }
      await stream.writeSSE({ event: "done", data: "{}" });
    } catch (exc) {
      const message =
        exc instanceof APIError
          ? `Diffbot rejected the request (${exc.statusCode}): ${exc.apiMessage ?? "see body"}.`
          : errorMessage(exc);
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
    }
  });
});

/*
  In dev (`pnpm dev` runs the server with DQL_EXPLORER_RELOAD=1), the live UI is
  the Vite server on :5173 — the `dist/` this backend would serve is the last
  `pnpm build` and is stale the moment you edit any frontend file. Bounce :8000
  over to Vite so an accidental reload of :8000 doesn't show old code.
*/
const DEV = process.env.DQL_EXPLORER_RELOAD === "1";
const VITE_URL = process.env.DQL_EXPLORER_VITE_URL ?? "http://localhost:5173/";

/* Serve the built SPA from `/` when it exists; otherwise a build reminder.
   Registered last so the /api routes above take precedence. */
if (DEV) {
  app.get("/", (c) =>
    c.html(
      `<!doctype html><meta http-equiv="refresh" content="0; url=${VITE_URL}">` +
        `<p>Dev mode: the live UI is the Vite dev server. Redirecting to ` +
        `<a href="${VITE_URL}">${VITE_URL}</a> — open that, not :8000 ` +
        `(:8000 serves the last <code>pnpm build</code>, which is stale during dev).</p>`,
    ),
  );
} else if (existsSync(DIST_DIR)) {
  app.use("/*", serveStatic({ root: "web/dist" }));
} else {
  app.get("/", (c) =>
    c.html(
      "<h1>Diffbot DQL Explorer</h1>" +
        "<p>The frontend hasn't been built yet. From " +
        "<code>examples/dql-explorer</code> run:</p>" +
        "<pre>pnpm build</pre>" +
        "<p>then restart the server.</p>",
    ),
  );
}

const host = process.env.DQL_EXPLORER_HOST ?? "127.0.0.1";
const port = Number(process.env.DQL_EXPLORER_PORT ?? "8000");

if (DEV) {
  console.log(`DQL Explorer dev: API on http://${host}:${port}, open the UI at ${VITE_URL}`);
} else {
  console.log(`DQL Explorer running at http://${host}:${port}`);
}

serve({ fetch: app.fetch, hostname: host, port });
