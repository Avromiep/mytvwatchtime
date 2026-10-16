/**
 * On-device cache of TVmaze lookups for Upcoming Shows air times. One JSON blob in
 * AsyncStorage holding two maps: show-resolve-key → TVmaze show id, and episode-key →
 * air-time facts. Same corrupt-safe / batched-write / logout-clear rules as the movie
 * release-date cache.
 *
 * TTLs: show id 30 days; episode airstamp 12h if it airs within 7 days else 24h, and
 * 6h for "not found" (so a transient miss re-resolves soon).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const TVMAZE_CACHE_KEY = 'tvmazeAirtimes:v1';
const SHOW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EPISODE_SOON_TTL_MS = 12 * 60 * 60 * 1000;
const EPISODE_FAR_TTL_MS = 24 * 60 * 60 * 1000;
const EPISODE_NOT_FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const SOON_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FLUSH_DELAY_MS = 1500;

export interface ShowEntry {
  id: number | null;
  hasNetwork: boolean;
  webChannel: string | null;
  savedAt: number;
}
export interface EpisodeEntry {
  airstamp: string | null;
  hasNetwork: boolean;
  webChannel: string | null;
  savedAt: number;
}

interface Store {
  shows: Record<string, ShowEntry>;
  episodes: Record<string, EpisodeEntry>;
}

let mem: Store | null = null;
let loadPromise: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function emptyStore(): Store {
  return { shows: {}, episodes: {} };
}

export function episodeKey(showResolveKey: string, season: number, number: number): string {
  return `${showResolveKey}|S${season}E${number}`;
}

export function loadTvmazeCache(): Promise<void> {
  if (mem) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(TVMAZE_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        mem = {
          shows: parsed.shows && typeof parsed.shows === 'object' ? parsed.shows : {},
          episodes: parsed.episodes && typeof parsed.episodes === 'object' ? parsed.episodes : {},
        };
      } else {
        mem = emptyStore();
      }
    } catch {
      mem = emptyStore(); // corrupt / unreadable — start empty, never throw
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export function getShow(key: string): ShowEntry | undefined {
  return mem?.shows[key];
}
export function isShowFresh(entry: ShowEntry, now = Date.now()): boolean {
  // A resolved show id lasts 30 days; a real 404 (id null) only gets the short
  // not-found TTL so it re-resolves soon.
  const ttl = entry.id == null ? EPISODE_NOT_FOUND_TTL_MS : SHOW_TTL_MS;
  return now - entry.savedAt < ttl;
}
export function setShow(key: string, entry: Omit<ShowEntry, 'savedAt'>): void {
  if (!mem) mem = emptyStore();
  mem.shows[key] = { ...entry, savedAt: Date.now() };
  markDirty();
}

export function getEpisode(key: string): EpisodeEntry | undefined {
  return mem?.episodes[key];
}
function episodeTtlMs(entry: EpisodeEntry, now: number): number {
  if (!entry.airstamp) return EPISODE_NOT_FOUND_TTL_MS;
  const airMs = new Date(entry.airstamp).getTime();
  if (!Number.isNaN(airMs) && airMs - now <= SOON_WINDOW_MS) return EPISODE_SOON_TTL_MS;
  return EPISODE_FAR_TTL_MS;
}
export function isEpisodeFresh(entry: EpisodeEntry, now = Date.now()): boolean {
  return now - entry.savedAt < episodeTtlMs(entry, now);
}
export function setEpisode(key: string, entry: Omit<EpisodeEntry, 'savedAt'>): void {
  if (!mem) mem = emptyStore();
  mem.episodes[key] = { ...entry, savedAt: Date.now() };
  markDirty();
}

function markDirty(): void {
  dirty = true;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushTvmazeCache();
    }, FLUSH_DELAY_MS);
    (flushTimer as { unref?: () => void })?.unref?.();
  }
}

export async function flushTvmazeCache(): Promise<void> {
  if (!dirty || !mem) return;
  dirty = false;
  try {
    await AsyncStorage.setItem(TVMAZE_CACHE_KEY, JSON.stringify(mem));
  } catch {
    dirty = true;
  }
}

export async function clearTvmazeCache(): Promise<void> {
  mem = emptyStore();
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await AsyncStorage.removeItem(TVMAZE_CACHE_KEY);
  } catch {
    // ignore
  }
}

export function __resetTvmazeCacheForTests(): void {
  mem = null;
  loadPromise = null;
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
