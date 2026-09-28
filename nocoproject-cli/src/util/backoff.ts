export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Exponential backoff with "equal jitter": half fixed, half random. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export interface RetryOptions {
  readonly attempts: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly signal?: AbortSignal;
  readonly shouldRetry: (error: unknown) => boolean;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt >= opts.attempts || !opts.shouldRetry(error) || opts.signal?.aborted) throw error;
      const delay = backoffDelay(attempt - 1, opts.baseMs, opts.maxMs);
      opts.onRetry?.(error, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
}
