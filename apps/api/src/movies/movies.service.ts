import { Injectable, NotFoundException } from '@nestjs/common';
import { ExternalProvider, MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { TmdbProvider } from '../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../media-metadata/providers/tvdb.provider';
import { MediaVotesService } from '../common/media-votes.service';
import { StatsService } from '../stats/stats.service';

@Injectable()
export class MoviesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    private readonly mediaVotes: MediaVotesService,
    private readonly stats: StatsService,
  ) {}

  private async hasReassignableActivity(userId: string | undefined, mediaId: string) {
    if (!userId) return false;

    const [row] = await this.prisma.$queryRaw<{ canReassign: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM user_movie_status
        WHERE user_id = ${userId} AND media_id = ${mediaId}
        UNION ALL
        SELECT 1 FROM watch_history
        WHERE user_id = ${userId} AND media_id = ${mediaId} AND media_type = 'MOVIE'
        UNION ALL
        SELECT 1 FROM ratings
        WHERE user_id = ${userId} AND media_id = ${mediaId}
        UNION ALL
        SELECT 1 FROM reactions
        WHERE user_id = ${userId} AND media_id = ${mediaId}
        UNION ALL
        SELECT 1 FROM watchlist_items
        WHERE user_id = ${userId} AND media_id = ${mediaId}
        UNION ALL
        SELECT 1 FROM favorites
        WHERE user_id = ${userId} AND media_id = ${mediaId}
        UNION ALL
        SELECT 1 FROM custom_list_items i
        JOIN custom_lists l ON l.id = i.list_id
        WHERE l.user_id = ${userId} AND i.media_id = ${mediaId}
        UNION ALL
        SELECT 1 FROM comments
        WHERE user_id = ${userId}
          AND (
            (thread_type = 'MOVIE' AND thread_id = ${mediaId})
            OR (media_type = 'MOVIE' AND media_id = ${mediaId})
          )
      ) AS "canReassign"
    `;
    return row?.canReassign ?? false;
  }

  private async withInteractions(detail: any, userId?: string) {
    if (!detail || typeof detail !== 'object') return detail;
    const [interactions, canReassign] = await Promise.all([
      this.mediaVotes.getMovieInteractions(detail.id, userId),
      this.hasReassignableActivity(userId, detail.id),
    ]);
    return { ...detail, interactions, canReassign };
  }

  async getMovie(id: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({ where: { id }, include: { externalIds: true } });
    if (!media) {
      if (this.tmdb.enabled && /^\d+$/.test(id)) {
        const fullId = await this.meta.ensureMovieFull(Number(id));
        return this.withInteractions(await this.meta.getMovieDetail(fullId, userId), userId);
      }
    } else {
      const lang = currentLanguage();
      // Re-hydrate when metadata is stale OR the request locale's title override
      // is missing (so already-hydrated movies still get localized on first view).
      const localeMissing = lang !== 'en' && !((media.titles as any)?.[lang]);
      const needsHydration =
        !media.metadataRefreshedAt ||
        Date.now() - media.metadataRefreshedAt.getTime() > 1000 * 60 * 60 * 24 ||
        localeMissing;
      const tmdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.TMDB);
      const tvdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.THE_TVDB);
      if (needsHydration && this.tmdb.enabled && tmdbExt) {
        await this.meta.ensureMovieFull(Number(tmdbExt.value));
      } else if (needsHydration && this.tvdb.enabled && tvdbExt && !tmdbExt) {
        // TVDB-only movie (backup provider): hydrate fully so poster/cast/genres are present.
        await this.meta.ensureMovieFullTvdb(Number(tvdbExt.value));
      }
      // Classify on every detail view (cheap + deduped per hydration version).
      await this.meta.scheduleClassification(id).catch(() => undefined);
      return this.withInteractions(await this.meta.getMovieDetail(id, userId), userId);
    }
    return this.withInteractions(await this.meta.getMovieDetail(id, userId), userId);
  }

  voteRating(userId: string, mediaId: string, value: number) {
    return this.mediaVotes.voteMovieRating(userId, mediaId, value);
  }

  voteReaction(userId: string, mediaId: string, value: string) {
    return this.mediaVotes.voteMovieReaction(userId, mediaId, value);
  }

  async upcomingMovies(userId: string) {
    const watchlist = await this.prisma.watchlistItem.findMany({
      where: { userId, media: { type: 'MOVIE' as const, movie: { releaseDate: { gte: new Date() } } } },
      include: { media: { include: { movie: true } } },
    });
    return watchlist
      .map((w) => w.media)
      .sort((a, b) => (a.movie?.releaseDate?.getTime() || 0) - (b.movie?.releaseDate?.getTime() || 0));
  }

  /**
   * Move ONE user's engagement from one MOVIE row to another (e.g. an import matched the
   * wrong movie). Per-user adaptation of the admin merge (mergeDuplicateMovieRows in
   * media-metadata/metadata-backfill.service.ts): every statement is scoped with
   * `user_id = userId` and, unlike the admin merge, external_ids / external_reviews /
   * other users' comments stay put and the source media row is NOT deleted.
   *
   * NOTE: MediaItem.addedCount is deliberately not adjusted — same known gap as the admin merge.
   */
  async reassignUserMovie(userId: string, sourceId: string, targetMediaId: string) {
    const summary = await this.prisma.$transaction(
      async (tx: any) => {
        const [source, target] = await Promise.all([
          tx.mediaItem.findUnique({ where: { id: sourceId }, select: { id: true, type: true } }),
          tx.mediaItem.findUnique({ where: { id: targetMediaId }, select: { id: true, type: true } }),
        ]);
        if (!source || source.type !== MediaType.MOVIE) {
          throw new NotFoundException('Source movie not found');
        }
        if (!target || target.type !== MediaType.MOVIE) {
          throw new NotFoundException('Target movie not found');
        }

        // user_movie_status: merge onto the user's existing target row (OR watched,
        // earliest watched_at, max watch_count), otherwise move the source row.
        const statusMerged = await tx.$executeRaw`
          UPDATE user_movie_status t
          SET watched = (t.watched OR s.watched),
              watched_at = LEAST(COALESCE(t.watched_at, s.watched_at), COALESCE(s.watched_at, t.watched_at)),
              watch_count = GREATEST(t.watch_count, s.watch_count),
              updated_at = NOW()
          FROM user_movie_status s
          WHERE s.user_id = ${userId} AND s.media_id = ${sourceId}
            AND t.user_id = ${userId} AND t.media_id = ${targetMediaId}`;
        let statusMoved = 0;
        if (statusMerged > 0) {
          await tx.$executeRaw`
            DELETE FROM user_movie_status WHERE user_id = ${userId} AND media_id = ${sourceId}`;
        } else {
          statusMoved = await tx.$executeRaw`
            UPDATE user_movie_status SET media_id = ${targetMediaId}
            WHERE user_id = ${userId} AND media_id = ${sourceId}`;
        }

        const historyMoved = await tx.watchHistory.updateMany({
          where: { userId, mediaId: sourceId, mediaType: MediaType.MOVIE },
          data: { mediaId: targetMediaId },
        });

        // ratings (userId+mediaId unique): if a target row exists keep the newest
        // (copy rating/updated_at from the source only when the source is newer),
        // then delete the source row; otherwise move it.
        const ratingsMerged = await tx.$executeRaw`
          UPDATE ratings t
          SET rating = s.rating,
              updated_at = s.updated_at
          FROM ratings s
          WHERE s.user_id = ${userId} AND s.media_id = ${sourceId}
            AND t.user_id = ${userId} AND t.media_id = ${targetMediaId}
            AND s.updated_at > t.updated_at`;
        const ratingsMoved = await tx.$executeRaw`
          UPDATE ratings r SET media_id = ${targetMediaId}
          WHERE r.user_id = ${userId} AND r.media_id = ${sourceId}
            AND NOT EXISTS (
              SELECT 1 FROM ratings t WHERE t.user_id = ${userId} AND t.media_id = ${targetMediaId}
            )`;
        const ratingsRemoved = await tx.$executeRaw`
          DELETE FROM ratings WHERE user_id = ${userId} AND media_id = ${sourceId}`;

        // reactions (userId+mediaId+reaction unique): move rows whose reaction type is
        // not already on the target; delete the rest.
        const reactionsMoved = await tx.$executeRaw`
          UPDATE reactions r SET media_id = ${targetMediaId}
          WHERE r.user_id = ${userId} AND r.media_id = ${sourceId}
            AND NOT EXISTS (
              SELECT 1 FROM reactions t
              WHERE t.user_id = ${userId} AND t.media_id = ${targetMediaId} AND t.reaction = r.reaction
            )`;
        const reactionsRemoved = await tx.$executeRaw`
          DELETE FROM reactions WHERE user_id = ${userId} AND media_id = ${sourceId}`;

        const watchlistMoved = await tx.$executeRaw`
          UPDATE watchlist_items w SET media_id = ${targetMediaId}
          WHERE w.user_id = ${userId} AND w.media_id = ${sourceId}
            AND NOT EXISTS (
              SELECT 1 FROM watchlist_items t WHERE t.user_id = ${userId} AND t.media_id = ${targetMediaId}
            )`;
        const watchlistRemoved = await tx.$executeRaw`
          DELETE FROM watchlist_items WHERE user_id = ${userId} AND media_id = ${sourceId}`;

        const favoritesMoved = await tx.$executeRaw`
          UPDATE favorites f SET media_id = ${targetMediaId}
          WHERE f.user_id = ${userId} AND f.media_id = ${sourceId}
            AND NOT EXISTS (
              SELECT 1 FROM favorites t WHERE t.user_id = ${userId} AND t.media_id = ${targetMediaId}
            )`;
        const favoritesRemoved = await tx.$executeRaw`
          DELETE FROM favorites WHERE user_id = ${userId} AND media_id = ${sourceId}`;

        // custom_list_items has no user_id — scope to lists owned by this user.
        const listItemsMoved = await tx.$executeRaw`
          UPDATE custom_list_items i SET media_id = ${targetMediaId}
          WHERE i.media_id = ${sourceId}
            AND EXISTS (SELECT 1 FROM custom_lists l WHERE l.id = i.list_id AND l.user_id = ${userId})
            AND NOT EXISTS (
              SELECT 1 FROM custom_list_items t WHERE t.list_id = i.list_id AND t.media_id = ${targetMediaId}
            )`;
        const listItemsRemoved = await tx.$executeRaw`
          DELETE FROM custom_list_items i
          WHERE i.media_id = ${sourceId}
            AND EXISTS (SELECT 1 FROM custom_lists l WHERE l.id = i.list_id AND l.user_id = ${userId})`;

        // comments: re-point only THIS user's — both movie-thread rows and movie attachments.
        const commentThreads = await tx.comment.updateMany({
          where: { userId, threadType: 'MOVIE', threadId: sourceId },
          data: { threadId: targetMediaId },
        });
        const commentAttachments = await tx.comment.updateMany({
          where: { userId, mediaType: MediaType.MOVIE, mediaId: sourceId },
          data: { mediaId: targetMediaId },
        });

        return {
          sourceId,
          targetMediaId,
          userMovieStatus: { moved: statusMoved, merged: statusMerged },
          watchHistory: { moved: historyMoved.count },
          ratings: { moved: ratingsMoved, merged: ratingsMerged, removed: ratingsRemoved },
          reactions: { moved: reactionsMoved, removed: reactionsRemoved },
          watchlistItems: { moved: watchlistMoved, removed: watchlistRemoved },
          favorites: { moved: favoritesMoved, removed: favoritesRemoved },
          customListItems: { moved: listItemsMoved, removed: listItemsRemoved },
          comments: { threads: commentThreads.count, attachments: commentAttachments.count },
        };
      },
      { timeout: 60_000 },
    );

    await this.stats.invalidate({ userId });
    return summary;
  }
}
