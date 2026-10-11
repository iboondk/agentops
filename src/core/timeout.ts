import { TimeoutError } from './errors.js';

/**
 * Runs `fn` with an AbortSignal that fires after `ms` milliseconds.
 * Rejects with TimeoutError (and aborts the signal) if the timer wins.
 * The timer is cleared as soon as `fn` settles.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new TimeoutError(`${label} timed out after ${ms}ms`, ms);
      controller.abort(err);
      reject(err);
    }, ms);
  });

  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
