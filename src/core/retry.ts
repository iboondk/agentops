import { RetryableError, TimeoutError } from './errors.js';

export interface RetryOptions {
  /** Number of retries after the first attempt. Total attempts = retries + 1. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number) => void;
}

function defaultShouldRetry(err: unknown): boolean {
  return err instanceof RetryableError || err instanceof TimeoutError;
}

/**
 * Retries `fn` with deterministic exponential backoff:
 * delay before retry n (n >= 1) = min(baseDelayMs * 2^(n-1), maxDelayMs). No jitter.
 * `attempt` is 1-based. The last error is rethrown when retries are exhausted.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const maxAttempts = opts.retries + 1;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }
      opts.onRetry?.(err, attempt);
      const exp = opts.baseDelayMs * 2 ** (attempt - 1);
      const delay = opts.maxDelayMs === undefined ? exp : Math.min(exp, opts.maxDelayMs);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
