import { MediaType } from './enums';

/**
 * Person (cast member) details page DTOs. The API caches provider person data on
 * CastMember (English base columns + per-locale JSON overrides) so these endpoints
 * don't hit TMDB/TVDB per view.
 */

export interface PersonDetailDto {
  /** Internal CastMember id (cuid) — the route id. */
  id: string;
  name: string;
  profileUrl?: string | null;
  /** ISO date (YYYY-MM-DD) or null. */
  birthDate?: string | null;
  deathDate?: string | null;
  birthPlace?: string | null;
  biography?: string | null;
  imdbId?: string | null;
  /** False while only a provider id is known but details failed to load. */
  detailsAvailable: boolean;
}

/**
 * One acting credit on the person page. `mediaId` is set when the credit resolves
 * to an existing MediaItem via ExternalId (open the internal route directly);
 * otherwise `tmdbId` drives the numeric-TMDB-id route which hydrates on demand.
 */
export interface PersonCreditDto {
  mediaId: string | null;
  tmdbId: number | null;
  type: MediaType;
  title: string;
  posterUrl?: string | null;
  year?: number | null;
  character?: string | null;
  /** Provider vote average (1..10): the linked MediaItem's rating wins; credits
   *  without an internal item fall back to the snapshot's provider vote_average
   *  (TMDB only, present after the person's next credits re-sync). */
  rating?: number | null;
}

export interface PersonDetailResponse {
  person: PersonDetailDto;
  movies: PersonCreditDto[];
  shows: PersonCreditDto[];
  /** Total counts (rails are capped; "See all" paginates via /people/:id/credits). */
  movieCount: number;
  showCount: number;
}

export interface PersonCreditsPage {
  items: PersonCreditDto[];
  page: number;
  totalPages: number;
  total: number;
}

/** Stored snapshot shape (CastMember.credits JSON). */
export interface PersonCreditSnapshotItem {
  /** 'tmdb:<id>' | 'tvdb:<id>' — dedupe + locale-title key. */
  key: string;
  tmdbId?: number;
  tvdbId?: number;
  type: MediaType;
  /** English base title. */
  title: string;
  posterUrl?: string | null;
  year?: number | null;
  character?: string | null;
  /** Provider vote average (1..10) captured at sync time — TMDB combined_credits
   *  only (TVDB person payloads carry none). Fallback rating when the credit
   *  doesn't resolve to an internal MediaItem. Absent in pre-rating snapshots. */
  rating?: number | null;
}

export interface PersonCreditsSnapshot {
  items: PersonCreditSnapshotItem[];
  /** locale -> credit key -> localized title (empty when provider lacks the locale). */
  locales: Record<string, Record<string, string>>;
}
