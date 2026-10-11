# ADR-0005: node:http for the API and trace UI, with a static UI page and no framework

- Status: Accepted
- Date: 2026-10-11

## Context

The project has two small HTTP surfaces: a task API with three routes, and a read-only trace
viewer. A web framework and a frontend build step would add dependencies and setup for little benefit.

## Decision

- Both servers use `node:http` directly. Routing is a few explicit path checks.
- The request body is capped at 64 KB and validated with zod. Errors are JSON.
- The trace UI is one static `index.html` with vanilla JavaScript that draws a span waterfall. It has
  no build step.

## Consequences

- Few dependencies and no build step. The stack is easy to follow when reading the code.
- No middleware. Each route checks its own method and input.
- The UI server is read-only and only reads trace files from `TRACE_DIR`. It listens on `127.0.0.1`
  by default. `UI_HOST` overrides this, and Docker Compose sets `UI_HOST=0.0.0.0` so the published
  port 4318 is reachable from the host.
