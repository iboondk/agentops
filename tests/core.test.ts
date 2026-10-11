import { describe, expect, it } from 'vitest';
import { withTimeout } from '../src/core/timeout.js';
import { withRetry } from '../src/core/retry.js';
import { AgentError, RetryableError, TimeoutError } from '../src/core/errors.js';
import { costOf } from '../src/config/pricing.js';
import { Budget } from '../src/core/budget.js';

describe('withTimeout', () => {
  it('resolves when fn finishes before the deadline', async () => {
    const result = await withTimeout(async () => 42, 50, 'fast');
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError and aborts the signal when fn is too slow', async () => {
    let aborted = false;
    const slow = (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        setTimeout(() => resolve('late'), 40);
      });

    await expect(withTimeout(slow, 5, 'slow')).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });
});

describe('withRetry', () => {
  it('succeeds on the 3rd attempt when retries=2', async () => {
    const attempts: number[] = [];
    const result = await withRetry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 3) throw new RetryableError(`fail ${attempt}`);
        return 'ok';
      },
      { retries: 2, baseDelayMs: 1, maxDelayMs: 5 },
    );
    expect(result).toBe('ok');
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('gives up after retries and rethrows the last error', async () => {
    let calls = 0;
    const err = await withRetry(
      async () => {
        calls += 1;
        throw new RetryableError(`boom ${calls}`);
      },
      { retries: 2, baseDelayMs: 1 },
    ).catch((e: unknown) => e);
    expect(calls).toBe(3);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as Error).message).toBe('boom 3');
  });

  it('does not retry a non-retryable Error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('permanent');
        },
        { retries: 5, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('permanent');
    expect(calls).toBe(1);
  });

  it('honours a custom shouldRetry and calls onRetry', async () => {
    const retried: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('x');
        },
        {
          retries: 2,
          baseDelayMs: 1,
          shouldRetry: () => true,
          onRetry: (_err, attempt) => retried.push(attempt),
        },
      ),
    ).rejects.toThrow('x');
    expect(calls).toBe(3);
    expect(retried).toEqual([1, 2]);
  });
});

describe('errors', () => {
  it('sets the error name and extends AgentError', () => {
    const e = new TimeoutError('t', 10);
    expect(e).toBeInstanceOf(AgentError);
    expect(e.name).toBe('TimeoutError');
    expect(e.ms).toBe(10);
  });
});

describe('costOf', () => {
  it('computes mock-small cost: 1M in at $1/MTok + 1M out at $5/MTok = 6', () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'mock-small')).toBe(6);
  });

  it('throws AgentError for an unknown model', () => {
    expect(() => costOf({ inputTokens: 1, outputTokens: 1 }, 'no-such-model')).toThrow(AgentError);
  });
});

describe('Budget', () => {
  it("exceeded() returns 'usd' after crossing maxUsd", () => {
    const budget = new Budget({ maxUsd: 1 }, 'mock-small');
    budget.record({ inputTokens: 0, outputTokens: 100_000 }); // 0.5 USD
    expect(budget.exceeded()).toBeNull();
    budget.record({ inputTokens: 0, outputTokens: 200_000 }); // +1.0 USD -> 1.5
    expect(budget.exceeded()).toBe('usd');
    expect(() => budget.assertWithin()).toThrow(/usd/);
  });

  it("exceeded() returns 'steps' after crossing maxSteps", () => {
    const budget = new Budget({ maxSteps: 2 }, 'mock-small');
    budget.step();
    budget.step();
    expect(budget.exceeded()).toBeNull();
    budget.step();
    expect(budget.exceeded()).toBe('steps');
    expect(budget.steps).toBe(3);
  });

  it('accumulates usage and cost', () => {
    const budget = new Budget({}, 'mock-large');
    budget.record({ inputTokens: 10, outputTokens: 20 });
    budget.record({ inputTokens: 5, outputTokens: 5 });
    expect(budget.usage).toEqual({ inputTokens: 15, outputTokens: 25 });
    expect(budget.costUsd).toBeCloseTo(costOf({ inputTokens: 15, outputTokens: 25 }, 'mock-large'));
  });
});
