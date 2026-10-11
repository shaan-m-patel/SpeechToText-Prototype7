export const GROQ_MAX_RETRY_DELAY_MS = 2000;

export class GroqHttpError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { status?: number; retryable: boolean; retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'GroqHttpError';
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { name?: string }).name === 'AbortError';
}

export function abortError(): Error {
  const error = new Error('Transcription aborted');
  error.name = 'AbortError';
  return error;
}

/** 429 and 5xx can be retried. Other 4xx responses are caller errors and must not be retried. */
export function retryableForStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return status >= 500;
}

export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

/**
 * `attempt` is the zero-based index of the try that just failed.
 * Retries are allowed only while `attempt < maxRetries`, so a finally block
 * cannot clear the count and start the sequence over.
 */
export function decideRetry(error: unknown, attempt: number, maxRetries: number): RetryDecision {
  const stop: RetryDecision = { retry: false, delayMs: 0 };
  if (isAbortError(error) || attempt >= maxRetries) return stop;

  if (error instanceof GroqHttpError) {
    if (!error.retryable) return stop;
    return {
      retry: true,
      delayMs: retryDelayMs(attempt, error.retryAfterMs),
    };
  }

  if (error instanceof TypeError) {
    return { retry: true, delayMs: retryDelayMs(attempt) };
  }

  return stop;
}

export function retryDelayMs(attempt: number, retryAfterMs?: number, capMs = GROQ_MAX_RETRY_DELAY_MS): number {
  const backoff = 500 * (attempt + 1);
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs)) {
    return Math.min(backoff, capMs);
  }
  return Math.min(Math.max(0, retryAfterMs), capMs);
}

export function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    function finish() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
