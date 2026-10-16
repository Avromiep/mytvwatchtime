/**
 * Screen-level TVmaze air-time resolver for Upcoming Shows. Given the upcoming items
 * that have no local time, it dedupes by show, resolves the TVmaze show id (cache
 * first, then external id → title search — in practice title, since upcoming items
 * carry no ids), fetches the show's episodes once, and returns a Map of episodeKey →
 * 12-hour ET label (null = resolved, no time). Results are cached on device.
 *
 * Politeness: at most 4 shows resolve at once (so ≤4 concurrent TVmaze requests). A
 * 429 is retried once after ~2s; if it still 429s we leave the entry unresolved and
 * never cache a blank, so it retries later.
 */
import { createLimiter } from './limit';
import { tvmazeEpisodeTimeLabel } from './airtime';
import {
  episodeKey,
  flushTvmazeCache,
  getEpisode,
  getShow,
  isEpisodeFresh,
  isShowFresh,
  loadTvmazeCache,
  setEpisode,
  setShow,
  type EpisodeEntry,
} from './tvmaze-cache';

const tvmazeLimiter = createLimiter(4);
const BASE = 'https://api.tvmaze.com';

export interface UpcomingLikeItem {
  mediaId?: string;
  id?: string;
  title: string;
  seasonNumber?: number;
  episodeNumber?: number;
  externalIds?: Array<{ provider: string; id: string }>;
}

/** Stable per-show key (the backend media id dedupes shows regardless of title). */
export function showResolveKey(item: UpcomingLikeItem): string {
  return String(item.mediaId ?? item.id ?? item.title ?? '');
}

/** Cache/lookup key for a specific episode; null when it isn't a numbered episode. */
export function itemEpisodeKey(item: UpcomingLikeItem): string | null {
  if (item.seasonNumber == null || item.episodeNumber == null) return null;
  return episodeKey(showResolveKey(item), item.seasonNumber, item.episodeNumber);
}

function externalIdOf(item: UpcomingLikeItem, provider: string): string | undefined {
  const hit = item.externalIds?.find((e) => e?.provider === provider && e?.id);
  return hit ? String(hit.id) : undefined;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FetchResult {
  data: any;
  rateLimited: boolean;
}

/** GET with one 429 retry after ~2s. `rateLimited` means it 429'd both times. */
async function tvmazeFetch(url: string): Promise<FetchResult> {
  try {
    let r = await fetch(url);
    if (r.status === 429) {
      await delay(2000);
      r = await fetch(url);
      if (r.status === 429) return { data: null, rateLimited: true };
    }
    return { data: r.ok ? await r.json() : null, rateLimited: false };
  } catch {
    return { data: null, rateLimited: false };
  }
}

function labelFromEntry(entry: EpisodeEntry): string | null {
  return tvmazeEpisodeTimeLabel(
    { airstamp: entry.airstamp },
    {
      network: entry.hasNetwork ? {} : null,
      webChannel: entry.webChannel ? { name: entry.webChannel } : null,
    },
  );
}

interface ResolvedShow {
  id: number | null;
  hasNetwork: boolean;
  webChannel: string | null;
  rateLimited: boolean;
}

async function resolveShowId(item: UpcomingLikeItem): Promise<ResolvedShow> {
  const tvmazeId = externalIdOf(item, 'TVMAZE');
  const tvdbId = externalIdOf(item, 'THE_TVDB');
  const imdbId = externalIdOf(item, 'IMDB');
  let url: string;
  if (tvmazeId) url = `${BASE}/shows/${encodeURIComponent(tvmazeId)}`;
  else if (tvdbId) url = `${BASE}/lookup/shows?thetvdb=${encodeURIComponent(tvdbId)}`;
  else if (imdbId) url = `${BASE}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`;
  else if (item.title) url = `${BASE}/singlesearch/shows?q=${encodeURIComponent(item.title)}`;
  else return { id: null, hasNetwork: false, webChannel: null, rateLimited: false };

  const res = await tvmazeFetch(url);
  if (res.rateLimited) return { id: null, hasNetwork: false, webChannel: null, rateLimited: true };
  const show = res.data;
  if (!show || typeof show.id !== 'number') {
    return { id: null, hasNetwork: false, webChannel: null, rateLimited: false };
  }
  return {
    id: show.id,
    hasNetwork: !!show.network,
    webChannel: show.webChannel?.name ?? null,
    rateLimited: false,
  };
}

async function resolveShow(
  rk: string,
  group: { item0: UpcomingLikeItem; eps: UpcomingLikeItem[] },
  now: number,
  labels: Map<string, string | null>,
  force: boolean,
): Promise<void> {
  const needing: UpcomingLikeItem[] = [];
  for (const ep of group.eps) {
    const epKey = itemEpisodeKey(ep) as string;
    const cached = getEpisode(epKey);
    if (!force && cached && isEpisodeFresh(cached, now)) labels.set(epKey, labelFromEntry(cached));
    else needing.push(ep);
  }
  if (needing.length === 0) return;

  // Show id + network info (cache first).
  let showEntry = getShow(rk);
  if (force || !showEntry || !isShowFresh(showEntry, now)) {
    const resolved = await resolveShowId(group.item0);
    if (resolved.rateLimited) return; // leave unresolved, never cache a blank on 429
    setShow(rk, {
      id: resolved.id,
      hasNetwork: resolved.hasNetwork,
      webChannel: resolved.webChannel,
    });
    showEntry = { ...resolved, savedAt: now };
  }
  const showId = showEntry.id;
  if (showId == null) {
    for (const ep of needing) labels.set(itemEpisodeKey(ep) as string, null);
    return;
  }

  // One episodes call per show; match locally. Fall back to episodebynumber per miss.
  const allRes = await tvmazeFetch(`${BASE}/shows/${showId}/episodes`);
  if (allRes.rateLimited) return;
  const byNum = new Map<string, any>();
  if (Array.isArray(allRes.data)) {
    for (const e of allRes.data) {
      if (e && typeof e.season === 'number' && typeof e.number === 'number') {
        byNum.set(`${e.season}-${e.number}`, e);
      }
    }
  }

  for (const ep of needing) {
    const epKey = itemEpisodeKey(ep) as string;
    let episode = byNum.get(`${ep.seasonNumber}-${ep.episodeNumber}`);
    if (!episode) {
      const one = await tvmazeFetch(
        `${BASE}/shows/${showId}/episodebynumber?season=${ep.seasonNumber}&number=${ep.episodeNumber}`,
      );
      if (one.rateLimited) continue; // never cache a blank on 429
      episode = one.data && typeof one.data === 'object' ? one.data : null;
    }
    const airstamp: string | null = episode?.airstamp ?? null;
    setEpisode(epKey, { airstamp, hasNetwork: showEntry.hasNetwork, webChannel: showEntry.webChannel });
    labels.set(
      epKey,
      tvmazeEpisodeTimeLabel(
        { airstamp },
        {
          network: showEntry.hasNetwork ? {} : null,
          webChannel: showEntry.webChannel ? { name: showEntry.webChannel } : null,
        },
      ),
    );
  }
}

/**
 * Resolve ET air-time labels for the given upcoming items. Returns episodeKey → label
 * (null = resolved but no time). Items without a season/episode are ignored.
 */
export async function resolveUpcomingAirtimes(
  items: UpcomingLikeItem[],
  opts: { force?: boolean } = {},
): Promise<Map<string, string | null>> {
  await loadTvmazeCache();
  const now = Date.now();
  const labels = new Map<string, string | null>();

  const byShow = new Map<string, { item0: UpcomingLikeItem; eps: UpcomingLikeItem[] }>();
  for (const item of items) {
    if (itemEpisodeKey(item) == null) continue;
    const rk = showResolveKey(item);
    const g = byShow.get(rk);
    if (g) g.eps.push(item);
    else byShow.set(rk, { item0: item, eps: [item] });
  }

  await Promise.all(
    [...byShow.entries()].map(([rk, group]) =>
      tvmazeLimiter.run(() => resolveShow(rk, group, now, labels, !!opts.force)),
    ),
  );
  await flushTvmazeCache();
  return labels;
}
