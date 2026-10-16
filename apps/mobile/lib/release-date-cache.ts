/**
 * On-device cache of movie release dates for the Upcoming Movies tab. One small JSON
 * blob in AsyncStorage keyed by movie id, so reopening the tab is instant and we only
 * re-fetch /movies/{id} when an entry is missing or past its TTL.
 *
 * Rules: corrupt JSON is treated as empty (never throws); writes are batched (not one
 * per movie); dated entries live 24h, dateless ("TBA") entries 12h; cleared on logout
 * via clearReleaseDateCache() alongside the query cache.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const RELEASE_DATE_CACHE_KEY = 'upcomingMovieDates:v1';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FAR_TTL_MS = 7 * DAY_MS; // dated, release > 30 days away
const NEAR_TTL_MS = DAY_MS; // dated, release within 30 days
const TBA_TTL_MS = 3 * DAY_MS; // no date yet
const FAR_THRESHOLD_MS = 30 * DAY_MS;
const FLUSH_DELAY_MS = 1500;

export interface ReleaseEntry {
  releaseDate: string | null;
  releaseYear: number | null;
  title: string;
  poster: string | null;
  savedAt: number;
  /** Per-entry fraction 0–0.2 added to the base TTL so entries don't all expire at once. */
  ttlJitter?: number;
}

/** A fresh jitter fraction (0–0.2) to stamp on a new cache entry. */
export function releaseTtlJitter(): number {
  return Math.random() * 0.2;
}

type Store = Record<string, ReleaseEntry>;

let mem: Store | null = null;
let loadPromise: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

/** Load the blob into memory exactly once. Safe to call repeatedly. */
export function loadReleaseDateCache(): Promise<void> {
  if (mem) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(RELEASE_DATE_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      mem = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {};
    } catch {
      mem = {}; // corrupt / unreadable — start empty, never throw
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export function getReleaseEntry(id: string): ReleaseEntry | undefined {
  return mem?.[id];
}

/** Base TTL before jitter: dateless → 3d; dated and >30 days away → 7d; dated and
 *  within 30 days → 24h. Stale-while-revalidate keeps stale entries visible meanwhile. */
function baseTtlMs(entry: ReleaseEntry, now: number): number {
  if (!entry.releaseDate) return TBA_TTL_MS;
  const releaseMs = Date.parse(entry.releaseDate);
  if (Number.isNaN(releaseMs)) return NEAR_TTL_MS;
  return releaseMs - now > FAR_THRESHOLD_MS ? FAR_TTL_MS : NEAR_TTL_MS;
}

export function isReleaseEntryFresh(entry: ReleaseEntry, now = Date.now()): boolean {
  const ttl = baseTtlMs(entry, now) * (1 + (entry.ttlJitter ?? 0));
  return now - entry.savedAt < ttl;
}

/** Write an entry to memory and schedule a single batched flush. */
export function setReleaseEntry(id: string, entry: ReleaseEntry): void {
  if (!mem) mem = {};
  mem[id] = entry;
  dirty = true;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushReleaseDateCache();
    }, FLUSH_DELAY_MS);
    (flushTimer as { unref?: () => void })?.unref?.();
  }
}

/** Persist pending writes now (best effort). */
export async function flushReleaseDateCache(): Promise<void> {
  if (!dirty || !mem) return;
  dirty = false;
  try {
    await AsyncStorage.setItem(RELEASE_DATE_CACHE_KEY, JSON.stringify(mem));
  } catch {
    dirty = true; // retry on the next write
  }
}

/** Remove the cache (memory + disk). Called from the logout path. */
export async function clearReleaseDateCache(): Promise<void> {
  mem = {};
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await AsyncStorage.removeItem(RELEASE_DATE_CACHE_KEY);
  } catch {
    // ignore
  }
}

/** Test-only: reset in-memory state so each test starts clean. */
export function __resetReleaseDateCacheForTests(): void {
  mem = null;
  loadPromise = null;
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
