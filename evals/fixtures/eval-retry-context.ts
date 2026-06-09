export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  backoffFactor: number;
  /** If provided, only retry when the error satisfies this predicate. */
  shouldRetry?: (err: unknown) => boolean;
}

export type AsyncFn<T> = () => Promise<T>;
