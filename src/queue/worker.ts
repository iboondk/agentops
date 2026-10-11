import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tracer } from '@opentelemetry/api';
import { AgentRuntime } from '../agent/runtime.js';
import type { RunResult } from '../core/types.js';
import { MockProvider } from '../llm/mockProvider.js';
import type { LLMProvider } from '../llm/provider.js';
import { createDefaultRegistry, type ToolRegistry } from '../tools/index.js';
import { initTracing } from '../tracing/tracer.js';
import { createQueue, type TaskJob } from './queue.js';

export interface WorkerDeps {
  registry: ToolRegistry;
  tracer?: Tracer;
  providerFactory?: (model: string) => LLMProvider;
}

const DEFAULT_MODEL = 'mock-small';

/** Builds a fresh AgentRuntime per job and runs the job input through it. */
export function makeHandler(deps: WorkerDeps): (job: TaskJob) => Promise<RunResult> {
  return async (job: TaskJob): Promise<RunResult> => {
    const model = job.model ?? DEFAULT_MODEL;
    const provider = deps.providerFactory
      ? deps.providerFactory(model)
      : new MockProvider({ model });
    const runtime = new AgentRuntime({
      provider,
      registry: deps.registry,
      budget: job.budget,
      tracer: deps.tracer,
    });
    return runtime.run({ id: job.id, input: job.input });
  };
}

async function main(): Promise<void> {
  const tracing = initTracing();
  const queue = createQueue();
  await queue.startWorker(makeHandler({ registry: createDefaultRegistry(), tracer: tracing.tracer }));

  // The in-memory queue has no handles that keep Node alive, so hold the process open here.
  const keepAlive = setInterval(() => {}, 60_000);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received, shutting down`);
    clearInterval(keepAlive);
    await queue.close();
    await tracing.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    process.env.REDIS_URL
      ? '[worker] consuming jobs from Redis'
      : '[worker] no REDIS_URL: in-memory queue, jobs only come from this process',
  );
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((err: unknown) => {
    console.error('[worker] fatal:', err);
    process.exit(1);
  });
}
