// ============================================================================
// STREAM UTILITIES
// ============================================================================
// Shared helpers for merging Node.js Readable streams into an async line
// iterator. Used by command.ts, claude.ts, and plan.ts.

import { spawn } from "node:child_process";
import { TimeoutError } from "../types.js";

// ----------------------------------------------------------------------------
// Async queue — race-condition-free stream merger
// ----------------------------------------------------------------------------

type QueueItem<T> = { value: T } | { done: true } | { error: Error };

/**
 * A minimal async queue where push() directly resolves a waiting consumer
 * or buffers the item if nobody is waiting yet.
 *
 * This avoids the classic race where:
 *   - consumer exits inner drain loop (queue is empty)
 *   - producer pushes an item (resolve is still null)
 *   - consumer sets resolve = r and waits forever
 *
 * Here, push() always delivers to a waiter if one exists, so there is no
 * window where an item can be lost.
 */
class AsyncQueue<T> {
  private buf: QueueItem<T>[] = [];
  private waiter: ((item: QueueItem<T>) => void) | null = null;

  push(item: QueueItem<T>): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
    } else {
      this.buf.push(item);
    }
  }

  next(): Promise<QueueItem<T>> {
    if (this.buf.length > 0) return Promise.resolve(this.buf.shift()!);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = await this.next();
      if ("done" in item) return;
      if ("error" in item) throw item.error;
      yield item.value;
    }
  }
}

/**
 * Merges Node.js Readable streams, yielding lines from both interleaved as
 * data arrives. Uses AsyncQueue to avoid the resolve-overwrite race condition.
 */
export async function* mergeStreamsToLines(
  ...streams: NodeJS.ReadableStream[]
): AsyncGenerator<string> {
  const q = new AsyncQueue<string>();
  let pending = streams.length;

  for (const stream of streams) {
    let buf = "";

    stream.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString();
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const part of parts) q.push({ value: part });
    });

    stream.on("end", () => {
      if (buf) {
        q.push({ value: buf });
        buf = "";
      }
      pending--;
      if (pending === 0) q.push({ done: true });
    });

    stream.on("error", (err) => q.push({ error: err }));
  }

  yield* q;
}

/** Resolves with the process exit code once it terminates. */
export function waitForExit(proc: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.on("close", (code) => resolve(code ?? 0));
    proc.on("error", reject);
  });
}

/**
 * Arms a kill-on-timeout guard for a child process.
 * Call check() after waitForExit() to throw TimeoutError if the timer fired.
 * Call cancel() in a finally block to disarm the timer on normal completion.
 * `onTimeout`, when given, replaces the default `proc.kill()` — e.g. to kill
 * a whole process group instead of just the immediate child (see command.ts).
 */
export function startTimeout(
  proc: ReturnType<typeof spawn>,
  taskName: string,
  timeoutSeconds: number | undefined,
  onTimeout?: () => void,
): { check: () => void; cancel: () => void } {
  if (timeoutSeconds == null) return { check: () => {}, cancel: () => {} };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (onTimeout) {
      onTimeout();
      return;
    }
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  }, timeoutSeconds * 1000);
  return {
    check: () => {
      if (timedOut) throw new TimeoutError(taskName, timeoutSeconds);
    },
    cancel: () => clearTimeout(timer),
  };
}
