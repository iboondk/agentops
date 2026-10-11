import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../src/api/server.js';
import { BullTaskQueue, InMemoryQueue, type JobRecord, type TaskQueue } from '../src/queue/queue.js';
import { makeHandler } from '../src/queue/worker.js';
import type { RunResult } from '../src/core/types.js';
import { createDefaultRegistry } from '../src/tools/index.js';

const REDIS_URL = process.env.REDIS_URL;

function fakeResult(taskId: string, output = 'done'): RunResult {
  return {
    taskId,
    status: 'ok',
    output,
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0,
    toolCalls: [],
    durationMs: 1,
  };
}

async function waitForTerminal(
  get: (id: string) => Promise<JobRecord | undefined>,
  id: string,
  timeoutMs = 2000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = await get(id);
    if (rec && (rec.state === 'done' || rec.state === 'failed')) return rec;
    if (Date.now() > deadline) throw new Error(`job ${id} not finished in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function startApi(queue: TaskQueue): Promise<{ server: http.Server; base: string }> {
  const server = createApiServer(queue);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function stopApi(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const openServers: http.Server[] = [];
const openQueues: TaskQueue[] = [];

afterEach(async () => {
  while (openServers.length) await stopApi(openServers.pop()!);
  while (openQueues.length) await openQueues.pop()!.close();
});

describe('InMemoryQueue', () => {
  it('processes 3 jobs FIFO and reports done with status ok', async () => {
    const queue = new InMemoryQueue();
    openQueues.push(queue);
    await queue.startWorker(async (job) => fakeResult(job.id, job.input));

    const ids = await Promise.all(
      [1, 2, 3].map((n) => queue.enqueue({ id: randomUUID(), input: `task ${n}` })),
    );
    expect(ids).toHaveLength(3);

    for (const id of ids) {
      const rec = await waitForTerminal((x) => queue.get(x), id);
      expect(rec.state).toBe('done');
      expect(rec.result?.status).toBe('ok');
      expect(rec.result?.taskId).toBe(id);
      expect(rec.finishedAt).toBeGreaterThanOrEqual(rec.enqueuedAt);
    }
  });

  it('reports queued before a worker is started, then done after', async () => {
    const queue = new InMemoryQueue();
    openQueues.push(queue);
    const id = await queue.enqueue({ id: randomUUID(), input: 'later' });
    expect((await queue.get(id))?.state).toBe('queued');

    await queue.startWorker(async (job) => fakeResult(job.id));
    const rec = await waitForTerminal((x) => queue.get(x), id);
    expect(rec.state).toBe('done');
  });

  it('marks a job failed when the handler throws', async () => {
    const queue = new InMemoryQueue();
    openQueues.push(queue);
    await queue.startWorker(async () => {
      throw new Error('boom');
    });

    const id = await queue.enqueue({ id: randomUUID(), input: 'explode' });
    const rec = await waitForTerminal((x) => queue.get(x), id);
    expect(rec.state).toBe('failed');
    expect(rec.error).toBe('boom');
    expect(rec.result).toBeUndefined();
  });

  it('returns undefined for an unknown id', async () => {
    const queue = new InMemoryQueue();
    openQueues.push(queue);
    expect(await queue.get(randomUUID())).toBeUndefined();
  });
});

describe('HTTP API (in-memory queue)', () => {
  it('POST /tasks returns 202, then the job completes with output containing the answer', async () => {
    const queue = new InMemoryQueue();
    openQueues.push(queue);
    await queue.startWorker(makeHandler({ registry: createDefaultRegistry() }));
    const { server, base } = await startApi(queue);
    openServers.push(server);

    const created = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'calculate 2+2' }),
    });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const deadline = Date.now() + 2000;
    let body: JobRecord | undefined;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${id}`);
      expect(res.status).toBe(200);
      body = (await res.json()) as JobRecord;
      if (body.state === 'done' || body.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(body?.state).toBe('done');
    expect(body?.result?.status).toBe('ok');
    expect(body?.result?.output).toContain('4');
  });

  it('POST /tasks with an empty object returns 400', async () => {
    const queue = new InMemoryQueue();
    openQueues.push(queue);
    const { server, base } = await startApi(queue);
    openServers.push(server);

    const res = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /tasks with invalid JSON returns 400', async () => {
    const queue = new InMemoryQueue();
    openQueues.push(queue);
    const { server, base } = await startApi(queue);
    openServers.push(server);

    const res = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('GET /tasks/:id for an unknown id returns 404', async () => {
    const queue = new InMemoryQueue();
    openQueues.push(queue);
    const { server, base } = await startApi(queue);
    openServers.push(server);

    const res = await fetch(`${base}/tasks/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('GET /healthz returns ok', async () => {
    const queue = new InMemoryQueue();
    openQueues.push(queue);
    const { server, base } = await startApi(queue);
    openServers.push(server);

    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe.skipIf(!REDIS_URL)('BullTaskQueue (requires REDIS_URL)', () => {
  it('runs the happy path through BullMQ and the HTTP API', async () => {
    const queue = new BullTaskQueue(REDIS_URL!, `agent-tasks-test-${randomUUID()}`);
    openQueues.push(queue);
    await queue.startWorker(makeHandler({ registry: createDefaultRegistry() }));
    const { server, base } = await startApi(queue);
    openServers.push(server);

    const created = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'calculate 2+2' }),
    });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };

    const rec = await waitForTerminal((x) => queue.get(x), id, 10_000);
    expect(rec.state).toBe('done');
    expect(rec.result?.status).toBe('ok');
    expect(rec.result?.output).toContain('4');
  }, 15_000);
});
