import {
  ONBOARDING_VERSION,
  OnboardingApplyDto,
  OnboardingStatus,
} from '@tvwatch/shared';

/**
 * Pure quick-setup draft logic — NO React Native imports so this runs under the
 * mobile Jest config (same constraint as watch-next-optimistic.spec.ts).
 * The React hook + AsyncStorage persistence live in useOnboardingDraft.ts.
 */

export type OnboardingMode = 'WATCHED' | 'WATCHLIST';

export type DraftShowAction = 'CAUGHT_UP' | 'WATCHED_THROUGH' | 'WATCHLIST';
export type DraftMovieAction = 'WATCHED' | 'WATCHLIST';

export interface DraftShow {
  action: DraftShowAction;
  throughSeasonNumber?: number;
  throughEpisodeNumber?: number;
  /** Pre-rendered "S2 E14" label so the review screens don't need episode data. */
  throughLabel?: string;
}

export interface DraftMovie {
  action: DraftMovieAction;
}

export interface DraftMeta {
  title: string;
  poster?: string | null;
  year?: number | null;
  type: 'SHOW' | 'MOVIE';
}

export interface OnboardingDraft {
  shows: Record<string, DraftShow>;
  movies: Record<string, DraftMovie>;
  meta: Record<string, DraftMeta>;
}

export const emptyDraft = (): OnboardingDraft => ({ shows: {}, movies: {}, meta: {} });

export type DraftAction =
  | { type: 'toggle'; id: string; mediaType: 'SHOW' | 'MOVIE'; mode: OnboardingMode; meta: DraftMeta }
  | { type: 'setShowAction'; id: string; action: 'CAUGHT_UP' | 'WATCHLIST' }
  | { type: 'setThrough'; id: string; seasonNumber: number; episodeNumber: number; label: string }
  | { type: 'remove'; id: string; mediaType: 'SHOW' | 'MOVIE' }
  | { type: 'clear' }
  | { type: 'hydrate'; draft: OnboardingDraft };

export function draftReducer(state: OnboardingDraft, action: DraftAction): OnboardingDraft {
  switch (action.type) {
    case 'toggle': {
      const bucket = action.mediaType === 'SHOW' ? 'shows' : 'movies';
      if (state[bucket][action.id]) {
        const next = { ...state, [bucket]: { ...state[bucket] } };
        delete next[bucket][action.id];
        return next;
      }
      const entry =
        action.mediaType === 'SHOW'
          ? ({ action: action.mode === 'WATCHED' ? 'CAUGHT_UP' : 'WATCHLIST' } satisfies DraftShow)
          : ({ action: action.mode } satisfies DraftMovie);
      return {
        ...state,
        [bucket]: { ...state[bucket], [action.id]: entry },
        meta: { ...state.meta, [action.id]: action.meta },
      };
    }
    case 'setShowAction': {
      const existing = state.shows[action.id];
      if (!existing) return state;
      // Switching rules clears any stale watched-through boundary.
      return {
        ...state,
        shows: {
          ...state.shows,
          [action.id]: { action: action.action },
        },
      };
    }
    case 'setThrough': {
      const existing = state.shows[action.id];
      if (!existing) return state;
      return {
        ...state,
        shows: {
          ...state.shows,
          [action.id]: {
            action: 'WATCHED_THROUGH',
            throughSeasonNumber: action.seasonNumber,
            throughEpisodeNumber: action.episodeNumber,
            throughLabel: action.label,
          },
        },
      };
    }
    case 'remove': {
      const bucket = action.mediaType === 'SHOW' ? 'shows' : 'movies';
      if (!state[bucket][action.id]) return state;
      const next = { ...state, [bucket]: { ...state[bucket] } };
      delete next[bucket][action.id];
      return next;
    }
    case 'clear':
      return emptyDraft();
    case 'hydrate':
      return action.draft;
    default:
      return state;
  }
}

export interface SelectionCounts {
  showsWatched: number;
  showsWatchlisted: number;
  moviesWatched: number;
  moviesWatchlisted: number;
  total: number;
}

export function selectionCounts(draft: OnboardingDraft): SelectionCounts {
  const shows = Object.values(draft.shows);
  const movies = Object.values(draft.movies);
  const showsWatchlisted = shows.filter((s) => s.action === 'WATCHLIST').length;
  const moviesWatchlisted = movies.filter((m) => m.action === 'WATCHLIST').length;
  const showsWatched = shows.length - showsWatchlisted;
  const moviesWatched = movies.length - moviesWatchlisted;
  return {
    showsWatched,
    showsWatchlisted,
    moviesWatched,
    moviesWatchlisted,
    total: shows.length + movies.length,
  };
}

/** True when the compact show-progress step is needed (any show marked watched). */
export function needsProgressReview(draft: OnboardingDraft): boolean {
  return Object.values(draft.shows).some((s) => s.action !== 'WATCHLIST');
}

export function buildApplyPayload(draft: OnboardingDraft): OnboardingApplyDto {
  return {
    shows: Object.entries(draft.shows).map(([mediaId, s]) => ({
      mediaId,
      action: s.action,
      ...(s.action === 'WATCHED_THROUGH'
        ? { throughSeasonNumber: s.throughSeasonNumber, throughEpisodeNumber: s.throughEpisodeNumber }
        : {}),
    })),
    movies: Object.entries(draft.movies).map(([mediaId, m]) => ({ mediaId, action: m.action })),
  };
}

/** Gate predicate: onboarding is done only for terminal states at the current
 *  version. A future ONBOARDING_VERSION bump re-shows it to everyone. */
export function isOnboardingDone(
  status: OnboardingStatus | undefined,
  version: number | null | undefined,
): boolean {
  const terminal = status === 'COMPLETED' || status === 'SKIPPED';
  return terminal && (version ?? 0) >= ONBOARDING_VERSION;
}
