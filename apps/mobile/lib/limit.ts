/**
 * Tiny promise concurrency limiter + in-flight deduper. Used to keep the Upcoming
 * tabs polite: at most N backend / TVmaze requests run at once, optionally spaced
 * by a minimum interval (a simple rate cap), and identical in-flight requests share
 * a single promise instead of refetching.
 *
 * No external dependencies (OTA-safe, no native code).
 */

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * At most `maxConcurrent` tasks run at once. With `minIntervalMs`, task *starts* are
 * also spaced at least that far apart, which bounds the request rate (e.g. 334ms ≈
 * 3/sec). FIFO: tasks start in the order they were submitted. A task that throws
 * frees its slot like any other, so one failure never stalls the queue.
 */
export function createLimiter(
  maxConcurrent: number,
  opts: { minIntervalMs?: number } = {},
): Limiter {
  const max = Math.max(1, Math.floor(maxConcurrent) || 1);
  const minInterval = Math.max(0, opts.minIntervalMs ?? 0);
  const queue: Array<() => void> = [];
  let active = 0;
  let nextAllowedAt = 0;

  const pump = (): void => {
    if (active >= max || queue.length === 0) return;
    const now = Date.now();
    const wait = Math.max(0, nextAllowedAt - now);
    const launch = queue.shift() as () => void;
    active += 1;
    nextAllowedAt = Math.max(now, nextAllowedAt) + minInterval;
    if (wait > 0) setTimeout(launch, wait);
    else launch();
  };

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              pump();
            });
        });
        pump();
      });
    },
  };
}

/**
 * Collapse identical in-flight async calls: while a call for `key` is pending, other
 * calls with the same key return the same promise. The entry clears once it settles,
 * so later calls run fresh.
 */
export function createDeduper<T>(): (key: string, fn: () => Promise<T>) => Promise<T> {
  const inflight = new Map<string, Promise<T>>();
  return (key, fn) => {
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = Promise.resolve()
      .then(fn)
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, p);
    return p;
  };
}
