# `@diffbot/langchain` examples

Two ways to see the package in action: a browser app and a CLI. Each talks to
the live Diffbot APIs, and both use an Anthropic model to drive their agent, so
you need a `DIFFBOT_API_TOKEN` and an `ANTHROPIC_API_KEY`. Copy
[`.env.example`](./.env.example) to `.env` and fill it in.

Every example has its own README covering setup and how to run it.

Each example resolves `@diffbot/langchain` through `link:../..`, which points at
the package's build output — so **run `pnpm build` in the repo root once before
installing an example.**

## Web app

[`dql-explorer/`](./dql-explorer) is a browser UI over the Knowledge Graph with
three tabs:

- **DQL Builder** — type a question in plain English; an agent inspects the
  ontology, probes query variants for selectivity, and commits to a DQL query.
  The agent only _authors_ the query — the server runs it — so the rows in the
  table are always real Knowledge Graph data, never model output.
- **M&A / IPO Dashboard** — a deterministic roll-up of two fixed DQL templates
  into charts by industry, month, country, and exchange. No model involved.
- **Ask Diffbot** — `ChatDiffbot` streaming a RAG answer token by token.

A Hono backend serving a React + TypeScript frontend on a single port.

## CLI

[`company-research/`](./company-research) is a multi-tool agent packaged as a
one-shot command-line tool: ask a company-research question in plain English and
the agent searches the Knowledge Graph and the live web, then cites the entity
IDs and URLs it used. Useful for shell scripting or quick spot checks.

## What happened to the notebook?

The Python package ships a `quickstart/` Jupyter notebook as its guided tour.
There is no equivalent here — notebooks are not idiomatic in the TypeScript
ecosystem, and the material it covers (retrievers, output shaping, the tools,
`ChatDiffbot` streaming, bring-your-own client) is covered by runnable snippets
in the [root README](../README.md), every one of which is executed by the test
suite on each run.
