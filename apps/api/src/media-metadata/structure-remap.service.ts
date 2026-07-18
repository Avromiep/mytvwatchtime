import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExternalProvider } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { slugify } from './util/slugify';

export interface RemapStats {
  stale: number;
  mapped: number;
  unmapped: number;
  statusesMoved: number;
  historiesMoved: number;
  ratingsMoved: number;
  reactionsMoved: number;
  votesMoved: number;
  commentsMoved: number;
  episodesRemoved: number;
  seasonsRemoved: number;
}

interface EpRow {
  id: string;
  number: number;
  title: string;
  airDate: Date | null;
  seasonId: string;
  seasonNumber: number;
  isSpecial: boolean;
  hasTmdb: boolean;
  hasTvdb: boolean;
}

const ZERO: RemapStats = {
  stale: 0,
  mapped: 0,
  unmapped: 0,
  statusesMoved: 0,
  historiesMoved: 0,
  ratingsMoved: 0,
  reactionsMoved: 0,
  votesMoved: 0,
  commentsMoved: 0,
  episodesRemoved: 0,
  seasonsRemoved: 0,
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

  constructor(private readonly prisma: PrismaService) {}

  /**
   * After a TVDB hydration of a formerly TMDB-structured show: union upsert keeps stale
   * TMDB-only rows (e.g. Re:ZERO TMDB S1E26-77 vs TVDB S2-S4). Stale = has a TMDB episode
   * external id and NO TVDB one (fresh rows carry both). Maps them onto the fresh rows.
   */
  async remapShow(mediaId: string): Promise<RemapStats> {
    const episodes = await this.loadShowEpisodes(mediaId);
    if (episodes === null) return { ...ZERO };

    const stale = episodes.filter((e) => !e.hasTvdb && e.hasTmdb);
    if (stale.length === 0) return { ...ZERO };
    const fresh = episodes.filter((e) => e.hasTvdb);

    const stats = await this.transferMatches(stale, fresh, mediaId);

    // Seasons left empty by the cleanup are not part of the fresh structure — drop them.
    const showId = episodes[0]?.showId;
    if (showId) {
      const removedSeasons = await this.prisma.season.deleteMany({
        where: { showId, episodes: { none: {} } },
      });
      stats.seasonsRemoved = removedSeasons.count;
    }

    this.logger.log(
      `remapShow(${mediaId}): ${stats.mapped}/${stats.stale} mapped, ${stats.unmapped} unmapped/kept, ` +
        `${stats.episodesRemoved} episodes + ${stats.seasonsRemoved} seasons removed, ` +
        `${stats.statusesMoved} statuses, ${stats.historiesMoved} history, ${stats.ratingsMoved} ratings, ` +
        `${stats.reactionsMoved} reactions, ${stats.votesMoved} votes, ${stats.commentsMoved} comments`,
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

  /** All episodes of a media's shows row (null when the media has no shows row). */
  private async loadShowEpisodes(mediaId: string): Promise<(EpRow & { showId: string })[] | null> {
    const show = await this.prisma.show.findUnique({
      where: { mediaId },
      include: {
        seasons: {
          orderBy: { number: 'asc' },
          include: {
            episodes: {
              orderBy: { number: 'asc' },
              include: { externalIds: { select: { provider: true } } },
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
          title: e.title,
          airDate: e.airDate,
          seasonId: s.id,
          seasonNumber: s.number,
          isSpecial: s.isSpecial,
          hasTmdb: providers.has(ExternalProvider.TMDB),
          hasTvdb: providers.has(ExternalProvider.THE_TVDB),
          showId: show.id,
        });
      }
    }
    return rows;
  }

  /** Match stale→fresh, transfer user data per pair, clean up unmapped rows, and
   *  recompute progress caches on the target show for every affected user. */
  private async transferMatches(
    stale: EpRow[],
    fresh: EpRow[],
    targetMediaId: string,
  ): Promise<RemapStats> {
    const stats: RemapStats = { ...ZERO, stale: stale.length };
    const claimed = new Set<string>();
    const byDate = new Map<string, EpRow[]>();
    const byTitle = new Map<string, EpRow[]>();
    for (const f of fresh) {
      if (f.airDate) {
        const k = f.airDate.toISOString().slice(0, 10);
        byDate.set(k, [...(byDate.get(k) ?? []), f]);
      }
      const slug = slugify(f.title);
      if (slug) byTitle.set(slug, [...(byTitle.get(slug) ?? []), f]);
    }

    const pairs: { from: EpRow; to: EpRow }[] = [];
    const unmapped: EpRow[] = [];
    for (const s of stale) {
      const to = this.matchTarget(s, byDate, byTitle, claimed);
      if (to) {
        claimed.add(to.id);
        pairs.push({ from: s, to });
      } else {
        unmapped.push(s);
      }
    }

    const affectedUsers = new Set<string>();
    for (const p of pairs) {
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
        stats.unmapped++;
        this.logger.warn(
          `remap transfer failed for episode ${p.from.id} → ${p.to.id}: ${(e as Error).message}`,
        );
      }
    }

    // Unmapped rows: delete only when they carry NO user data; keep (and report) the rest.
    for (const s of unmapped) {
      try {
        if (await this.hasUserData(s.id)) {
          stats.unmapped++;
          this.logger.warn(
            `remap: kept unmapped episode ${s.id} (S${s.seasonNumber}E${s.number}) — has user data`,
          );
        } else {
          await this.prisma.episode.delete({ where: { id: s.id } });
          stats.episodesRemoved++;
        }
      } catch (e) {
        stats.unmapped++;
        this.logger.warn(`remap: failed to clean stale episode ${s.id}: ${(e as Error).message}`);
      }
    }

    // Recompute per-user progress caches for everyone touched.
    for (const userId of affectedUsers) {
      await this.recomputeUserShowStatus(userId, targetMediaId).catch((e) =>
        this.logger.debug(`recompute userShowStatus failed for ${userId}: ${(e as Error).message}`),
      );
    }
    return stats;
  }

  /** Conservative target pick: exact airDate (disambiguated by title), else exact title. */
  private matchTarget(
    s: EpRow,
    byDate: Map<string, EpRow[]>,
    byTitle: Map<string, EpRow[]>,
    claimed: Set<string>,
  ): EpRow | null {
    if (s.airDate) {
      const candidates = (byDate.get(s.airDate.toISOString().slice(0, 10)) ?? []).filter(
        (f) => !claimed.has(f.id),
      );
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) {
        const slug = slugify(s.title);
        const titled = candidates.filter((f) => slugify(f.title) === slug);
        if (titled.length === 1) return titled[0];
        return null; // ambiguous airDate group — do not guess
      }
    }
    const slug = slugify(s.title);
    if (slug) {
      const titled = (byTitle.get(slug) ?? []).filter((f) => !claimed.has(f.id));
      if (titled.length === 1) return titled[0];
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

  /** Any user data attached to an episode row? (WatchHistory re-points/nulls are harmless.) */
  private async hasUserData(episodeId: string): Promise<boolean> {
    const [statuses, ratings, reactions, votes, comments] = await Promise.all([
      this.prisma.userEpisodeStatus.count({ where: { episodeId } }),
      this.prisma.rating.count({ where: { episodeId } }),
      this.prisma.reaction.count({ where: { episodeId } }),
      this.prisma.characterVote.count({ where: { episodeId } }),
      this.prisma.comment.count({ where: { threadType: 'EPISODE', threadId: episodeId } }),
    ]);
    return statuses + ratings + reactions + votes + comments > 0;
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
