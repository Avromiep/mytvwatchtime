import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CastMember, MediaType, Prisma } from '@prisma/client';
import {
  ExternalProvider,
  MediaType as SharedMediaType,
  PersonCreditDto,
  PersonCreditsPage,
  PersonCreditsSnapshot,
  PersonCreditSnapshotItem,
  PersonDetailResponse,
  tmdbCode,
} from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { TmdbClient } from '../media-metadata/providers/tmdb.client';
import { TmdbProvider, TmdbPersonPayload } from '../media-metadata/providers/tmdb.provider';
import {
  TvdbProvider,
  TvdbPersonPayload,
  TVDB_REMOTE_TYPE_TMDB,
} from '../media-metadata/providers/tvdb.provider';
import { TvdbClient } from '../media-metadata/providers/tvdb.client';
import { isProviderError } from '../media-metadata/providers/shared/provider-errors';
import { CastDedupService } from '../media-metadata/cast-dedup.service';
import {
  mergeLocaleTitles,
  normalizeTmdbCredits,
  normalizeTvdbCredits,
  sortCredits,
  tvdbBiography,
} from './normalized-person';

const DETAILS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CREDITS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Credits per rail on the detail response; the credits endpoint paginates the rest. */
const RAIL_LIMIT = 20;
const CREDITS_PAGE_SIZE = 24;

/** True when the stored externalId carries a TVDB people id under the TMDB_
 *  namespace (pre-namespace bug): the image gives it away even before a provider
 *  round-trip. */
function looksMisPrefixed(member: CastMember): boolean {
  return (
    /^TMDB_\d+$/.test(member.externalId ?? '') && (member.profileUrl ?? '').includes('thetvdb.com')
  );
}

@Injectable()
export class PeopleService {
  private readonly logger = new Logger(PeopleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbProvider,
    private readonly tmdbClient: TmdbClient,
    private readonly tvdb: TvdbProvider,
    private readonly tvdbClient: TvdbClient,
    private readonly castDedup: CastDedupService,
  ) {}

  async getPerson(id: string): Promise<PersonDetailResponse> {
    const locale = currentLanguage();
    const member = await this.loadAndSync(id, locale);
    const credits = await this.resolveCredits(member, locale);
    const movies = credits.filter((c) => c.type === SharedMediaType.MOVIE);
    const shows = credits.filter((c) => c.type === SharedMediaType.SHOW);
    return {
      person: this.toDetailDto(member, locale),
      movies: movies.slice(0, RAIL_LIMIT),
      shows: shows.slice(0, RAIL_LIMIT),
      movieCount: movies.length,
      showCount: shows.length,
    };
  }

  async getCredits(id: string, type: SharedMediaType, page = 1): Promise<PersonCreditsPage> {
    const locale = currentLanguage();
    const member = await this.loadAndSync(id, locale);
    const all = (await this.resolveCredits(member, locale)).filter((c) => c.type === type);
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / CREDITS_PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), totalPages);
    return {
      items: all.slice((safePage - 1) * CREDITS_PAGE_SIZE, safePage * CREDITS_PAGE_SIZE),
      page: safePage,
      totalPages,
      total,
    };
  }

  // ---------------------------------------------------------------------------

  /** Load the member, heal/resolve provider ids, merge duplicates, refresh cache. */
  private async loadAndSync(id: string, locale: string): Promise<CastMember> {
    let member = await this.prisma.castMember.findUnique({ where: { id } });
    if (!member) throw new NotFoundException('Person not found');
    try {
      member = await this.resolveIds(member);
      member = await this.mergeDuplicates(member);
      member = await this.syncPerson(member, locale);
    } catch (e) {
      // Provider failures never fail the page — serve whatever is cached.
      if (isProviderError(e)) {
        this.logger.warn(`person ${id}: provider sync skipped (${e.category}: ${e.message})`);
      } else {
        this.logger.warn(`person ${id}: sync failed (${(e as Error).message})`);
      }
    }
    return (await this.prisma.castMember.findUnique({ where: { id: member.id } })) ?? member;
  }

  /**
   * Populate tmdbId/tvdbId/imdbId from externalId, healing the legacy mis-prefix
   * (TMDB_<tvdbPeopleId>): TVDB remoteIds type 15 cross-links the real TMDB id.
   * Idempotent — members with resolved ids skip straight through.
   */
  private async resolveIds(member: CastMember): Promise<CastMember> {
    if (member.tmdbId != null && member.tvdbId != null) return member;
    const ext = member.externalId ?? '';
    const tmdbMatch = /^TMDB_(\d+)$/.exec(ext);
    const tvdbMatch = /^TVDB_(\d+)$/.exec(ext);
    // Fallback-scoped ids (TVDB_<id>_CHAR_/NAME_) carry no global person id.
    if (!tmdbMatch && !tvdbMatch) return member;

    let tmdbId = member.tmdbId;
    let tvdbId = member.tvdbId ?? (tvdbMatch ? Number(tvdbMatch[1]) : null);
    let imdbId = member.imdbId;
    const misPrefixed = looksMisPrefixed(member);

    if (tvdbId == null && tmdbMatch && misPrefixed && this.tvdb.enabled) {
      tvdbId = Number(tmdbMatch[1]); // legacy row: the digits are a TVDB people id
      tmdbId = null;
    }

    // TVDB side first when we have a tvdbId: one extended call cross-links TMDB+IMDB.
    if (tvdbId != null && (tmdbId == null || imdbId == null) && this.tvdb.enabled) {
      const p = await this.tvdb.getPersonExtended(tvdbId);
      if (p) {
        const tmdbRemote = (p.remoteIds ?? []).find((r) => r.type === TVDB_REMOTE_TYPE_TMDB);
        const imdbRemote = (p.remoteIds ?? []).find(
          (r) => (r.sourceName ?? '').toUpperCase() === 'IMDB',
        );
        if (tmdbId == null && tmdbRemote && /^\d+$/.test(tmdbRemote.id)) {
          tmdbId = Number(tmdbRemote.id);
        }
        imdbId = imdbId ?? imdbRemote?.id ?? null;
      }
    }
    if (tmdbId == null && tmdbMatch && !misPrefixed) {
      // Trust the namespace — a TMDB 404 here means the id died at the source OR is a
      // mis-prefixed TVDB id without the image tell; try TVDB with the same digits.
      const candidate = Number(tmdbMatch[1]);
      if (this.tmdb.enabled) {
        try {
          await this.tmdb.getPerson(candidate, 'en-US');
          tmdbId = candidate;
        } catch (e) {
          if (isProviderError(e) && e.notFound && this.tvdb.enabled) {
            const p = await this.tvdb.getPersonExtended(candidate);
            if (p) {
              tvdbId = candidate;
              const tmdbRemote = (p.remoteIds ?? []).find(
                (r) => r.type === TVDB_REMOTE_TYPE_TMDB && /^\d+$/.test(r.id),
              );
              tmdbId = tmdbRemote ? Number(tmdbRemote.id) : null;
              imdbId =
                imdbId ??
                (p.remoteIds ?? []).find((r) => (r.sourceName ?? '').toUpperCase() === 'IMDB')
                  ?.id ??
                null;
            }
          } else {
            throw e;
          }
        }
      } else {
        tmdbId = candidate; // no way to verify; namespace is authoritative
      }
    }

    if (tmdbId === member.tmdbId && tvdbId === member.tvdbId && imdbId === member.imdbId) {
      return member;
    }
    this.logger.log(
      `person ${member.id} (${member.name}): resolved ids tmdb=${tmdbId} tvdb=${tvdbId} imdb=${imdbId} (externalId=${ext})`,
    );
    return this.prisma.castMember.update({
      where: { id: member.id },
      data: { tmdbId, tvdbId, imdbId },
    });
  }

  /**
   * Merge every OTHER cast member sharing this member's resolved TMDB id into one
   * canonical row (the legacy mis-prefixed duplicate case). Canonical = the member
   * whose externalId is the true TMDB_ key, else the one with the most credits.
   * media_cast rows are repointed (conflicts merged via CastDedupService, votes
   * preserved); empty duplicates are deleted.
   */
  private async mergeDuplicates(member: CastMember): Promise<CastMember> {
    if (member.tmdbId == null) return member;
    const others = await this.prisma.castMember.findMany({
      where: {
        id: { not: member.id },
        OR: [{ tmdbId: member.tmdbId }, { externalId: `TMDB_${member.tmdbId}` }],
      },
      include: { _count: { select: { mediaCast: true } } },
    });
    if (!others.length) return member;

    const self = await this.prisma.castMember.findUnique({
      where: { id: member.id },
      include: { _count: { select: { mediaCast: true } } },
    });
    if (!self) throw new NotFoundException('Person not found');
    const candidates = [self, ...others];
    const canonical =
      candidates.find((c) => c.externalId === `TMDB_${member.tmdbId}`) ??
      [...candidates].sort((a, b) => b._count.mediaCast - a._count.mediaCast)[0];
    const dups = candidates.filter((c) => c.id !== canonical.id);
    if (!dups.length) return canonical;

    // The canonical row may carry no provider ids of its own (e.g. it was keyed by
    // externalId only) — without this fill the ids resolved on the clicked row would
    // die with the deleted dup and the credits sync below would silently skip.
    const fill: Prisma.CastMemberUpdateInput = {};
    if (canonical.tmdbId == null && member.tmdbId != null) fill.tmdbId = member.tmdbId;
    if (canonical.tvdbId == null && member.tvdbId != null) fill.tvdbId = member.tvdbId;
    if (canonical.imdbId == null && member.imdbId != null) fill.imdbId = member.imdbId;
    if (Object.keys(fill).length) {
      await this.prisma.castMember.update({ where: { id: canonical.id }, data: fill });
    }

    for (const dup of dups) {
      this.logger.log(
        `person merge: ${dup.id} (${dup.externalId ?? 'no-ext'}, ${dup._count.mediaCast} credits) -> ${canonical.id} (${canonical.externalId ?? 'no-ext'})`,
      );
      const rows = await this.prisma.mediaCast.findMany({
        where: { castMemberId: dup.id },
        select: { id: true, mediaId: true },
      });
      for (const row of rows) {
        await this.prisma.$transaction(async (tx) => {
          const existing = await tx.mediaCast.findUnique({
            where: {
              mediaId_castMemberId: { mediaId: row.mediaId, castMemberId: canonical.id },
            },
            select: { id: true },
          });
          if (!existing) {
            await tx.mediaCast.update({
              where: { id: row.id },
              data: { castMemberId: canonical.id },
            });
            return;
          }
          const group = await tx.mediaCast.findMany({
            where: { mediaId: row.mediaId, castMemberId: { in: [canonical.id, dup.id] } },
            include: {
              castMember: { select: { id: true, name: true, externalId: true } },
              _count: { select: { characterVotes: true } },
            },
          });
          const title =
            (
              await tx.mediaItem.findUnique({
                where: { id: row.mediaId },
                select: { title: true },
              })
            )?.title ?? row.mediaId;
          await this.castDedup.mergeCastGroupTx(tx, row.mediaId, title, group, existing.id);
        });
      }
      await this.prisma.castMember.delete({ where: { id: dup.id } }).catch(() => undefined);
    }
    const fresh = await this.prisma.castMember.findUnique({ where: { id: canonical.id } });
    return fresh ?? canonical;
  }

  // ---------------------------------------------------------------------------

  private async syncPerson(member: CastMember, locale: string): Promise<CastMember> {
    const attempted = this.localesAttempted(member);
    const detailsStale =
      !member.detailsSyncedAt || Date.now() - member.detailsSyncedAt.getTime() > DETAILS_TTL_MS;
    const creditsStale =
      !member.creditsSyncedAt || Date.now() - member.creditsSyncedAt.getTime() > CREDITS_TTL_MS;
    const needLocale = !attempted.has(locale);
    if (!detailsStale && !creditsStale && !needLocale) return member;

    if (member.tmdbId != null && this.tmdb.enabled) {
      return this.syncFromTmdb(member, locale, { detailsStale, creditsStale, needLocale });
    }
    if (member.tvdbId != null && this.tvdb.enabled) {
      return this.syncFromTvdb(member, locale);
    }
    return member;
  }

  private async syncFromTmdb(
    member: CastMember,
    locale: string,
    flags: { detailsStale: boolean; creditsStale: boolean; needLocale: boolean },
  ): Promise<CastMember> {
    const fetchBase = flags.detailsStale || flags.creditsStale || !member.detailsSyncedAt;
    const fetchLocale =
      locale !== 'en' && (flags.needLocale || flags.detailsStale || flags.creditsStale);
    if (!fetchBase && !fetchLocale) return member;

    const attempted = this.localesAttempted(member);
    const base: TmdbPersonPayload | null = fetchBase
      ? await this.tmdb.getPerson(member.tmdbId!, 'en-US')
      : null;
    const loc: TmdbPersonPayload | null = fetchLocale
      ? await this.tmdb.getPerson(member.tmdbId!, tmdbCode(locale))
      : null;
    const now = new Date();
    const names = { ...((member.names as Record<string, string> | null) ?? {}) };
    const bios = { ...((member.biographies as Record<string, string> | null) ?? {}) };

    let credits = this.parseCredits(member.credits);
    if (loc) {
      if (loc.name && loc.name !== (base?.name ?? member.name)) names[locale] = loc.name;
      const baseBio = base?.biography ?? member.biography;
      if (loc.biography && loc.biography !== baseBio) bios[locale] = loc.biography;
      if (credits) {
        const locItems = normalizeTmdbCredits(loc, (p, s) => this.tmdbClient.img(p, s));
        credits = {
          items: credits.items,
          locales: mergeLocaleTitles(credits, locale, locItems),
        };
      }
      attempted.add(locale);
    }
    if (base) {
      credits = {
        items: normalizeTmdbCredits(base, (p, s) => this.tmdbClient.img(p, s)),
        locales: credits?.locales ?? {},
      };
      attempted.add('en');
    }

    return this.prisma.castMember.update({
      where: { id: member.id },
      data: {
        ...(base
          ? {
              name: base.name || member.name,
              biography: base.biography || null,
              birthDate: this.parseDate(base.birthday),
              deathDate: this.parseDate(base.deathday),
              birthPlace: base.place_of_birth || null,
              profileUrl: this.tmdbClient.img(base.profile_path, 'w185') ?? member.profileUrl,
              imdbId: base.external_ids?.imdb_id ?? member.imdbId,
            }
          : {}),
        names,
        biographies: bios,
        detailsLocales: [...attempted],
        ...(credits ? { credits: credits as unknown as Prisma.InputJsonValue } : {}),
        detailsSyncedAt: base || loc ? now : member.detailsSyncedAt,
        creditsSyncedAt: base || loc ? now : member.creditsSyncedAt,
      },
    });
  }

  private async syncFromTvdb(member: CastMember, locale: string): Promise<CastMember> {
    const p: TvdbPersonPayload | null = await this.tvdb.getPersonExtended(member.tvdbId!);
    if (!p) return member;
    const attempted = this.localesAttempted(member).add(locale).add('en');
    const names = { ...((member.names as Record<string, string> | null) ?? {}) };
    const bios = { ...((member.biographies as Record<string, string> | null) ?? {}) };
    const baseBio = tvdbBiography(p, 'en');
    if (locale !== 'en') {
      const locBio = tvdbBiography(p, locale);
      if (locBio && locBio !== baseBio) bios[locale] = locBio;
    }
    const imdbRemote = (p.remoteIds ?? []).find(
      (r) => (r.sourceName ?? '').toUpperCase() === 'IMDB',
    );
    return this.prisma.castMember.update({
      where: { id: member.id },
      data: {
        name: p.name || member.name,
        biography: baseBio,
        birthDate: this.parseDate(p.birth),
        deathDate: this.parseDate(p.death),
        birthPlace: p.birthPlace || null,
        profileUrl: this.tvdbClient.artwork(p.image) ?? member.profileUrl,
        imdbId: member.imdbId ?? imdbRemote?.id ?? null,
        names,
        biographies: bios,
        detailsLocales: [...attempted],
        credits: {
          items: normalizeTvdbCredits(p, (path) => this.tvdbClient.artwork(path)),
          locales: this.parseCredits(member.credits)?.locales ?? {},
        } as unknown as Prisma.InputJsonValue,
        detailsSyncedAt: new Date(),
        creditsSyncedAt: new Date(),
      },
    });
  }

  // ---------------------------------------------------------------------------

  /** Snapshot → DTOs with internal-media linkage + locale overlays. */
  private async resolveCredits(member: CastMember, locale: string): Promise<PersonCreditDto[]> {
    const snapshot = this.parseCredits(member.credits);
    if (!snapshot?.items.length) return [];
    const items = sortCredits(snapshot.items);

    const tmdbIds = items.filter((i) => i.tmdbId != null).map((i) => String(i.tmdbId));
    const tvdbIds = items.filter((i) => i.tvdbId != null).map((i) => String(i.tvdbId));
    const externals = await this.prisma.externalId.findMany({
      where: {
        OR: [
          { provider: ExternalProvider.TMDB, value: { in: tmdbIds } },
          { provider: ExternalProvider.THE_TVDB, value: { in: tvdbIds } },
        ],
      },
      select: { provider: true, value: true, mediaId: true },
    });
    const byCreditKey = new Map<string, string>();
    for (const e of externals) {
      const prefix = e.provider === ExternalProvider.TMDB ? 'tmdb' : 'tvdb';
      for (const suffix of ['MOVIE', 'SHOW'] as const) {
        const key = `${prefix}:${e.value}:${suffix}`;
        if (!byCreditKey.has(key)) byCreditKey.set(key, e.mediaId);
      }
    }
    const mediaIds = [...new Set(externals.map((e) => e.mediaId))];
    const mediaRows = mediaIds.length
      ? await this.prisma.mediaItem.findMany({
          where: { id: { in: mediaIds } },
          select: { id: true, type: true, posterUrl: true, posterUrls: true, titles: true },
        })
      : [];
    const mediaById = new Map(mediaRows.map((m) => [m.id, m]));

    return items.map((item) => this.creditToDto(item, snapshot, byCreditKey, mediaById, locale));
  }

  private creditToDto(
    item: PersonCreditSnapshotItem,
    snapshot: PersonCreditsSnapshot,
    byCreditKey: Map<string, string>,
    mediaById: Map<
      string,
      {
        id: string;
        type: MediaType;
        posterUrl: string | null;
        posterUrls: unknown;
        titles: unknown;
      }
    >,
    locale: string,
  ): PersonCreditDto {
    const linkedId = byCreditKey.get(item.key) ?? null;
    const media = linkedId ? mediaById.get(linkedId) : undefined;
    // A cross-kind link (TVDB series id on a MOVIE row etc.) is never trusted.
    const resolved = media && media.type === item.type ? media : undefined;
    const localizedMediaTitle =
      locale !== 'en' && resolved
        ? (resolved.titles as Record<string, string> | null)?.[locale]
        : undefined;
    const localizedPoster =
      locale !== 'en' && resolved
        ? (resolved.posterUrls as Record<string, string | null> | null)?.[locale]
        : undefined;
    const tmdbId = item.tmdbId ?? null;
    return {
      mediaId: resolved?.id ?? null,
      tmdbId,
      type: item.type,
      title: localizedMediaTitle ?? snapshot.locales[locale]?.[item.key] ?? item.title,
      posterUrl: localizedPoster ?? resolved?.posterUrl ?? item.posterUrl ?? null,
      year: item.year ?? null,
      character: item.character ?? null,
    };
  }

  private toDetailDto(member: CastMember, locale: string): PersonDetailResponse['person'] {
    const names = (member.names as Record<string, string> | null) ?? {};
    const bios = (member.biographies as Record<string, string> | null) ?? {};
    return {
      id: member.id,
      name: names[locale] ?? member.name,
      profileUrl: member.profileUrl,
      birthDate: this.formatDate(member.birthDate),
      deathDate: this.formatDate(member.deathDate),
      birthPlace: member.birthPlace,
      biography: bios[locale] ?? member.biography,
      imdbId: member.imdbId,
      detailsAvailable: member.detailsSyncedAt != null,
    };
  }

  // ---------------------------------------------------------------------------

  private localesAttempted(member: CastMember): Set<string> {
    const raw = member.detailsLocales;
    return new Set(Array.isArray(raw) ? (raw as string[]) : []);
  }

  private parseCredits(raw: unknown): PersonCreditsSnapshot | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const s = raw as PersonCreditsSnapshot;
    if (!Array.isArray(s.items)) return null;
    return { items: s.items, locales: s.locales ?? {} };
  }

  private parseDate(value?: string | null): Date | null {
    if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private formatDate(value: Date | null): string | null {
    return value ? value.toISOString().slice(0, 10) : null;
  }
}
