import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { makeHandler } from '../queue/worker.js';
import { createQueue, type TaskQueue } from '../queue/queue.js';
import { createDefaultRegistry } from '../tools/index.js';
import { initTracing } from '../tracing/tracer.js';

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_API_PORT = 3000;

const BudgetSchema = z.object({
  maxUsd: z.number().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  maxSteps: z.number().int().nonnegative().optional(),
});

const CreateTaskSchema = z.object({
  input: z.string().min(1).max(4000),
  budget: BudgetSchema.optional(),
  model: z.string().min(1).optional(),
});

class BadRequestError extends Error {}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequestError('request body too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleCreateTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  queue: TaskQueue,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid body' });
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' });
    return;
  }

  const parsed = CreateTaskSchema.safeParse(json);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: 'validation failed',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  const id = randomUUID();
  await queue.enqueue({ id, ...parsed.data });
  sendJson(res, 202, { id });
}

/**
 * HTTP API over a TaskQueue (node:http, no framework).
 *   POST /tasks       body {input, budget?, model?} -> 202 {id}
 *   GET  /tasks/:id   -> 200 JobRecord | 404
 *   GET  /healthz     -> 200 {ok: true}
 */
export function createApiServer(queue: TaskQueue): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';

      if (method === 'POST' && url.pathname === '/tasks') {
        await handleCreateTask(req, res, queue);
        return;
      }

      if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const match = /^\/tasks\/([^/]+)$/.exec(url.pathname);
      if (method === 'GET' && match) {
        const id = decodeURIComponent(match[1]!);
        const record = await queue.get(id);
        if (!record) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, record);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
    }
  });
}

async function main(): Promise<void> {
  const port = Number(process.env.API_PORT ?? DEFAULT_API_PORT);
  const queue = createQueue();

  // Without Redis, the API and worker share one process and one in-memory queue.
  // With Redis, the worker runs as its own process (npm run worker) against the same Redis.
  const inProcessWorker = !process.env.REDIS_URL;
  const tracing = inProcessWorker ? initTracing() : undefined;
  if (inProcessWorker) {
    await queue.startWorker(
      makeHandler({ registry: createDefaultRegistry(), tracer: tracing?.tracer }),
    );
  }

  const server = createApiServer(queue);
  server.listen(port, () => {
    console.log(`[api] listening on http://localhost:${port}`);
    console.log(
      inProcessWorker
        ? '[api] in-process worker on in-memory queue'
        : '[api] using BullMQ queue; start a worker with npm run worker',
    );
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[api] ${signal} received, shutting down`);
    server.close();
    await queue.close();
    await tracing?.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((err: unknown) => {
    console.error('[api] fatal:', err);
    process.exit(1);
  });
}
