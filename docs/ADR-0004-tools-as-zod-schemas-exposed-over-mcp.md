# ADR-0004: Tools defined with zod and exposed through one registry and an MCP server

- Status: Accepted
- Date: 2026-10-11

## Context

Tools must validate their inputs, have a JSON Schema that LLMs and MCP clients can read, and be
callable from the agent runtime and from external MCP clients without duplicated definitions.

## Decision

- Each tool is a `defineTool({name, description, schema, timeoutMs, retries, run})` with a zod schema.
- `ToolRegistry.specs()` turns the zod schema into JSON Schema with `zod-to-json-schema`.
  `ToolRegistry.execute()` validates arguments, applies a per-attempt timeout and retries only
  `RetryableError`.
- `buildMcpServer(registry)` maps the same registry to MCP `tools/list` and `tools/call`. Stdio is the
  transport for `npm run mcp`. Tests use the in-memory transport.
- Tool failures go back to the model as `ERROR: <message>` messages and do not crash the run.
- The three tools are `calculator` (own parser, no `eval`), `http_fetch` (http/https only, body
  cap, optional host allowlist) and `fs_search` (confined to the sandbox by realpath checks).

## Consequences

- One definition serves the agent, the MCP server and the tests.
- Each new tool needs a schema, a timeout and a test.
- The MCP server exposes the sandbox search and HTTP fetch to any MCP client that runs it, so the
  sandbox and allowlist settings matter.
