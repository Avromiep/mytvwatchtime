/**
 * Shared gate for every api.tvmaze.com request (the screen resolver AND the per-card
 * fallback both go through it), so TVmaze sees at most 2 concurrent and 15 starts per
 * rolling 10s. Distinguishes outcomes so callers cache correctly:
 *   - 'ok'        → use + cache the data
 *   - 'notFound'  → real HTTP 404; cache as "not found" (short TTL)
 *   - 'error'     → 429-after-retries, other non-OK, or a network error; NEVER cache
 * A 429 waits Retry-After (default 10s) and retries up to 3 times.
 */
import { createLimiter } from './limit';

const tvmazeLimiter = createLimiter(2, { rollingWindow: { maxStarts: 15, windowMs: 10_000 } });
const MAX_429_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 10_000;

export type TvmazeResult = { status: 'ok'; data: any } | { status: 'notFound' } | { status: 'error' };

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(header: string | null): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const secs = Number(header);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return DEFAULT_RETRY_AFTER_MS;
}

async function tvmazeGetRaw(url: string): Promise<TvmazeResult> {
  for (let attempt = 0; ; attempt += 1) {
    let r: Response;
    try {
      r = await fetch(url);
    } catch {
      return { status: 'error' };
    }
    if (r.status === 404) return { status: 'notFound' };
    if (r.status === 429) {
      if (attempt >= MAX_429_RETRIES) return { status: 'error' };
      await delay(parseRetryAfter(r.headers?.get?.('retry-after') ?? null));
      continue;
    }
    if (!r.ok) return { status: 'error' };
    try {
      return { status: 'ok', data: await r.json() };
    } catch {
      return { status: 'error' };
    }
  }
}

/** Rate-limited TVmaze GET. See module comment for the outcome contract. */
export function tvmazeGet(url: string): Promise<TvmazeResult> {
  return tvmazeLimiter.run(() => tvmazeGetRaw(url));
}
