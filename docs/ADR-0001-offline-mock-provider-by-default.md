# ADR-0001: Offline MockProvider is the default LLM provider

- Status: Accepted
- Date: 2026-10-11

## Context

The framework has to run and be tested without credentials, without network access and without
spending money. Real provider SDKs need API keys, rate limits and paid calls. CI and reviewers
also need the results to be repeatable.

## Decision

`MockProvider` is the default provider. It is deterministic and rule-based. It reads the last
user message and returns either a tool call (`calculate ...`, a URL, `search ...`) or a summary.
It reports token counts with a simple characters-per-4 estimate. `makeHandler` in
`src/queue/worker.ts` is where a real adapter would be wired in. It defaults to `new
MockProvider({model})` unless `WorkerDeps.providerFactory` is given. No real adapter is
included in this build, and no provider environment variable is read yet.

## Consequences

- `npm test` and `npm run eval` run with no key, no network and no cost.
- The eval numbers are reproducible, so they can be checked in CI.
- The mock does not show real model behaviour. Its prices in `src/config/pricing.ts` are labelled
  illustrative, and the cost report says so.
- Adding a real provider later means implementing `LLMProvider` and adding a pricing entry sourced
  from the provider's official pricing page.
