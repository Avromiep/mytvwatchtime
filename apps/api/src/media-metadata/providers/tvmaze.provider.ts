import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TvEpisode {
  season: number;
  number: number;
  airtime: string | null;
  airstamp: string | null;
}

const RATE_LIMITED = Symbol('tvmaze-rate-limited');

type FetchResult = any | null | typeof RATE_LIMITED;

@Injectable()
export class TvmazeProvider {
  private readonly logger = new Logger(TvmazeProvider.name);
  private readonly base = 'https://api.tvmaze.com';
  private readonly showCache = new Map<string, number | null>();
  private readonly maxRequestsPerWindow = 18;
  private readonly windowMs = 10_000;
  private readonly defaultBackoffMs = 5_000;
  private requestTimes: number[] = [];
  private rateLimitUntil = 0;
  private lastRateLimitWarnAt = 0;
  private throttleChain = Promise.resolve();
  readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('metadata.tvmazeEnabled') !== false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async waitForSlot(): Promise<void> {
    const run = this.throttleChain.then(async () => {
      const blockedFor = this.rateLimitUntil - Date.now();
      if (blockedFor > 0) await this.sleep(blockedFor);

      const now = Date.now();
      this.requestTimes = this.requestTimes.filter((t) => now - t < this.windowMs);
      if (this.requestTimes.length >= this.maxRequestsPerWindow) {
        const waitMs = this.windowMs - (now - this.requestTimes[0]) + 100;
        if (waitMs > 0) await this.sleep(waitMs);
        const after = Date.now();
        this.requestTimes = this.requestTimes.filter((t) => after - t < this.windowMs);
      }
      this.requestTimes.push(Date.now());
    });
    this.throttleChain = run.catch(() => undefined);
    await run;
  }

  private retryAfterMs(res: Response, attempt: number): number {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) return Math.min(Math.max(dateMs - Date.now(), 0), 60_000);
    }
    return Math.min(this.defaultBackoffMs * 2 ** attempt, 30_000);
  }

  private markRateLimited(url: string, delayMs: number) {
    this.rateLimitUntil = Math.max(this.rateLimitUntil, Date.now() + delayMs);
    if (Date.now() - this.lastRateLimitWarnAt > 10_000) {
      this.lastRateLimitWarnAt = Date.now();
      this.logger.warn(`TVmaze ${url} -> 429; backing off ${Math.ceil(delayMs / 1000)}s`);
    }
  }

  private async fetchJson(url: string): Promise<FetchResult> {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.waitForSlot();
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (res.status === 404) return null;
        if (res.status === 429) {
          const delayMs = this.retryAfterMs(res, attempt);
          this.markRateLimited(url, delayMs);
          await this.sleep(delayMs);
          continue;
        }
        if (!res.ok) {
          this.logger.warn(`TVmaze ${url} -> ${res.status}`);
          return null;
        }
        return res.json();
      }
      return RATE_LIMITED;
    } catch (e) {
      this.logger.debug(`TVmaze fetch failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async findShowId(tvdb?: string, imdb?: string): Promise<number | null> {
    const key = `${tvdb ?? ''}|${imdb ?? ''}`;
    if (this.showCache.has(key)) return this.showCache.get(key)!;
    let show: FetchResult = null;
    if (tvdb)
      show = await this.fetchJson(`${this.base}/lookup/shows?thetvdb=${encodeURIComponent(tvdb)}`);
    if (show === RATE_LIMITED) return null;
    if (!show && imdb)
      show = await this.fetchJson(`${this.base}/lookup/shows?imdb=${encodeURIComponent(imdb)}`);
    if (show === RATE_LIMITED) return null;
    const id = show?.id ?? null;
    this.showCache.set(key, id);
    return id;
  }

  /** Returns a map "seasonNumber-episodeNumber" -> { airtime, airstamp }. */
  async getEpisodeAirTimes(tvdb?: string, imdb?: string): Promise<Map<string, TvEpisode>> {
    const out = new Map<string, TvEpisode>();
    if (!this.enabled || (!tvdb && !imdb)) return out;
    const showId = await this.findShowId(tvdb, imdb);
    if (!showId) return out;
    const eps = await this.fetchJson(`${this.base}/shows/${showId}/episodes`);
    if (eps === RATE_LIMITED) return out;
    if (!Array.isArray(eps)) return out;
    for (const e of eps) {
      if (e && typeof e.season === 'number' && typeof e.number === 'number') {
        out.set(`${e.season}-${e.number}`, e);
      }
    }
    return out;
  }
}
