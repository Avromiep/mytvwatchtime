import { Injectable, Logger } from '@nestjs/common';
import { StructureProvider, StructureReason } from '@prisma/client';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { TmdbProvider, TmdbShowRoutingProfile } from './providers/tmdb.provider';

export const STRUCTURE_RULE_VERSION = 1;

export type ShowWriteScope =
  'STRUCTURE' | 'STRUCTURE_REMAP' | 'METADATA_ONLY' | 'CAST_ONLY' | 'ARTWORK_ONLY';

export interface StructureDecision {
  provider: StructureProvider;
  reason: StructureReason;
  ruleVersion: number;
  decidedAt: Date;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  profile?: TmdbShowRoutingProfile;
}

/** The sole automatic anime rule: TMDB genre 16 (Animation) AND keyword `anime`. */
export function isStrictTmdbAnime(genreIds: number[], keywords: string[]): boolean {
  return (
    genreIds.includes(16) && keywords.some((keyword) => keyword.trim().toLowerCase() === 'anime')
  );
}

@Injectable()
export class StructureAuthorityService {
  private readonly logger = new Logger(StructureAuthorityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbProvider,
  ) {}

  async persisted(mediaId: string): Promise<StructureDecision | null> {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: {
        metadataProvenance: true,
        show: {
          select: {
            structureProvider: true,
            structureReason: true,
            structureRuleVersion: true,
            structureDecidedAt: true,
          },
        },
      },
    });
    const show = media?.show;
    if (show?.structureProvider && show.structureReason) {
      return {
        provider: show.structureProvider,
        reason: show.structureReason,
        ruleVersion: show.structureRuleVersion ?? STRUCTURE_RULE_VERSION,
        decidedAt: show.structureDecidedAt ?? new Date(0),
      };
    }

    // Compatibility only. New writes always persist typed authority. A legacy stamp is
    // used when TMDB cannot be consulted, never as stronger evidence than a routing profile.
    const legacy = media?.metadataProvenance as Record<string, unknown> | null;
    const value = legacy?.structureProvider;
    if (value === 'tmdb' || value === 'tvdb') {
      return {
        provider: value === 'tvdb' ? StructureProvider.TVDB : StructureProvider.TMDB,
        reason:
          value === 'tvdb' ? StructureReason.TVDB_ONLY_FALLBACK : StructureReason.GENERAL_TMDB,
        ruleVersion: 0,
        decidedAt: new Date(0),
      };
    }
    return null;
  }

  async forTmdb(tmdbId: number, mediaId?: string): Promise<StructureDecision> {
    const existing = mediaId ? await this.persisted(mediaId) : null;
    if (existing?.reason === StructureReason.MANUAL_OVERRIDE) {
      return {
        ...existing,
        tmdbId,
        tvdbId: mediaId ? ((await this.tvdbIdFor(mediaId)) ?? undefined) : undefined,
      };
    }

    const profile = await this.tmdb.getShowRoutingProfile(tmdbId);
    const anime = isStrictTmdbAnime(profile.genreIds, profile.keywords);
    return {
      provider: anime ? StructureProvider.TVDB : StructureProvider.TMDB,
      reason: anime ? StructureReason.ANIME_TVDB : StructureReason.GENERAL_TMDB,
      ruleVersion: STRUCTURE_RULE_VERSION,
      decidedAt: new Date(),
      tmdbId: profile.tmdbId,
      tvdbId: profile.tvdbId ?? undefined,
      imdbId: profile.imdbId ?? undefined,
      profile,
    };
  }

  async forTvdb(tvdbId: number, mediaId?: string): Promise<StructureDecision> {
    const existing = mediaId ? await this.persisted(mediaId) : null;
    if (existing && existing.ruleVersion >= STRUCTURE_RULE_VERSION) {
      return {
        ...existing,
        tvdbId,
        tmdbId: mediaId ? ((await this.tmdbIdFor(mediaId)) ?? undefined) : undefined,
      };
    }

    if (this.tmdb.enabled) {
      const found = await this.tmdb.findByExternalId(String(tvdbId), 'tvdb_id');
      if (found?.show?.tmdbId) {
        return this.forTmdb(found.show.tmdbId, mediaId);
      }
    }

    if (existing) return existing;
    this.logger.debug(`TVDB ${tvdbId} has no verified TMDB series mapping; using locked fallback`);
    return {
      provider: StructureProvider.TVDB,
      reason: StructureReason.TVDB_ONLY_FALLBACK,
      ruleVersion: STRUCTURE_RULE_VERSION,
      decidedAt: new Date(),
      tvdbId,
    };
  }

  async tmdbIdFor(mediaId: string): Promise<number | null> {
    const ext = await this.prisma.externalId.findFirst({
      where: {
        mediaId,
        provider: ExternalProvider.TMDB,
        providerEntityKind: ProviderEntityKind.SERIES,
      },
      select: { value: true },
    });
    const value = Number(ext?.value);
    return Number.isFinite(value) ? value : null;
  }

  async tvdbIdFor(mediaId: string): Promise<number | null> {
    const ext = await this.prisma.externalId.findFirst({
      where: {
        mediaId,
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: ProviderEntityKind.SERIES,
      },
      select: { value: true },
    });
    const value = Number(ext?.value);
    return Number.isFinite(value) ? value : null;
  }
}
