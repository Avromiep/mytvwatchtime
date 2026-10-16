/**
 * Tiny promise concurrency limiter + in-flight deduper. Keeps the Upcoming tabs polite:
 * at most N requests run at once, optionally spaced by a minimum interval and/or capped
 * to a maximum number of starts per rolling time window, and identical in-flight
 * requests share one promise.
 *
 * No external dependencies (OTA-safe, no native code).
 */

export interface RollingWindow {
  /** Max task starts allowed within any `windowMs` span. */
  maxStarts: number;
  windowMs: number;
}

export interface LimiterOptions {
  /** Minimum gap between task starts (a simple rate cap). */
  minIntervalMs?: number;
  /** Cap on starts per rolling time window (e.g. 15 per 10s). */
  rollingWindow?: RollingWindow;
}

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * At most `maxConcurrent` tasks run at once. FIFO: tasks start in submission order. A
 * task that throws frees its slot like any other, so one failure never stalls the
 * queue. `minIntervalMs` spaces starts; `rollingWindow` bounds starts per window.
 */
export function createLimiter(maxConcurrent: number, opts: LimiterOptions = {}): Limiter {
  const max = Math.max(1, Math.floor(maxConcurrent) || 1);
  const minInterval = Math.max(0, opts.minIntervalMs ?? 0);
  const rolling = opts.rollingWindow;
  const queue: Array<() => void> = [];
  const starts: number[] = []; // recent start timestamps, for the rolling window
  let active = 0;
  let nextAllowedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pump = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (active >= max || queue.length === 0) return;
    const now = Date.now();
    let wait = Math.max(0, nextAllowedAt - now);
    if (rolling) {
      const cutoff = now - rolling.windowMs;
      while (starts.length && starts[0] <= cutoff) starts.shift();
      if (starts.length >= rolling.maxStarts) {
        wait = Math.max(wait, starts[0] + rolling.windowMs - now);
      }
    }
    if (wait > 0) {
      timer = setTimeout(pump, wait);
      (timer as { unref?: () => void })?.unref?.();
      return;
    }
    const launch = queue.shift() as () => void;
    active += 1;
    nextAllowedAt = Math.max(now, nextAllowedAt) + minInterval;
    if (rolling) starts.push(now);
    launch();
    // More may be startable this tick (concurrency slots free).
    pump();
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
 * calls with the same key return the same promise. The entry clears once it settles.
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
