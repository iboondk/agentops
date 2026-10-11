import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { RunResult } from '../core/types.js';
import type { BudgetLimits } from '../core/budget.js';

export interface TaskJob {
  id: string;
  input: string;
  budget?: BudgetLimits;
  model?: string;
}

export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface JobRecord {
  id: string;
  state: JobState;
  result?: RunResult;
  error?: string;
  enqueuedAt: number;
  finishedAt?: number;
}

export interface TaskQueue {
  enqueue(job: TaskJob): Promise<string>;
  get(id: string): Promise<JobRecord | undefined>;
  startWorker(
    handler: (job: TaskJob) => Promise<RunResult>,
    opts?: { concurrency?: number },
  ): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE_NAME = 'agent-tasks';
const BULL_ATTEMPTS = 3;
const BULL_BACKOFF_MS = 1000;
const BULL_KEEP_COMPLETED = 1000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Process-local FIFO queue. Jobs are kept in memory, so they are lost on restart and are only
 * visible to the process that holds the queue. Used for offline runs and tests.
 */
export class InMemoryQueue implements TaskQueue {
  private readonly records = new Map<string, JobRecord>();
  private readonly pending: TaskJob[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private handler?: (job: TaskJob) => Promise<RunResult>;
  private concurrency = DEFAULT_CONCURRENCY;
  private running = 0;
  private closed = false;

  async enqueue(job: TaskJob): Promise<string> {
    if (this.closed) throw new Error('queue is closed');
    if (this.records.has(job.id)) throw new Error(`duplicate job id: ${job.id}`);
    this.records.set(job.id, { id: job.id, state: 'queued', enqueuedAt: Date.now() });
    this.pending.push(job);
    this.pump();
    return job.id;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const rec = this.records.get(id);
    return rec ? { ...rec } : undefined;
  }

  async startWorker(
    handler: (job: TaskJob) => Promise<RunResult>,
    opts?: { concurrency?: number },
  ): Promise<void> {
    if (this.handler) throw new Error('worker already started');
    this.handler = handler;
    this.concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;
    this.pump();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pending.length = 0;
    await Promise.allSettled([...this.inFlight]);
  }

  private pump(): void {
    if (!this.handler || this.closed) return;
    while (this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.running += 1;
      const p = this.run(job, this.handler).finally(() => {
        this.running -= 1;
        this.inFlight.delete(p);
        this.pump();
      });
      this.inFlight.add(p);
    }
  }

  private async run(job: TaskJob, handler: (job: TaskJob) => Promise<RunResult>): Promise<void> {
    const rec = this.records.get(job.id);
    if (!rec) return;
    rec.state = 'running';
    try {
      const result = await handler(job);
      rec.state = 'done';
      rec.result = result;
    } catch (err) {
      rec.state = 'failed';
      rec.error = errorMessage(err);
    }
    rec.finishedAt = Date.now();
  }
}

function mapBullState(state: string): JobState {
  switch (state) {
    case 'active':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      // waiting, delayed (includes retry backoff), prioritized, waiting-children, unknown
      return 'queued';
  }
}

/** Redis-backed queue on BullMQ. Requires a reachable Redis at `redisUrl`. */
export class BullTaskQueue implements TaskQueue {
  private readonly redisUrl: string;
  private readonly name: string;
  private readonly connection: Redis;
  private readonly queue: Queue<TaskJob, RunResult>;
  private worker?: Worker<TaskJob, RunResult>;
  private workerConnection?: Redis;

  constructor(redisUrl: string, name = DEFAULT_QUEUE_NAME) {
    this.redisUrl = redisUrl;
    this.name = name;
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<TaskJob, RunResult>(name, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: BULL_ATTEMPTS,
        backoff: { type: 'exponential', delay: BULL_BACKOFF_MS },
        removeOnComplete: { count: BULL_KEEP_COMPLETED },
      },
    });
  }

  async enqueue(job: TaskJob): Promise<string> {
    const added = await this.queue.add('task', job, { jobId: job.id });
    return added.id ?? job.id;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const job: Job<TaskJob, RunResult> | undefined = await this.queue.getJob(id);
    if (!job) return undefined;
    const state = mapBullState(await job.getState());
    return {
      id,
      state,
      result: job.returnvalue ?? undefined,
      error: state === 'failed' && job.failedReason ? job.failedReason : undefined,
      enqueuedAt: job.timestamp,
      finishedAt: job.finishedOn ?? undefined,
    };
  }

  async startWorker(
    handler: (job: TaskJob) => Promise<RunResult>,
    opts?: { concurrency?: number },
  ): Promise<void> {
    if (this.worker) throw new Error('worker already started');
    // BullMQ blocks its connection while waiting for jobs, so the worker gets its own client.
    this.workerConnection = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker<TaskJob, RunResult>(
      this.name,
      async (job) => handler(job.data),
      { connection: this.workerConnection, concurrency: opts?.concurrency ?? DEFAULT_CONCURRENCY },
    );
    this.worker.on('error', (err) => {
      console.error(`[queue] worker error: ${errorMessage(err)}`);
    });
    await this.worker.waitUntilReady();
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.workerConnection?.disconnect();
    this.connection.disconnect();
  }
}

/** BullTaskQueue when REDIS_URL is set, otherwise the in-memory queue. */
export function createQueue(): TaskQueue {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) return new BullTaskQueue(redisUrl);
  return new InMemoryQueue();
}
