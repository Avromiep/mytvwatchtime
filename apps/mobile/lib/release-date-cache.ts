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
const DATED_TTL_MS = 24 * 60 * 60 * 1000;
const NULL_TTL_MS = 12 * 60 * 60 * 1000;
const FLUSH_DELAY_MS = 1500;

export interface ReleaseEntry {
  releaseDate: string | null;
  releaseYear: number | null;
  title: string;
  poster: string | null;
  savedAt: number;
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

export function isReleaseEntryFresh(entry: ReleaseEntry, now = Date.now()): boolean {
  const ttl = entry.releaseDate ? DATED_TTL_MS : NULL_TTL_MS;
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

/** True when nothing is cached or the newest entry is older than the dated TTL —
 *  used to decide whether the deferred prefetch should run. */
export async function isReleaseCacheStale(now = Date.now()): Promise<boolean> {
  await loadReleaseDateCache();
  const entries = mem ? Object.values(mem) : [];
  if (entries.length === 0) return true;
  const newest = entries.reduce((max, e) => Math.max(max, e.savedAt), 0);
  return now - newest >= DATED_TTL_MS;
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
