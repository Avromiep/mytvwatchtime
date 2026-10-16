/**
 * Screen-level TVmaze air-time resolver for Upcoming Shows. Dedupes by show, resolves
 * the TVmaze show id (cache first, then external id → title search — in practice title,
 * since upcoming items carry no ids), fetches the show's episodes once, and returns a
 * Map of episodeKey → 12-hour ET label (null = resolved, no time). Results are cached.
 *
 * Every TVmaze request goes through the shared gate (tvmaze-fetch): ≤2 concurrent and
 * ≤15 starts / 10s, with 429 retries. Only real 404s are cached as "not found"; 429s,
 * other non-OK answers and network errors are left unresolved and never cached.
 */
import { tvmazeEpisodeTimeLabel } from './airtime';
import { tvmazeGet } from './tvmaze-fetch';
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

function labelFromEntry(entry: EpisodeEntry): string | null {
  return tvmazeEpisodeTimeLabel(
    { airstamp: entry.airstamp },
    {
      network: entry.hasNetwork ? {} : null,
      webChannel: entry.webChannel ? { name: entry.webChannel } : null,
    },
  );
}

type ShowOutcome =
  | { outcome: 'ok'; id: number; hasNetwork: boolean; webChannel: string | null }
  | { outcome: 'notFound' }
  | { outcome: 'error' };

async function resolveShowId(item: UpcomingLikeItem): Promise<ShowOutcome> {
  const tvmazeId = externalIdOf(item, 'TVMAZE');
  const tvdbId = externalIdOf(item, 'THE_TVDB');
  const imdbId = externalIdOf(item, 'IMDB');
  let url: string;
  if (tvmazeId) url = `${BASE}/shows/${encodeURIComponent(tvmazeId)}`;
  else if (tvdbId) url = `${BASE}/lookup/shows?thetvdb=${encodeURIComponent(tvdbId)}`;
  else if (imdbId) url = `${BASE}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`;
  else if (item.title) url = `${BASE}/singlesearch/shows?q=${encodeURIComponent(item.title)}`;
  else return { outcome: 'notFound' };

  const res = await tvmazeGet(url);
  if (res.status === 'error') return { outcome: 'error' };
  if (res.status === 'notFound') return { outcome: 'notFound' };
  const show = res.data;
  if (!show || typeof show.id !== 'number') return { outcome: 'notFound' };
  return {
    outcome: 'ok',
    id: show.id,
    hasNetwork: !!show.network,
    webChannel: show.webChannel?.name ?? null,
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

  let showEntry = getShow(rk);
  if (force || !showEntry || !isShowFresh(showEntry, now)) {
    const resolved = await resolveShowId(group.item0);
    if (resolved.outcome === 'error') return; // never cache an error; retry later
    const id = resolved.outcome === 'ok' ? resolved.id : null;
    const hasNetwork = resolved.outcome === 'ok' ? resolved.hasNetwork : false;
    const webChannel = resolved.outcome === 'ok' ? resolved.webChannel : null;
    setShow(rk, { id, hasNetwork, webChannel });
    showEntry = { id, hasNetwork, webChannel, savedAt: now };
  }
  const showId = showEntry.id;
  if (showId == null) {
    // Real 404 — the show isn't on TVmaze, so there's no time to show.
    for (const ep of needing) labels.set(itemEpisodeKey(ep) as string, null);
    return;
  }

  // One episodes call per show; match locally. Fall back to episodebynumber per miss.
  const allRes = await tvmazeGet(`${BASE}/shows/${showId}/episodes`);
  if (allRes.status === 'error') return; // leave unresolved, never cache
  const byNum = new Map<string, any>();
  if (allRes.status === 'ok' && Array.isArray(allRes.data)) {
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
      const one = await tvmazeGet(
        `${BASE}/shows/${showId}/episodebynumber?season=${ep.seasonNumber}&number=${ep.episodeNumber}`,
      );
      if (one.status === 'error') continue; // never cache an error
      if (one.status === 'notFound') {
        setEpisode(epKey, { airstamp: null, hasNetwork: showEntry.hasNetwork, webChannel: showEntry.webChannel });
        labels.set(epKey, null);
        continue;
      }
      episode = one.data && typeof one.data === 'object' ? one.data : null;
    }
    const airstamp: string | null = episode?.airstamp ?? null;
    setEpisode(epKey, { airstamp, hasNetwork: showEntry.hasNetwork, webChannel: showEntry.webChannel });
    labels.set(epKey, labelFromEntry({ airstamp, hasNetwork: showEntry.hasNetwork, webChannel: showEntry.webChannel, savedAt: now }));
  }
}

/**
 * Resolve ET air-time labels for the given upcoming items. Returns episodeKey → label
 * (null = resolved but no time). Items without a season/episode are ignored. The shared
 * TVmaze gate bounds total request concurrency/rate across all shows.
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
    [...byShow.entries()].map(([rk, group]) => resolveShow(rk, group, now, labels, !!opts.force)),
  );
  await flushTvmazeCache();
  return labels;
}
