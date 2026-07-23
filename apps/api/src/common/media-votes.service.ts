import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class MediaVotesService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly RATING_OPTIONS = ['1', '2', '3', '4', '5'] as const;

  private buildRatingSection(counts: Map<string, number>, userVote: string | null) {
    const options = this.RATING_OPTIONS.map((value) => ({ value, count: counts.get(value) ?? 0 }));
    const total = options.reduce((acc, option) => acc + option.count, 0);
    const safeUserVote =
      userVote && (this.RATING_OPTIONS as readonly string[]).includes(userVote) ? userVote : null;
    return { userVote: safeUserVote, total, options };
  }

  private async requireMedia(mediaId: string, type: 'SHOW' | 'MOVIE') {
    const media = await this.prisma.mediaItem.findFirst({ where: { id: mediaId, type } });
    if (!media) throw new NotFoundException(`${type === 'MOVIE' ? 'Movie' : 'Show'} not found`);
    return media;
  }

  private async requireWatchedMovie(userId: string, mediaId: string) {
    await this.requireMedia(mediaId, 'MOVIE');
    const status = await this.prisma.userMovieStatus.findUnique({
      where: { userId_mediaId: { userId, mediaId } },
    });
    if (!status?.watched) throw new NotFoundException('Movie not tracked - mark as watched first');
  }

  async getMovieInteractions(mediaId: string, userId?: string) {
    return { rating: await this.getMediaRatingSection(mediaId, userId) };
  }

  async getShowInteractions(mediaId: string, userId?: string) {
    return { rating: await this.getMediaRatingSection(mediaId, userId) };
  }

  private async getMediaRatingSection(mediaId: string, userId?: string) {
    const userRating = userId
      ? await this.prisma.rating.findUnique({ where: { userId_mediaId: { userId, mediaId } } })
      : null;
    const groups = await this.prisma.rating.groupBy({
      by: ['rating'],
      where: { mediaId },
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const group of groups) counts.set(String(group.rating), group._count._all);
    return this.buildRatingSection(counts, userRating ? String(userRating.rating) : null);
  }

  async voteMovieRating(userId: string, mediaId: string, value: number) {
    await this.requireWatchedMovie(userId, mediaId);
    await this.upsertMediaRating(userId, mediaId, value);
    return this.getMediaRatingSection(mediaId, userId);
  }

  async voteShowRating(userId: string, mediaId: string, value: number) {
    await this.requireMedia(mediaId, 'SHOW');
    await this.upsertMediaRating(userId, mediaId, value);
    return this.getMediaRatingSection(mediaId, userId);
  }

  private async upsertMediaRating(userId: string, mediaId: string, value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new BadRequestException('Rating must be an integer between 1 and 5');
    }
    await this.prisma.rating.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, rating: value },
      update: { rating: value },
    });
  }
}
