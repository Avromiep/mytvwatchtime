import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { slugify } from './util/slugify';

export interface RemapStats {
  stale: number;
  mapped: number;
  unmapped: number;
  /** Pairs whose transfer transaction FAILED (kept both rows, will be retried —
   *  deliberately NOT counted in `unmapped`, which feeds the convergence stamps). */
  transferFailed: number;
  statusesMoved: number;
  historiesMoved: number;
  ratingsMoved: number;
  reactionsMoved: number;
  votesMoved: number;
  commentsMoved: number;
  episodesRemoved: number;
  seasonsRemoved: number;
  /** Rule that produced each mapping (absolute+date, absolute, airDate, title). */
  matchRules: Record<string, number>;
  /** True when the run only computed matches (no writes). */
  dryRun: boolean;
}

interface EpRow {
  id: string;
  number: number;
  absoluteNumber: number | null;
  title: string;
  airDate: Date | null;
  seasonId: string;
  seasonNumber: number;
  isSpecial: boolean;
  hasTmdb: boolean;
  hasTvdb: boolean;
  /** Actual provider id values (needed to MOVE the cross-link onto the target row). */
  tmdbValue: string | null;
  tvdbValue: string | null;
}

const ZERO: RemapStats = {
  stale: 0,
  mapped: 0,
  unmapped: 0,
  transferFailed: 0,
  statusesMoved: 0,
  historiesMoved: 0,
  ratingsMoved: 0,
  reactionsMoved: 0,
  votesMoved: 0,
  commentsMoved: 0,
  episodesRemoved: 0,
  seasonsRemoved: 0,
  matchRules: {},
  dryRun: false,
};

/**
 * Transfers user data (watch statuses, history, ratings, reactions, character votes,
 * comments) between episode structures when a show's episodes are replaced — either
 * after a TMDB→TVDB structure switch (remapShow) or when splitting a cross-type
 * contaminated record into two entities (remapEpisodesToMedia).
 *
 * Matching is conservative — exact airDate first, then exact slugified title; ambiguous
 * or unmatched rows are KEPT (never lose watch data) and reported.
 */
@Injectable()
export class StructureRemapService {
  private readonly logger = new Logger(StructureRemapService.name);

  /**
   * Matching-ladder version. v1 = exact airDate / exact slugified title only — it could
   * never map a flattened TMDB structure onto a split TVDB one (TMDB S1E32 ↔ TVDB S2E1
   * share neither a reliable 1986 airDate nor a title). v2 adds absoluteNumber matching.
   * Repairs store the version they ran with and re-arm when it bumps.
   */
  static readonly MATCHER_VERSION = 2;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * After a canonical-provider hydration of a formerly mixed show: union upsert keeps
   * stale rows that never got linked to the canonical provider (e.g. Re:ZERO TMDB
   * S1E26-77 vs TVDB S2-S4; Dragon Ball's flattened TMDB S1 whose ids were never
   * written; daily shows carrying a stray second provider structure).
   * canonical 'tvdb' (anime / stamped): stale = no TVDB id, fresh = has TVDB id.
   * canonical 'tmdb' (everything else): stale = no TMDB id, fresh = has TMDB id.
   * Maps stale rows onto the fresh ones; dryRun computes matches/counts without writes.
   */
  async remapShow(
    mediaId: string,
    opts?: {
      dryRun?: boolean;
      canonical?: 'tvdb' | 'tmdb';
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<RemapStats> {
    const dryRun = opts?.dryRun === true;
    const canonical = opts?.canonical ?? 'tvdb';
    const hasCanonical = (e: EpRow) => (canonical === 'tvdb' ? e.hasTvdb : e.hasTmdb);
    const episodes = await this.loadShowEpisodes(mediaId);
    if (episodes === null) return { ...ZERO, dryRun };

    const stale = episodes.filter((e) => !hasCanonical(e));
    if (stale.length === 0) return { ...ZERO, dryRun };
    const fresh = episodes.filter(hasCanonical);
    // No canonical rows to map onto — never delete into the void.
    if (fresh.length === 0) return { ...ZERO, dryRun };

    // Rows hydrated before Episode.absoluteNumber existed have it NULL — the matching
    // ladder needs it on BOTH sides. Fill gaps cumulatively from the show's own
    // (possibly stale) ordering: in a flattened TMDB structure S1E32 IS absolute 32,
    // which is exactly the value the TVDB side carries for S2E1. Provider-supplied
    // values are never overwritten; dry-run computes in memory only.
    if (episodes.some((e) => e.absoluteNumber == null)) {
      await this.backfillAbsoluteNumbers(episodes, dryRun);
    }

    const stats = await this.transferMatches(stale, fresh, mediaId, dryRun, opts?.onProgress);

    // Seasons left empty by the cleanup are not part of the fresh structure — drop them.
    const showId = episodes[0]?.showId;
    if (showId && !dryRun) {
      const removedSeasons = await this.prisma.season.deleteMany({
        where: { showId, episodes: { none: {} } },
      });
      stats.seasonsRemoved = removedSeasons.count;
    }

    this.logger.log(
      `remapShow(${mediaId})${dryRun ? ' [dry-run]' : ''} [canonical=${canonical}]: ${stats.mapped}/${stats.stale} mapped, ${stats.unmapped} unmapped/kept, ${stats.transferFailed} transfer-failed, ` +
        `${stats.episodesRemoved} episodes + ${stats.seasonsRemoved} seasons removed, ` +
        `${stats.statusesMoved} statuses, ${stats.historiesMoved} history, ${stats.ratingsMoved} ratings, ` +
        `${stats.reactionsMoved} reactions, ${stats.votesMoved} votes, ${stats.commentsMoved} comments, ` +
        `rules=${JSON.stringify(stats.matchRules)}`,
    );
    return stats;
  }

  /**
   * Cross-entity variant: move user data from episodes under one media (e.g. a stray
   * `shows` row contaminating a MOVIE record) onto the episodes of another media (the
   * freshly-created correct show). Every source episode is a remap candidate; matching
   * is the same conservative airDate/title logic. Source rows are deleted once mapped
   * (or when they carry no user data); unmapped rows with user data are KEPT.
   */
  async remapEpisodesToMedia(sourceMediaId: string, targetMediaId: string): Promise<RemapStats> {
    if (sourceMediaId === targetMediaId) return this.remapShow(sourceMediaId);
    const source = await this.loadShowEpisodes(sourceMediaId);
    const target = await this.loadShowEpisodes(targetMediaId);
    if (!source?.length || !target?.length) return { ...ZERO };

    const stats = await this.transferMatches(source, target, targetMediaId);
    this.logger.log(
      `remapEpisodesToMedia(${sourceMediaId} → ${targetMediaId}): ${stats.mapped}/${stats.stale} mapped, ` +
        `${stats.unmapped} unmapped/kept, ${stats.episodesRemoved} episodes removed`,
    );
    return stats;
  }

  // ---- shared core ----

  /**
   * Fill NULL absoluteNumbers from the show's own season/episode ordering (specials
   * excluded — they don't participate in absolute aired order). Provider-supplied
   * values win; only gaps are filled. Persisted unless dryRun (matching uses the
   * in-memory values either way).
   */
  private async backfillAbsoluteNumbers(
    episodes: (EpRow & { showId: string })[],
    dryRun: boolean,
  ): Promise<void> {
    const regular = episodes
      .filter((e) => !e.isSpecial)
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number);
    let cursor = 1;
    const updates: { id: string; abs: number }[] = [];
    for (const e of regular) {
      if (e.absoluteNumber == null) {
        updates.push({ id: e.id, abs: cursor });
        e.absoluteNumber = cursor;
      }
      cursor++;
    }
    if (dryRun || updates.length === 0) return;
    await this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.episode.update({
          where: { id: u.id },
          data: { absoluteNumber: u.abs },
        }),
      ),
    );
    this.logger.log(`remap: backfilled absoluteNumber on ${updates.length} episode rows`);
  }

  /** All episodes of a media's shows row (null when the media has no shows row).
   *  Narrow select: only the fields the matcher needs — the default include drags the
   *  fat per-locale JSONB columns (titles/overviews/stillUrls) for every episode into
   *  memory, which is the difference between ~3MB and hundreds of MB on mega-dailies. */
  private async loadShowEpisodes(mediaId: string): Promise<(EpRow & { showId: string })[] | null> {    const show = await this.prisma.show.findUnique({
      where: { mediaId },
      select: {
        id: true,
        seasons: {
          orderBy: { number: 'asc' },
          select: {
            id: true,
            number: true,
            isSpecial: true,
            episodes: {
              orderBy: { number: 'asc' },
              select: {
                id: true,
                number: true,
                absoluteNumber: true,
                title: true,
                airDate: true,
                externalIds: { select: { provider: true, value: true } },
              },
            },
          },
        },
      },
    });
    if (!show) return null;
    const rows: (EpRow & { showId: string })[] = [];
    for (const s of show.seasons) {
      for (const e of s.episodes) {
        const providers = new Set(e.externalIds.map((x) => x.provider));
        rows.push({
          id: e.id,
          number: e.number,
          absoluteNumber: e.absoluteNumber,
          title: e.title,
          airDate: e.airDate,
          seasonId: s.id,
          seasonNumber: s.number,
          isSpecial: s.isSpecial,
          hasTmdb: providers.has(ExternalProvider.TMDB),
          hasTvdb: providers.has(ExternalProvider.THE_TVDB),
          tmdbValue: e.externalIds.find((x) => x.provider === ExternalProvider.TMDB)?.value ?? null,
          tvdbValue: e.externalIds.find((x) => x.provider === ExternalProvider.THE_TVDB)?.value ?? null,
          showId: show.id,
        });
      }
    }
    return rows;
  }

  /** Match stale→fresh, transfer user data per pair, clean up unmapped rows, and
   *  recompute progress caches on the target show for every affected user.
   *  dryRun computes matches and kept/deleted counts without any writes.
   *  onProgress fires every 25 pairs (long remaps of mega shows would otherwise look
   *  stalled to the repair-progress watcher). */
  private async transferMatches(
    stale: EpRow[],
    fresh: EpRow[],
    targetMediaId: string,
    dryRun = false,
    onProgress?: (done: number, total: number) => void,
  ): Promise<RemapStats> {
    const stats: RemapStats = { ...ZERO, stale: stale.length, matchRules: {}, dryRun };
    const claimed = new Set<string>();
    const byDate = new Map<string, EpRow[]>();
    const byTitle = new Map<string, EpRow[]>();
    const byAbsolute = new Map<number, EpRow[]>();
    for (const f of fresh) {
      if (f.airDate) {
        const k = f.airDate.toISOString().slice(0, 10);
        byDate.set(k, [...(byDate.get(k) ?? []), f]);
      }
      const slug = slugify(f.title);
      if (slug) byTitle.set(slug, [...(byTitle.get(slug) ?? []), f]);
      if (f.absoluteNumber != null) {
        byAbsolute.set(f.absoluteNumber, [...(byAbsolute.get(f.absoluteNumber) ?? []), f]);
      }
    }

    const pairs: { from: EpRow; to: EpRow; rule: string }[] = [];
    const unmapped: EpRow[] = [];
    for (const s of stale) {
      const match = this.matchTarget(s, byDate, byTitle, byAbsolute, claimed);
      if (match) {
        claimed.add(match.to.id);
        pairs.push({ from: s, to: match.to, rule: match.rule });
        stats.matchRules[match.rule] = (stats.matchRules[match.rule] ?? 0) + 1;
      } else {
        unmapped.push(s);
      }
    }

    if (dryRun) {
      // Counts mirror the real run's decisions: mapped pairs, and among unmapped rows
      // how many would be KEPT (user data) vs deleted.
      stats.mapped = pairs.length;
      const { withData } = await this.splitByUserData(unmapped.map((s) => s.id));
      stats.unmapped = withData.size;
      stats.episodesRemoved = unmapped.length - withData.size;
      return stats;
    }

    const affectedUsers = new Set<string>();
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      try {
        const moved = await this.transferPair(p.from, p.to, affectedUsers);
        stats.mapped++;
        stats.statusesMoved += moved.statuses;
        stats.historiesMoved += moved.histories;
        stats.ratingsMoved += moved.ratings;
        stats.reactionsMoved += moved.reactions;
        stats.votesMoved += moved.votes;
        stats.commentsMoved += moved.comments;
        stats.episodesRemoved++;
      } catch (e) {
        // Keep both rows on failure — data loss is worse than a stale episode row.
        // Counted separately from `unmapped` so the convergence stamps do NOT park
        // this row: it stays stale and is retried on the next run.
        stats.transferFailed++;
        this.logger.warn(
          `remap transfer failed for episode ${p.from.id} → ${p.to.id}: ${(e as Error).message}`,
        );
      }
      if (onProgress && (i + 1) % 25 === 0) onProgress(i + 1, pairs.length);
    }
    // Final heartbeat: totals rarely divide by 25, so without this the UI sits on the
    // last partial beat (e.g. 75/89) through the whole cleanup phase below.
    if (onProgress && pairs.length > 0) onProgress(pairs.length, pairs.length);

    // Unmapped rows: delete only when they carry NO user data; keep (and report) the
    // rest. Batched — one EXISTS query classifies every row, one deleteMany clears
    // the dataless ones. The old per-row hasUserData+delete issued ~6 queries per
    // row, which is tens of thousands on mega-dailies whose structures barely
    // overlap (Charlie Rose: ~5,800 unmapped) and dominated the per-show runtime.
    const { withData } = await this.splitByUserData(unmapped.map((s) => s.id));
    const keptLabels: string[] = [];
    const deleteIds: string[] = [];
    for (const s of unmapped) {
      if (withData.has(s.id)) {
        stats.unmapped++;
        keptLabels.push(`S${s.seasonNumber}E${s.number}`);
      } else {
        deleteIds.push(s.id);
      }
    }
    if (deleteIds.length > 0) {
      try {
        const removed = await this.prisma.episode.deleteMany({ where: { id: { in: deleteIds } } });
        stats.episodesRemoved += removed.count;
      } catch (e) {
        // Conservative: on cleanup failure keep the rows (counted as unmapped, retried
        // next run) — data loss is worse than a stale episode row.
        stats.unmapped += deleteIds.length;
        this.logger.warn(`remap: batched stale-episode cleanup failed: ${(e as Error).message}`);
      }
    }
    // One aggregated line instead of a warning per kept episode (long-running shows can
    // keep dozens — per-row logs flood the API log on every re-run).
    if (keptLabels.length > 0) {
      const preview = keptLabels.slice(0, 8).join(', ');
      const more = keptLabels.length > 8 ? `, … +${keptLabels.length - 8} more` : '';
      this.logger.warn(
        `remap: kept ${keptLabels.length} unmapped episodes with user data (${preview}${more})`,
      );
    }

    // Recompute per-user progress caches for everyone touched.
    for (const userId of affectedUsers) {
      await this.recomputeUserShowStatus(userId, targetMediaId).catch((e) =>
        this.logger.debug(`recompute userShowStatus failed for ${userId}: ${(e as Error).message}`),
      );
    }
    return stats;
  }

  /**
   * Conservative target pick, strongest signal first:
   *  1. absoluteNumber + airDate (±1 day) — cross-provider proof (0.95).
   *  2. absoluteNumber alone, unique on both sides, airDate missing somewhere (0.9) —
   *     the flattened-TMDB ↔ split-TVDB correspondence (TMDB S1E32 == TVDB S2E1).
   *  3. exact airDate, unique (disambiguated by title) — v1 behavior.
   *  4. exact slugified title, unique — v1 behavior.
   * Anything ambiguous returns null — never guess, the stale row is kept and reported.
   */
  private matchTarget(
    s: EpRow,
    byDate: Map<string, EpRow[]>,
    byTitle: Map<string, EpRow[]>,
    byAbsolute: Map<number, EpRow[]>,
    claimed: Set<string>,
  ): { to: EpRow; rule: string } | null {
    const dayOf = (d: Date) => d.toISOString().slice(0, 10);
    const sameDayish = (a: Date | null, b: Date | null) => {
      if (!a || !b) return false;
      const diff = Math.abs(a.getTime() - b.getTime());
      return diff <= 36 * 60 * 60 * 1000; // ±1.5 days absorbs TZ shifts
    };

    if (s.absoluteNumber != null) {
      const candidates = (byAbsolute.get(s.absoluteNumber) ?? []).filter(
        (f) => !claimed.has(f.id),
      );
      if (candidates.length === 1) {
        const c = candidates[0];
        if (s.airDate && c.airDate && sameDayish(s.airDate, c.airDate)) {
          return { to: c, rule: 'absolute+date' };
        }
        // A UNIQUE absolute-number correspondence is proof on its own: both structures
        // are aired-order, and real provider data shows airDates routinely disagree by
        // months for the same episode (Dragon Ball 1986). Dates can only VETO via
        // duplicate absolutes below, not block a unique match.
        return { to: c, rule: 'absolute' };
      }
      if (candidates.length > 1) {
        const dated = candidates.filter((f) => sameDayish(s.airDate, f.airDate));
        if (dated.length === 1) return { to: dated[0], rule: 'absolute+date' };
        return null; // duplicate absolute numbers on the fresh side — do not guess
      }
    }

    if (s.airDate) {
      const candidates = (byDate.get(dayOf(s.airDate)) ?? []).filter((f) => !claimed.has(f.id));
      if (candidates.length === 1) return { to: candidates[0], rule: 'airDate' };
      if (candidates.length > 1) {
        const slug = slugify(s.title);
        const titled = candidates.filter((f) => slugify(f.title) === slug);
        if (titled.length === 1) return { to: titled[0], rule: 'airDate+title' };
        return null; // ambiguous airDate group — do not guess
      }
    }
    const slug = slugify(s.title);
    if (slug) {
      const titled = (byTitle.get(slug) ?? []).filter((f) => !claimed.has(f.id));
      if (titled.length === 1) return { to: titled[0], rule: 'title' };
    }
    return null;
  }

  /** Move all per-episode user data from the stale row to the fresh one, then delete it. */
  private async transferPair(
    from: EpRow,
    to: EpRow,
    affectedUsers: Set<string>,
  ): Promise<{
    statuses: number;
    histories: number;
    ratings: number;
    reactions: number;
    votes: number;
    comments: number;
  }> {
    return this.prisma.$transaction(
      async (tx) => {
        let statuses = 0;
        for (const s of await tx.userEpisodeStatus.findMany({ where: { episodeId: from.id } })) {
          affectedUsers.add(s.userId);
          const existing = await tx.userEpisodeStatus.findUnique({
            where: { userId_episodeId: { userId: s.userId, episodeId: to.id } },
          });
          if (existing) {
            await tx.userEpisodeStatus.update({
              where: { id: existing.id },
              data: {
                watched: existing.watched || s.watched,
                watchedAt: earliest(existing.watchedAt, s.watchedAt),
                watchCount: Math.max(existing.watchCount, s.watchCount),
                device: existing.device ?? s.device,
              },
            });
            await tx.userEpisodeStatus.delete({ where: { id: s.id } });
          } else {
            await tx.userEpisodeStatus.update({ where: { id: s.id }, data: { episodeId: to.id } });
          }
          statuses++;
        }

        const histories = await tx.watchHistory.updateMany({
          where: { episodeId: from.id },
          data: { episodeId: to.id, seasonNumber: to.seasonNumber, episodeNumber: to.number },
        });
        // Collapse exact duplicates created when the user watched BOTH the stale and the
        // fresh row of the same episode (rewatch history is otherwise preserved row-for-row).
        await tx.$executeRaw`
          DELETE FROM watch_history a
          USING watch_history b
          WHERE a.episode_id = ${to.id} AND b.episode_id = ${to.id}
            AND a.user_id = b.user_id
            AND a.watched_at = b.watched_at
            AND a.id > b.id`;
        for (const h of await tx.watchHistory.findMany({
          where: { episodeId: to.id },
          select: { userId: true },
        })) {
          affectedUsers.add(h.userId);
        }

        let ratings = 0;
        for (const r of await tx.rating.findMany({ where: { episodeId: from.id } })) {
          affectedUsers.add(r.userId);
          const existing = await tx.rating.findFirst({
            where: { userId: r.userId, episodeId: to.id },
          });
          if (existing)
            await tx.rating.delete({ where: { id: r.id } }); // target wins
          else await tx.rating.update({ where: { id: r.id }, data: { episodeId: to.id } });
          ratings++;
        }

        let reactions = 0;
        for (const r of await tx.reaction.findMany({ where: { episodeId: from.id } })) {
          affectedUsers.add(r.userId);
          const existing = await tx.reaction.findFirst({
            where: { userId: r.userId, episodeId: to.id, reaction: r.reaction },
          });
          if (existing)
            await tx.reaction.delete({ where: { id: r.id } }); // dup
          else await tx.reaction.update({ where: { id: r.id }, data: { episodeId: to.id } });
          reactions++;
        }

        let votes = 0;
        for (const v of await tx.characterVote.findMany({ where: { episodeId: from.id } })) {
          affectedUsers.add(v.userId);
          const existing = await tx.characterVote.findFirst({
            where: { userId: v.userId, episodeId: to.id },
          });
          if (existing)
            await tx.characterVote.delete({ where: { id: v.id } }); // target wins
          else await tx.characterVote.update({ where: { id: v.id }, data: { episodeId: to.id } });
          votes++;
        }

        const comments = await tx.comment.updateMany({
          where: { threadType: 'EPISODE', threadId: from.id },
          data: { threadId: to.id },
        });

        // Move provider cross-links the target lacks onto it, with their REAL values
        // (delete from the stale row first so the (provider, kind, value) unique index
        // can't collide inside the same transaction). Best-effort per id: a value
        // already claimed by a third row is logged, not fatal.
        const idMoves: { provider: ExternalProvider; value: string }[] = [];
        if (from.tmdbValue && !to.hasTmdb) {
          idMoves.push({ provider: ExternalProvider.TMDB, value: from.tmdbValue });
        }
        if (from.tvdbValue && !to.hasTvdb) {
          idMoves.push({ provider: ExternalProvider.THE_TVDB, value: from.tvdbValue });
        }
        for (const m of idMoves) {
          try {
            await tx.episodeExternalId.deleteMany({
              where: { episodeId: from.id, provider: m.provider },
            });
            await tx.episodeExternalId.create({
              data: {
                episodeId: to.id,
                provider: m.provider,
                providerEntityKind: ProviderEntityKind.EPISODE,
                value: m.value,
              },
            });
          } catch (e) {
            this.logger.warn(
              `remap: could not move ${m.provider} episode id ${m.value} from ${from.id} to ${to.id}: ${(e as Error).message}`,
            );
          }
        }

        await tx.episode.delete({ where: { id: from.id } });
        return {
          statuses,
          histories: histories.count,
          ratings,
          reactions,
          votes,
          comments: comments.count,
        };
      },
      { timeout: 30000 },
    );
  }

  /** Classify episode ids by whether ANY user data is attached — one set-based query
   *  (EXISTS per data table) instead of 5 count queries per episode. */
  private async splitByUserData(episodeIds: string[]): Promise<{ withData: Set<string> }> {
    if (episodeIds.length === 0) return { withData: new Set() };
    const rows = await this.prisma.$queryRaw<{ id: string; has_data: boolean }[]>(
      Prisma.sql`
        SELECT e.id, (
          EXISTS (SELECT 1 FROM user_episode_status u WHERE u.episode_id = e.id)
          OR EXISTS (SELECT 1 FROM ratings r WHERE r.episode_id = e.id)
          OR EXISTS (SELECT 1 FROM reactions r WHERE r.episode_id = e.id)
          OR EXISTS (SELECT 1 FROM character_votes v WHERE v.episode_id = e.id)
          OR EXISTS (SELECT 1 FROM comments c WHERE c.thread_type = 'EPISODE' AND c.thread_id = e.id)
        ) AS has_data
        FROM episodes e
        WHERE e.id IN (${Prisma.join(episodeIds)})`,
    );
    return { withData: new Set(rows.filter((r) => r.has_data).map((r) => r.id)) };
  }

  /** Recompute one user's progress cache for the show (specials excluded), mirroring
   *  the import pipeline's rebuildShowStatuses. */
  private async recomputeUserShowStatus(userId: string, mediaId: string): Promise<void> {
    const [watched] = await this.prisma.$queryRaw<
      { watchedCount: number; lastWatchedAt: Date | null }[]
    >(
      Prisma.sql`
        SELECT COUNT(ues.id)::int AS "watchedCount", MAX(ues.watched_at) AS "lastWatchedAt"
        FROM user_episode_status ues
        JOIN episodes e ON ues.episode_id = e.id
        JOIN seasons s ON e.season_id = s.id
        JOIN shows sh ON s.show_id = sh.id
        WHERE ues.user_id = ${userId} AND ues.watched = true AND s.is_special = false AND sh.media_id = ${mediaId}
        GROUP BY sh.media_id`,
    );
    const [totals] = await this.prisma.$queryRaw<{ totalCount: number }[]>(
      Prisma.sql`
        SELECT COUNT(e.id)::int AS "totalCount"
        FROM episodes e
        JOIN seasons s ON e.season_id = s.id
        JOIN shows sh ON s.show_id = sh.id
        WHERE s.is_special = false AND sh.media_id = ${mediaId}
        GROUP BY sh.media_id`,
    );
    await this.prisma.userShowStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: {
        userId,
        mediaId,
        watchedCount: watched?.watchedCount ?? 0,
        totalCount: totals?.totalCount ?? 0,
        lastWatchedAt: watched?.lastWatchedAt ?? null,
      },
      update: {
        watchedCount: watched?.watchedCount ?? 0,
        totalCount: totals?.totalCount ?? 0,
        lastWatchedAt: watched?.lastWatchedAt ?? null,
      },
    });
  }
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
