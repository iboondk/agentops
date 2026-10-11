# ADR-0003: OpenTelemetry tracing with a JSONL exporter and optional OTLP export

- Status: Accepted
- Date: 2026-10-11

## Context

Agent runs need to be inspectable: each LLM call, tool call and retry, with token counts and cost.
The tracing should not depend on one vendor, and it should work offline with no collector.

## Decision

- Spans come from `@opentelemetry/api`. The runtime creates `agent.run`, `llm.call` and `tool.<name>`
  spans, and records token usage and cost as attributes.
- `JsonlSpanExporter` always writes one `<traceId>.jsonl` file per trace under `TRACE_DIR`. The local
  trace UI reads these files.
- When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, an OTLP/HTTP exporter is added through a batch processor.
  If `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are also set, a Basic auth header is added.
  The header is never logged.
- The trace UI is a static page served by `node:http`, with a read-only JSON API.

## Consequences

- Tracing works with no collector. The UI can show a run offline.
- The trace format is the project's own JSONL shape, not OTLP. Only the optional export path
  is vendor-neutral OTLP.
- Trace files are written under `data/`, which is git-ignored.
