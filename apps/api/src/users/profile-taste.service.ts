import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MediaType, ReactionType } from '@prisma/client';
import type {
  MediaCardLiteDto,
  ProfileTasteDto,
  ProfileTasteGenreDto,
  TasteEndorsementSignal,
  TasteRecommendationDto,
} from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { DiscoveryService } from '../media-metadata/discovery.service';
import { StatsService } from '../stats/stats.service';

const POSITIVE_REACTIONS: ReactionType[] = [
  ReactionType.TOUCHED,
  ReactionType.AMUSED,
  ReactionType.THRILLED,
  ReactionType.UNDERSTANDING,
];

type Candidate = {
  mediaId: string;
  score: number;
  lastAt: Date;
  signals: Set<TasteEndorsementSignal>;
};

@Injectable()
export class ProfileTasteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly discovery: DiscoveryService,
    private readonly stats: StatsService,
  ) {}

  private async targetForViewer(username: string, viewerId: string) {
    const target = await this.prisma.user.findFirst({
      where: { username: username.trim() },
      select: { id: true, profile: { select: { isPrivate: true } } },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.profile?.isPrivate && viewerId !== target.id) {
      const following = await this.prisma.follow.findUnique({
        where: { followerId_targetId: { followerId: viewerId, targetId: target.id } },
        select: { followerId: true },
      });
      if (!following) throw new ForbiddenException('This profile is private');
    }
    const blocked = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: target.id },
          { blockerId: target.id, blockedId: viewerId },
        ],
      },
      select: { id: true },
    });
    if (blocked) throw new ForbiddenException('Profile unavailable');
    return target.id;
  }

  private async genreRows(userId: string) {
    const [show, movie] = await Promise.all([
      this.stats.getShowStats(userId),
      this.stats.getMovieStats(userId),
    ]);
    const names = [...new Set([...show.topGenres, ...movie.topGenres].map((g) => g.name))];
    const genres = names.length
      ? await this.prisma.genre.findMany({ where: { name: { in: names } } })
      : [];
    const byName = new Map(genres.map((g) => [g.name, g]));
    const map = (rows: { name: string; count: number }[]): ProfileTasteGenreDto[] =>
      rows.slice(0, 8).flatMap((row) => {
        const genre = byName.get(row.name);
        return genre
          ? [{ id: genre.id, name: genre.name, slug: genre.slug, count: row.count }]
          : [];
      });
    return { shows: map(show.topGenres), movies: map(movie.topGenres) };
  }

  async favorites(username: string, viewerId: string, type: MediaType, page = 1, pageSize = 20) {
    const targetId = await this.targetForViewer(username, viewerId);
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safePageSize = Math.min(60, Math.max(1, Math.floor(pageSize) || 20));
    const where = { userId: targetId, media: { type } };
    const [rows, total] = await Promise.all([
      this.prisma.favorite.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        select: { mediaId: true },
      }),
      this.prisma.favorite.count({ where }),
    ]);
    const items = await this.discovery.fetchCardDtos(
      rows.map((row) => row.mediaId),
      viewerId,
      safePageSize,
    );
    return {
      items,
      page: safePage,
      pageSize: safePageSize,
      total,
      hasMore: safePage * safePageSize < total,
    };
  }

  async recommendations(
    username: string,
    viewerId: string,
    page = 1,
    pageSize = 30,
    type?: MediaType,
  ) {
    const targetId = await this.targetForViewer(username, viewerId);
    if (targetId === viewerId) {
      return { items: [], page: 1, pageSize, total: 0, hasMore: false };
    }
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safePageSize = Math.min(60, Math.max(1, Math.floor(pageSize) || 30));
    const [targetFavorites, directRatings, episodeRatings, directReactions, episodeReactions] =
      await Promise.all([
        this.prisma.favorite.findMany({
          where: { userId: targetId },
          select: { mediaId: true, createdAt: true },
        }),
        this.prisma.rating.findMany({
          where: { userId: targetId, mediaId: { not: null }, rating: { gte: 4 } },
          select: { mediaId: true, rating: true, updatedAt: true },
        }),
        this.prisma.rating.findMany({
          where: { userId: targetId, episodeId: { not: null }, rating: { gte: 4 } },
          select: {
            rating: true,
            updatedAt: true,
            episode: { select: { season: { select: { show: { select: { mediaId: true } } } } } },
          },
        }),
        this.prisma.reaction.findMany({
          where: { userId: targetId, mediaId: { not: null }, reaction: { in: POSITIVE_REACTIONS } },
          select: { mediaId: true, createdAt: true },
        }),
        this.prisma.reaction.findMany({
          where: {
            userId: targetId,
            episodeId: { not: null },
            reaction: { in: POSITIVE_REACTIONS },
          },
          select: {
            createdAt: true,
            episode: { select: { season: { select: { show: { select: { mediaId: true } } } } } },
          },
        }),
      ]);

    const candidates = new Map<string, Candidate>();
    const add = (
      mediaId: string | null | undefined,
      points: number,
      at: Date,
      signal: TasteEndorsementSignal,
    ) => {
      if (!mediaId) return;
      const value = candidates.get(mediaId) ?? {
        mediaId,
        score: 0,
        lastAt: at,
        signals: new Set(),
      };
      value.score += points;
      if (at > value.lastAt) value.lastAt = at;
      value.signals.add(signal);
      candidates.set(mediaId, value);
    };
    targetFavorites.forEach((row) => add(row.mediaId, 6, row.createdAt, 'FAVORITE'));
    directRatings.forEach((row) => add(row.mediaId, row.rating, row.updatedAt, 'HIGH_RATING'));
    const episodeRatingPoints = new Map<string, number>();
    episodeRatings.forEach((row) => {
      const mediaId = row.episode?.season.show.mediaId;
      if (!mediaId) return;
      const current = episodeRatingPoints.get(mediaId) ?? 0;
      const points = Math.min(6, current + row.rating - 3) - current;
      episodeRatingPoints.set(mediaId, current + points);
      add(mediaId, points, row.updatedAt, 'HIGH_RATING');
    });
    const reactionPoints = new Map<string, number>();
    [
      ...directReactions.map((r) => ({ ...r, resolvedId: r.mediaId })),
      ...episodeReactions.map((r) => ({ ...r, resolvedId: r.episode?.season.show.mediaId })),
    ].forEach((row) => {
      if (!row.resolvedId) return;
      const current = reactionPoints.get(row.resolvedId) ?? 0;
      if (current >= 4) return;
      reactionPoints.set(row.resolvedId, current + 1);
      add(row.resolvedId, 1, row.createdAt, 'POSITIVE_REACTION');
    });

    const candidateIds = [...candidates.keys()];
    if (!candidateIds.length)
      return { items: [], page: safePage, pageSize: safePageSize, total: 0, hasMore: false };
    const [media, viewerWatchlist, viewerFavorites, viewerHistory, viewerGenres] =
      await Promise.all([
        this.prisma.mediaItem.findMany({
          where: { id: { in: candidateIds }, ...(type ? { type } : {}) },
          select: { id: true, type: true, genres: { select: { genre: true } } },
        }),
        this.prisma.watchlistItem.findMany({
          where: { userId: viewerId },
          select: { mediaId: true },
        }),
        this.prisma.favorite.findMany({ where: { userId: viewerId }, select: { mediaId: true } }),
        this.prisma.watchHistory.findMany({
          where: { userId: viewerId },
          distinct: ['mediaId'],
          select: { mediaId: true },
        }),
        this.genreRows(viewerId),
      ]);
    const excluded = new Set([
      ...viewerWatchlist.map((r) => r.mediaId),
      ...viewerFavorites.map((r) => r.mediaId),
      ...viewerHistory.map((r) => r.mediaId),
    ]);
    const ranked = media.flatMap((row) => {
      if (excluded.has(row.id)) return [];
      const affinity = row.type === MediaType.SHOW ? viewerGenres.shows : viewerGenres.movies;
      const rankByGenre = new Map(affinity.map((g, index) => [g.id, index + 1]));
      const matched = row.genres.flatMap(({ genre }) => {
        const rank = rankByGenre.get(genre.id);
        return rank ? [{ id: genre.id, name: genre.name, slug: genre.slug, count: 0, rank }] : [];
      });
      if (affinity.length && !matched.length) return [];
      const candidate = candidates.get(row.id)!;
      candidate.score += matched.reduce((sum, genre) => sum + (9 - genre.rank), 0);
      return [{ candidate, matchedGenres: matched.map(({ rank: _rank, ...genre }) => genre) }];
    });
    ranked.sort(
      (a, b) =>
        b.candidate.score - a.candidate.score ||
        b.candidate.lastAt.getTime() - a.candidate.lastAt.getTime() ||
        a.candidate.mediaId.localeCompare(b.candidate.mediaId),
    );
    const pageRows = ranked.slice((safePage - 1) * safePageSize, safePage * safePageSize);
    const cards = await this.discovery.fetchCardDtos(
      pageRows.map((row) => row.candidate.mediaId),
      viewerId,
      safePageSize,
    );
    const extraById = new Map(pageRows.map((row) => [row.candidate.mediaId, row]));
    const items: TasteRecommendationDto[] = cards.map((card) => {
      const extra = extraById.get(card.id)!;
      return { ...card, matchedGenres: extra.matchedGenres, signals: [...extra.candidate.signals] };
    });
    return {
      items,
      page: safePage,
      pageSize: safePageSize,
      total: ranked.length,
      hasMore: safePage * safePageSize < ranked.length,
    };
  }

  async taste(username: string, viewerId: string): Promise<ProfileTasteDto> {
    const targetId = await this.targetForViewer(username, viewerId);
    const [targetGenres, viewerGenres, recommendations, favoriteShows, favoriteMovies] =
      await Promise.all([
        this.genreRows(targetId),
        targetId === viewerId
          ? Promise.resolve({ shows: [], movies: [] })
          : this.genreRows(viewerId),
        this.recommendations(username, viewerId, 1, 12),
        this.favorites(username, viewerId, MediaType.SHOW, 1, 12),
        this.favorites(username, viewerId, MediaType.MOVIE, 1, 12),
      ]);
    const viewerById = new Map(
      [...viewerGenres.shows, ...viewerGenres.movies].map((g) => [g.id, g]),
    );
    const commonGenres = [...targetGenres.shows, ...targetGenres.movies]
      .filter(
        (genre, index, rows) =>
          viewerById.has(genre.id) && rows.findIndex((g) => g.id === genre.id) === index,
      )
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((genre) => ({ ...genre, viewerCount: viewerById.get(genre.id)?.count }));
    return {
      topGenres: targetGenres,
      commonGenres,
      recommendations: { items: recommendations.items, total: recommendations.total },
      favoriteShows: {
        items: favoriteShows.items as MediaCardLiteDto[],
        total: favoriteShows.total,
      },
      favoriteMovies: {
        items: favoriteMovies.items as MediaCardLiteDto[],
        total: favoriteMovies.total,
      },
    };
  }
}
