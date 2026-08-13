/* CLI entry point. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "langchain";
import { buildAgent } from "./agent.js";

/*
  Tool results arrive as a string for some tools and as structured content for
  others. `String()` on the latter renders "[object Object],[object Object]",
  which tells the reader nothing — JSON-encode anything non-string instead.
*/
function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

const TRACE_WIDTH = 200;

function formatEvent(message: BaseMessage): string | undefined {
  if (message instanceof ToolMessage) {
    const rendered = renderContent(message.content);
    const shown =
      rendered.length > TRACE_WIDTH ? `${rendered.slice(0, TRACE_WIDTH)}...` : rendered;
    return `  ↳ tool ${message.name}: ${shown}`;
  }
  if (message instanceof AIMessage) {
    if (message.tool_calls && message.tool_calls.length > 0) {
      const calls = message.tool_calls
        .map((call) => `${call.name}(${JSON.stringify(call.args)})`)
        .join(", ");
      return `  ▸ calling: ${calls}`;
    }
    if (typeof message.content === "string" && message.content.trim()) {
      return `\n${message.content}`;
    }
  }
  return undefined;
}

/* Run a single research question through the agent. */
async function main(): Promise<number> {
  /*
    `../.env` relative to this file (compiled or run in place with tsx) is
    `examples/.env` — the same file every example in the repo loads its
    tokens from. Resolved from `import.meta.url` rather than `process.cwd()`
    so `pnpm start` works from any directory.
  */
  const here = dirname(fileURLToPath(import.meta.url));
  loadDotenv({ path: join(here, "..", "..", ".env"), quiet: true });

  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet");
  const question = args.filter((arg) => arg !== "--quiet").join(" ");

  if (!question) {
    console.error("Usage: pnpm start [--quiet] <question>");
    console.error('Example: pnpm start "What companies in Austin work on robotics?"');
    return 1;
  }

  const agent = buildAgent();
  const result = await agent.invoke({ messages: [new HumanMessage(question)] });
  const messages = result.messages;

  if (quiet) {
    const final = messages[messages.length - 1];
    if (final instanceof AIMessage && typeof final.content === "string") {
      console.log(final.content);
    }
    return 0;
  }

  for (const message of messages.slice(1)) {
    // skip the human prompt
    const rendered = formatEvent(message);
    if (rendered) {
      console.log(rendered);
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
