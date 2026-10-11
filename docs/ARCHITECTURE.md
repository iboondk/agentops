# AgentOps architecture

## Problem

Agent demos are easy to build and hard to run. A script that calls a model and a few tools usually
has no retries, timeouts, cost limits, job queue or run record, and its tests depend on a paid,
nondeterministic API. AgentOps treats those concerns as core features and runs completely offline
by default.

## Components

```
            +-------------+   enqueue    +------------------+
 client --> | API (http)  | -----------> | Queue (BullMQ or |
            | POST /tasks |              | InMemoryQueue)   |
            +-------------+              +--------+---------+
                                                  | job
                                         +--------v---------+
                                         | Worker           |
                                         |  AgentRuntime    |---> LLMProvider (MockProvider)
                                         |   - Budget       |
                                         |   - retry/timeout|---> ToolRegistry --> calculator
                                         |   - Tracer       |                  --> http_fetch
                                         +--------+---------+                  --> fs_search
                                                  | spans                     ^
                                  +---------------v-----------+               |
                                  | OTel -> JsonlSpanExporter |      MCP server (stdio) exposes
                                  |      -> OTLP (optional)   |      the same ToolRegistry
                                  +---------------+-----------+
                                                  | data/traces/*.jsonl
                                         +--------v---------+
                                         | Trace UI server  |  GET /ui, /api/traces, /api/traces/:id
                                         +------------------+
```

The API and the worker only share the queue, so they can run as separate processes. The trace UI
reads the JSONL files that the worker writes. The MCP server exposes the same tool registry the
runtime uses.

| Concern | Choice | Why |
|---|---|---|
| Language and runtime | TypeScript (version pinned in package.json), Node 20 or newer, ESM | Native `fetch`, one toolchain for server, tests and scripts |
| Run and test | `tsx` for scripts, `vitest` for tests, `tsc --noEmit` for typecheck | Zero-config and fast |
| Validation | `zod` | Tool input schemas become JSON Schema for MCP and the LLM |
| MCP | `@modelcontextprotocol/sdk` (stdio transport, in-memory transport for tests) | Official SDK |
| Queue | `bullmq` and `ioredis`, with an `InMemoryQueue` that has the same interface | Production path plus offline tests |
| Tracing | `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`, a local `JsonlSpanExporter`, optional OTLP/HTTP exporter | Vendor-neutral |
| HTTP | `node:http` for the API and the trace UI | Fewer dependencies |
| UI | One static `index.html` with vanilla JS that renders a span waterfall | No build step |
| Containers | Docker Compose: `redis`, `api`, `worker`, `ui` | One-command stack |

## Core loop (`AgentRuntime.run`)

1. Start the root span `agent.run` with the task id, model and budget as attributes.
2. Loop up to `maxSteps`. Each `provider.complete(...)` call runs inside the span `llm.call`, wrapped
   in `withTimeout` and `withRetry`. Tokens and cost are recorded in the `Budget`. If the budget is
   exceeded, the run stops with status `budget_exceeded`.
3. If the response contains tool calls, each one runs in a span `tool.<name>`. Arguments are validated
   with zod, the tool runs with a per-tool timeout, and only errors marked retryable are retried. The
   result is appended to the conversation as a tool message.
4. If the response is a final answer, the run returns status `ok`.
5. Reaching the step limit returns `max_steps`. An uncaught error returns `error`. Spans are always ended.

Tool failures go back to the model as messages, so one bad call does not end the run.

## Tools

- `calculator`: arithmetic with decimals, `+ - * / % ^`, parentheses and unary minus. It uses its own
  tokenizer and a shunting-yard parser. It does not use `eval`.
- `http_fetch`: HTTP GET for http and https URLs. It has an 8 s timeout, a 100,000-character body cap and an
  optional host allowlist (`HTTP_FETCH_ALLOWLIST`).
- `fs_search`: case-insensitive substring search across `.md`, `.txt`, `.json` and `.ts` files under
  `TOOLS_SANDBOX_DIR`. Path traversal is rejected, and entries whose realpath leaves the sandbox are
  skipped.

## Key decisions

- **Offline mock provider by default** ([ADR-0001](ADR-0001-offline-mock-provider-by-default.md)).
  Tests and evals are deterministic and free. The trade-off is that the mock does not show real model behaviour.
- **Queue adapter with an in-memory twin** ([ADR-0002](ADR-0002-queue-adapter-bullmq-and-in-memory.md)).
- **OpenTelemetry with a local JSONL exporter** ([ADR-0003](ADR-0003-opentelemetry-with-jsonl-and-optional-otlp.md)).
- **Zod schemas shared by the agent and MCP** ([ADR-0004](ADR-0004-tools-as-zod-schemas-exposed-over-mcp.md)).
- **`node:http` and a static UI** ([ADR-0005](ADR-0005-node-http-and-static-ui-no-framework.md)).

Costs are computed from recorded token counts and a pricing table in `src/config/pricing.ts`. The
mock-model prices are labelled illustrative in every generated report.

## Results

Measured locally with Node 24:

- `npm test`: 57 tests passed, 1 skipped (the Redis test, which needs `REDIS_URL`).
- `npm run typecheck`: passes.
- `npm run eval`: 10 regression cases. The report in `reports/cost-per-task.md` lists the per-case
  cost using the illustrative prices.

CI passes on Node 22 and 24. It runs the BullMQ test against a Redis service container, runs
`docker compose config` and builds the Compose image.

Not measured yet: `docker compose up` end to end (Docker was not installed in the development
environment), real provider latency and cost, and load. No benchmark numbers are claimed.

## Possible next steps

1. Add a real provider adapter, priced from the provider's published pricing page.
2. Add a compose smoke test that submits a task and polls until it is `done`.
3. Add API authentication, rate limits and durable job results.
4. Put an allowlist policy in front of the MCP server.
