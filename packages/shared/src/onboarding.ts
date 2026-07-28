export const ONBOARDING_VERSION = 1;

export type OnboardingStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';

export type OnboardingShowAction = 'WATCHLIST' | 'CAUGHT_UP' | 'WATCHED_THROUGH';
export type OnboardingMovieAction = 'WATCHLIST' | 'WATCHED';

export interface OnboardingShowItemDto {
  mediaId: string;
  action: OnboardingShowAction;
  throughSeasonNumber?: number;
  throughEpisodeNumber?: number;
}

export interface OnboardingMovieItemDto {
  mediaId: string;
  action: OnboardingMovieAction;
}

export interface OnboardingApplyDto {
  shows: OnboardingShowItemDto[];
  movies: OnboardingMovieItemDto[];
}

export type OnboardingUnresolvedReason =
  | 'HYDRATION_FAILED'
  | 'NO_AIRED_EPISODES'
  | 'NOT_FOUND'
  | 'ERROR';

export interface OnboardingUnresolvedDto {
  mediaId: string;
  reason: OnboardingUnresolvedReason;
}

export interface OnboardingApplyResultDto {
  applied: {
    showsProcessed: number;
    episodesMarked: number;
    moviesWatched: number;
    watchlistAdded: number;
  };
  unresolved: OnboardingUnresolvedDto[];
}

export interface OnboardingStateDto {
  status: OnboardingStatus;
  version: number | null;
  requiredVersion: number;
}

export interface UpdateOnboardingStateDto {
  status: Exclude<OnboardingStatus, 'NOT_STARTED'>;
  version: number;
}
