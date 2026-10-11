# ADR-0002: Job queue behind a TaskQueue interface, with BullMQ and an in-memory adapter

- Status: Accepted
- Date: 2026-10-11

## Context

Long agent runs should not block the HTTP request, and the API and workers should be able to
scale separately. The production path needs a durable queue with retries. Tests and local runs
should not need Redis.

## Decision

- `TaskQueue` is a small interface: `enqueue`, `get`, `startWorker`, `close`.
- `BullTaskQueue` (BullMQ on Redis, `attempts: 3`, exponential backoff) is used when `REDIS_URL`
  is set.
- `InMemoryQueue` is used otherwise. It is a process-local FIFO with the same interface. The API
  then runs an in-process worker.
- `createQueue()` makes the choice from the environment.

## Consequences

- Tests and `npm run api` work without Redis. The BullMQ suite is skipped unless `REDIS_URL` is set.
- In-memory jobs are lost on restart and cannot be seen from other processes. The README states this.
- The Redis path is covered in CI by a Redis service container. It has not been run locally,
  because `redis-server` is not installed.
