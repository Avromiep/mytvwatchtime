import Constants from 'expo-constants';
import { useEffect, useMemo } from 'react';
import { Platform } from 'react-native';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import type {
  CommentDto,
  CommentSort,
  CommentThreadDto,
  CurrentUserDto,
  DiscoverSectionsDto,
  EpisodeDetailDto,
  EpisodeInteractionsDto,
  GenreFilterDto,
  MediaCardDto,
  MediaCardLiteDto,
  HistoryItemDto,
  ImportExtraSummaryDto,
  LeaderboardPageDto,
  LeaderboardType,
  MovieDetailDto,
  MovieStatsDto,
  AnnouncementDto,
  MyCommentContextDto,
  NotificationItemDto,
  NotificationPreferencesDto,
  Paginated,
  PaginatedMyComments,
  ShowDetailDto,
  ShowStatsDto,
  StatsSummaryDto,
  UpdateCommentDto,
  UpcomingGroupDto,
  UpcomingPastCursor,
  UpcomingPastPageDto,
  WatchNextHistoryCursor,
  WatchNextHistoryPageDto,
  UserBadgeDto,
  VoteSectionDto,
  ReactionVoteSectionDto,
  CharacterVoteSectionDto,
  WatchNextItemDto,
  WatchNextResponseDto,
  WatchNextBucketPageDto,
  ExternalReviewDto,
  FeedPageDto,
  OnboardingApplyDto,
  OnboardingApplyResultDto,
  OnboardingStateDto,
  UpdateOnboardingStateDto,
  ProviderAlertDto,
  ProviderOfferType,
  WatchProviderCatalogEntryDto,
} from '@tvwatch/shared';
import { applyVoteChange, MediaType } from '@tvwatch/shared';
import { api, HttpError } from './client';
import { applyWatchStateToItems } from './watch-next-optimistic';
import { refreshWidgets } from '../widgets/sync';
import { logFirstEvent } from '../lib/analytics';

export const qk = {
  me: ['me'] as const,
  watchNext: ['watchNext'] as const,
  upcoming: ['upcoming'] as const,
  history: (p: any) => ['history', p] as const,
  show: (id: string) => ['show', id] as const,
  showEpisodes: (id: string) => ['showEpisodes', id] as const,
  episode: (id: string) => ['episode', id] as const,
  movie: (id: string) => ['movie', id] as const,
  search: (q: string, type?: string) => ['search', q, type ?? 'all'] as const,
  discover: () => ['discoverSections'] as const,
  discoverShows: (p: any) => ['discoverShows', p] as const,
  discoverMovies: (p: any) => ['discoverMovies', p] as const,
  trendingShows: ['trendingShows'] as const,
  trendingMovies: ['trendingMovies'] as const,
  watchlist: (type?: MediaType) => ['watchlist', type ?? 'all'] as const,
  favorites: (type: MediaType) => ['favorites', type] as const,
  statsSummary: ['statsSummary'] as const,
  statsShows: ['statsShows'] as const,
  statsMovies: ['statsMovies'] as const,
  badges: ['badges'] as const,
  notifications: (p: any) => ['notifications', p] as const,
  notificationsUnreadCount: ['notificationsUnreadCount'] as const,
  myComments: ['myComments'] as const,
  notifPrefs: ['notifPrefs'] as const,
  comments: (p: any) => ['comments', p] as const,
  comment: (id: string) => ['comment', id] as const,
  commentReplies: (id: string, sort: string, depth: number = 1) =>
    ['commentReplies', id, sort, depth] as const,
  commentParticipants: (p: any) => ['commentParticipants', p] as const,
  lists: ['lists'] as const,
  list: (id: string) => ['list', id] as const,
  contactThreads: ['contactThreads'] as const,
  contactThread: (id: string) => ['contactThread', id] as const,
  feed: ['feed'] as const,
  providerAlerts: (mediaId: string) => ['providerAlerts', mediaId] as const,
  providerCatalog: (country?: string) => ['providerCatalog', country ?? 'auto'] as const,
};

export const useMe = () =>
  useQuery({ queryKey: qk.me, queryFn: () => api.get<CurrentUserDto>('/me') });
export const useWatchNext = () =>
  useQuery({
    queryKey: qk.watchNext,
    queryFn: () => api.get<WatchNextResponseDto>('/me/watch-next'),
  });
/** Next episodes to watch from PAUSED shows — own rail under "Haven't watched for a while". */
export const usePausedWatchNext = () =>
  useQuery({
    queryKey: ['watchNext', 'paused'] as const,
    queryFn: () => api.get<{ items: WatchNextItemDto[] }>('/me/watch-next/paused'),
  });
/**
 * "See more" paging for the capped watch-list rails (START_WATCHING / NOT_RECENTLY):
 * the first 10 ship inside the main watch-next payload, so pages start at offset 10.
 */
export const useWatchNextBucket = (bucket: 'START_WATCHING' | 'NOT_RECENTLY') =>
  useInfiniteQuery({
    queryKey: ['watchNext', 'bucket', bucket] as const,
    queryFn: ({ pageParam }) =>
      api.get<WatchNextBucketPageDto>('/me/watch-next/bucket', {
        bucket,
        offset: pageParam,
        limit: 10,
      }),
    initialPageParam: 10,
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
  });
export const useUpcoming = () =>
  useQuery({
    queryKey: qk.upcoming,
    queryFn: () =>
      api.get<{
        groups: UpcomingGroupDto[];
        past: { hasMore: boolean; cursor: UpcomingPastCursor | null };
      }>('/me/upcoming'),
  });

/**
 * Older past pages for the upcoming screen's infinite scroll-up. `enabled: false`
 * so nothing loads until the user actually scrolls to the top — fetchNextPage
 * (triggered by onStartReached) fetches the first page even while disabled.
 * Callers must only trigger fetchNextPage when `initialCursor` is non-null
 * (main endpoint's past.hasMore) or a fetched page returned hasMore.
 */
export const useUpcomingPast = (initialCursor: UpcomingPastCursor | null) =>
  useInfiniteQuery({
    queryKey: [...qk.upcoming, 'past'],
    queryFn: ({ pageParam }) => {
      if (!pageParam) throw new Error('No past cursor');
      return api.get<UpcomingPastPageDto>('/me/upcoming/past', {
        before: pageParam.before,
        beforeId: pageParam.beforeId,
      });
    },
    initialPageParam: initialCursor,
    getNextPageParam: (last) => (last.hasMore ? last.cursor : undefined),
    enabled: false,
    gcTime: 5 * 60 * 1000,
    staleTime: 30 * 1000,
    // Never retry 4xx (429 throttle / 400 bad cursor) — one silent retry otherwise.
    retry: (failureCount, error) =>
      failureCount < 1 &&
      !(error instanceof HttpError && error.status >= 400 && error.status < 500),
  });
export const useHistory = (p: { mediaType?: MediaType; page?: number }) =>
  useQuery({
    queryKey: qk.history(p),
    queryFn: () => api.get<Paginated<HistoryItemDto>>('/me/history', { ...p, pageSize: 500 }),
  });
/**
 * Older watch-list history pages for the scroll-up rail. Same contract as
 * useUpcomingPast: `enabled: false` — nothing loads until the user scrolls to the
 * top and fetchNextPage fires; callers gate the first fetch on the main endpoint's
 * historyHasMore + initial cursor, later pages on the last page's cursor.
 */
export const useWatchNextHistory = (initialCursor: WatchNextHistoryCursor | null) =>
  useInfiniteQuery({
    queryKey: [...qk.watchNext, 'history'],
    queryFn: ({ pageParam }) => {
      if (!pageParam) throw new Error('No history cursor');
      return api.get<WatchNextHistoryPageDto>('/me/watch-next/history', {
        before: pageParam.before,
        beforeId: pageParam.beforeId,
      });
    },
    initialPageParam: initialCursor,
    getNextPageParam: (last) => (last.hasMore ? last.cursor : undefined),
    enabled: false,
    gcTime: 5 * 60 * 1000,
    staleTime: 30 * 1000,
    retry: (failureCount, error) =>
      failureCount < 1 &&
      !(error instanceof HttpError && error.status >= 400 && error.status < 500),
  });
/**
 * Paginated mixed movies+shows watch history (20/page, newest first) for
 * "recently watched" rails. Callers dedupe shows client-side by mediaId —
 * one row per media item even when many episodes were watched.
 */
export const useRecentWatched = () =>
  useInfiniteQuery({
    queryKey: [...qk.history({}), 'recent'],
    queryFn: ({ pageParam = 1 }) =>
      api.get<Paginated<HistoryItemDto>>('/me/history', { page: pageParam, pageSize: 20 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last?.hasMore ? last.page + 1 : undefined),
  });
export const useShow = (id: string) =>
  useQuery({
    queryKey: qk.show(id),
    queryFn: () => api.get<ShowDetailDto>(`/shows/${id}`),
    enabled: !!id,
  });
export const useShowEpisodes = (id: string) =>
  useQuery({
    queryKey: qk.showEpisodes(id),
    queryFn: () => api.get<any[]>(`/shows/${id}/episodes`),
    enabled: !!id,
  });
export const useEpisode = (id: string) =>
  useQuery({
    queryKey: qk.episode(id),
    queryFn: () => api.get<EpisodeDetailDto>(`/episodes/${id}`),
    enabled: !!id,
  });
// Ordered ids of the episode's season siblings — powers the episode pager without
// downloading the show's entire season structure.
export const useEpisodeSiblings = (id: string) =>
  useQuery({
    queryKey: ['episodeSiblings', id] as const,
    queryFn: () => api.get<{ seasonId: string; episodeIds: string[] }>(`/episodes/${id}/siblings`),
    enabled: !!id,
  });
export const useMovie = (id: string) =>
  useQuery({
    queryKey: qk.movie(id),
    queryFn: () => api.get<MovieDetailDto>(`/movies/${id}`),
    enabled: !!id,
  });
// Server-paginated search (20/page): the API keeps the merged ordering in a short-lived
// cache and expands it on demand, so onEndReached reveals results beyond the first page.
/** Explore filter values shared by search / sections / trending (see explore.tsx). */
export interface ExploreFilters {
  excludeGenres?: string[];
  sort?: 'popularity' | 'releaseDate';
  country?: string | null;
  hideAnime?: boolean;
}
/** ExploreFilters → query params (defaults omitted so URLs stay clean). */
const filterParams = (f?: ExploreFilters) => ({
  excludeGenres: f?.excludeGenres?.length ? f.excludeGenres.join(',') : undefined,
  sort: f?.sort && f.sort !== 'popularity' ? f.sort : undefined,
  country: f?.country || undefined,
  hideAnime: f?.hideAnime ? true : undefined,
});
/** Every filter value must be part of the query key — filters change the result set. */
const filterKey = (f?: ExploreFilters) =>
  `${(f?.excludeGenres ?? []).join(',')}|${f?.sort ?? ''}|${f?.country ?? ''}|${f?.hideAnime ? 1 : 0}`;
export const useSearch = (q: string, type?: MediaType, genre?: string | null, filters?: ExploreFilters) =>
  useInfiniteQuery({
    queryKey: [...qk.search(q, type), genre ?? '', filterKey(filters)],
    queryFn: ({ pageParam = 1 }) =>
      api.get<Paginated<MediaCardDto>>('/search', {
        q,
        type,
        genre: genre || undefined,
        page: pageParam,
        pageSize: 20,
        ...filterParams(filters),
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last?.hasMore ? last.page + 1 : undefined),
    enabled: q.length > 1,
  });
export const useDiscoverSections = (userId?: string, genre?: string | null, filters?: ExploreFilters) =>
  // User-scoped key: the server's anonymous fallback (topForYou = trending) must NEVER
  // share a cache entry with the personalized sections — otherwise a token-less early
  // request (cold start / expired token) shows trending as "Top shows for you" until
  // the next manual refetch.
  useQuery({
    queryKey: [...qk.discover(), userId ?? 'anon', genre ?? '', filterKey(filters)],
    queryFn: () =>
      api.get<DiscoverSectionsDto>('/discover/sections', {
        genre: genre || undefined,
        ...filterParams(filters),
      }),
  });
// Activity feed (explore "Feed" tab): self + followings, cursor-paginated newest first.
export const useFeed = () =>
  useInfiniteQuery({
    queryKey: qk.feed,
    queryFn: ({ pageParam }) =>
      api.get<FeedPageDto>('/feed', { cursor: pageParam, limit: 20 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
// Catalog genres for filter chips (explore/search/see-all) — rarely changes.
export const useGenres = () =>
  useQuery({
    queryKey: ['genres'] as const,
    queryFn: () => api.get<GenreFilterDto[]>('/genres'),
    staleTime: 3600000,
  });
export const useDiscoverShows = (p: any) =>
  useQuery({
    queryKey: qk.discoverShows(p),
    queryFn: () => api.get<Paginated<MediaCardDto>>('/discover/shows', p),
  });
export const useDiscoverMovies = (p: any) =>
  useQuery({
    queryKey: qk.discoverMovies(p),
    queryFn: () => api.get<Paginated<MediaCardDto>>('/discover/movies', p),
  });
export const useTrendingShows = (filters?: ExploreFilters) =>
  useQuery({
    queryKey: [...qk.trendingShows, filterKey(filters)],
    queryFn: () =>
      api.get<any>('/trending/shows', { ...filterParams(filters) }).then((r) => r.items ?? r),
  });
export const useTrendingMovies = (filters?: ExploreFilters) =>
  useQuery({
    queryKey: [...qk.trendingMovies, filterKey(filters)],
    queryFn: () =>
      api.get<any>('/trending/movies', { ...filterParams(filters) }).then((r) => r.items ?? r),
  });
export const useTrendingShowsPaginated = (page: number) =>
  useQuery({
    queryKey: ['trendingShowsPage', page],
    queryFn: () => api.get<{ items: any[]; hasMore: boolean }>(`/trending/shows?page=${page}`),
    enabled: page > 0,
  });
export const useTrendingMoviesPaginated = (page: number) =>
  useQuery({
    queryKey: ['trendingMoviesPage', page],
    queryFn: () => api.get<{ items: any[]; hasMore: boolean }>(`/trending/movies?page=${page}`),
    enabled: page > 0,
  });
export const useWatchlist = (type?: MediaType) =>
  useQuery({
    queryKey: qk.watchlist(type),
    queryFn: () => api.get<Paginated<MediaCardLiteDto>>('/me/watchlist', { type, pageSize: 500 }),
  });
export const useFavorites = (type: MediaType) =>
  useQuery({
    queryKey: qk.favorites(type),
    queryFn: () =>
      api.get<Paginated<MediaCardLiteDto>>(
        type === MediaType.SHOW ? '/me/favorites/shows' : '/me/favorites/movies',
        { pageSize: 500 },
      ),
  });

/**
 * Fetch EVERY page of a paginated endpoint (500/page chunks), auto-chaining until the
 * collection is complete — for screens that must show exactly what the user has
 * (Movies tab, see-all grids). Keys stay under the standard prefixes so the existing
 * mutation invalidations (['watchlist'] / ['favorites'] / ['history']) cover them.
 */
function useAllPages<T>(key: readonly unknown[], path: string, params: Record<string, unknown>) {
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam = 1 }) =>
      api.get<Paginated<T>>(path, { ...params, page: pageParam, pageSize: 500 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last?.hasMore ? last.page + 1 : undefined),
    placeholderData: (prev) => prev,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage, data } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, data]);
  const items = useMemo(() => (data?.pages ?? []).flatMap((p) => p.items ?? []), [data]);
  return { ...query, items, fullyLoaded: !hasNextPage };
}

export const useAllWatchlist = (type?: MediaType, genre?: string | null) =>
  useAllPages<MediaCardLiteDto>(['watchlist', 'all', type, genre ?? ''] as const, '/me/watchlist', {
    ...(type ? { type } : {}),
    ...(genre ? { genre } : {}),
  });
export const useAllFavorites = (type: MediaType, genre?: string | null) =>
  useAllPages<MediaCardLiteDto>(
    ['favorites', 'all', type, genre ?? ''] as const,
    type === MediaType.SHOW ? '/me/favorites/shows' : '/me/favorites/movies',
    genre ? { genre } : {},
  );
export const useAllHistory = (p: { mediaType?: MediaType }) =>
  useAllPages<HistoryItemDto>(['history', 'all', p.mediaType] as const, '/me/history', p);
// Poll while the server reports stats are being recomputed (SWR stale flag); stop once fresh.
const statsRefetchInterval = (query: any) => (query.state.data?.stale ? 2500 : false);

export const useStatsSummary = () =>
  useQuery({
    queryKey: qk.statsSummary,
    queryFn: () => api.get<StatsSummaryDto>('/me/stats/summary'),
    refetchInterval: statsRefetchInterval,
  });
// `enabled` gates by the visible tab on the stats screen — previously both heavy
// payloads (plus their stale-flag pollers) mounted regardless of the selected tab.
export const useStatsShows = (enabled = true) =>
  useQuery({
    queryKey: qk.statsShows,
    queryFn: () => api.get<ShowStatsDto>('/me/stats/shows'),
    refetchInterval: statsRefetchInterval,
    enabled,
  });
export const useStatsMovies = (enabled = true) =>
  useQuery({
    queryKey: qk.statsMovies,
    queryFn: () => api.get<MovieStatsDto>('/me/stats/movies'),
    refetchInterval: statsRefetchInterval,
    enabled,
  });
export const useBadges = () =>
  useQuery({
    queryKey: qk.badges,
    queryFn: () =>
      api.get<{ badges: UserBadgeDto[]; totalUnlocked: number; totalBadges: number }>('/me/badges'),
  });
export const useNotifications = (p: { unreadOnly?: boolean }) =>
  useInfiniteQuery({
    queryKey: qk.notifications(p),
    queryFn: ({ pageParam }) =>
      api.get<Paginated<NotificationItemDto>>('/me/notifications', {
        ...(p.unreadOnly ? { unreadOnly: true } : {}),
        page: pageParam as number,
        pageSize: 30,
      } as any),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });

export const useUnreadNotificationCount = () =>
  useQuery({
    queryKey: qk.notificationsUnreadCount,
    queryFn: async () => {
      const res = await api.get<Paginated<NotificationItemDto>>('/me/notifications', {
        unreadOnly: true,
        page: 1,
        pageSize: 1,
      } as any);
      return res.total;
    },
    refetchInterval: 60_000,
  });
/** Current user's comments across all threads, newest first (Profile → My comments). */
export const useMyComments = () =>
  useInfiniteQuery({
    queryKey: qk.myComments,
    queryFn: ({ pageParam }) =>
      api.get<PaginatedMyComments>('/me/comments', { page: pageParam as number, pageSize: 20 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });
export const useNotifPrefs = () =>
  useQuery({
    queryKey: qk.notifPrefs,
    queryFn: () => api.get<NotificationPreferencesDto>('/me/notification-preferences'),
  });

// ---------------- Contact / Support threads ----------------
export interface ContactThreadListItem {
  id: string;
  reason: string;
  subject: string;
  status: string;
  lastMessageAt: string;
  createdAt: string;
  lastMessagePreview: string | null;
  unreadForUser: boolean;
}
export interface ContactThreadDetail {
  id: string;
  reason: string;
  subject: string;
  status: string;
  adminReplied: boolean;
  createdAt: string;
  lastMessageAt: string;
  messages: { id: string; authorRole: 'USER' | 'ADMIN'; body: string; createdAt: string }[];
}
export const useContactThreads = () =>
  useQuery({
    queryKey: qk.contactThreads,
    queryFn: () => api.get<Paginated<ContactThreadListItem>>('/me/contacts', { pageSize: 100 }),
  });
export const useContactThread = (id: string) =>
  useQuery({
    queryKey: qk.contactThread(id),
    queryFn: () => api.get<ContactThreadDetail>(`/me/contacts/${id}`),
    enabled: !!id,
  });
export const useCreateContactThread = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { reason: string; subject: string; body: string }) =>
      api.post<ContactThreadDetail>('/me/contacts', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.contactThreads }),
  });
};
export const useReplyContactThread = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.post<{ ok: true }>(`/me/contacts/${id}/messages`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.contactThread(id) });
      qc.invalidateQueries({ queryKey: qk.contactThreads });
    },
  });
};
export type CommentSortMode = CommentSort;

const COMMENT_POLL_INTERVAL =
  Number((Constants?.expoConfig?.extra as any)?.commentPollInterval) || 15000;
const COMMENT_PAGE_SIZE = 20;

/** Infinite-scrolling feed of top-level comments for a thread. */
export const useCommentsFeed = (p: {
  threadType: string;
  threadId: string;
  sort: CommentSortMode;
  polling?: boolean;
  pageSize?: number;
}) => {
  const { polling, pageSize = COMMENT_PAGE_SIZE, ...rest } = p;
  return useInfiniteQuery({
    queryKey: qk.comments(p),
    queryFn: ({ pageParam }) =>
      api.get<
        Paginated<CommentDto> & {
          externalReviews?: ExternalReviewDto[];
          thread?: MyCommentContextDto | null;
        }
      >('/comments', {
        ...rest,
        page: pageParam as number,
        pageSize,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    enabled: !!p.threadId,
    refetchInterval: polling ? COMMENT_POLL_INTERVAL : false,
  });
};

/** Single comment (thread header) with thread context + ancestor chain. */
export const useComment = (id: string, polling = false) =>
  useQuery({
    queryKey: qk.comment(id),
    queryFn: () => api.get<CommentThreadDto>(`/comments/${id}`),
    enabled: !!id,
    refetchInterval: polling ? COMMENT_POLL_INTERVAL : false,
  });

/** Replies posted against an external (TMDB) review. Lazy: only fetched when expanded. */
export const useExternalReviewReplies = (reviewId: string | null, enabled = true) =>
  useQuery({
    queryKey: ['externalReviewReplies', reviewId],
    queryFn: () => api.get<CommentDto[]>(`/external-reviews/${reviewId}/replies`),
    enabled: enabled && !!reviewId,
  });

/** A single provider review (thread header). */
export const useExternalReview = (reviewId: string | null, polling = false) =>
  useQuery({
    queryKey: ['externalReview', reviewId],
    queryFn: () => api.get<ExternalReviewDto>(`/external-reviews/${reviewId}`),
    enabled: !!reviewId,
    refetchInterval: polling ? COMMENT_POLL_INTERVAL : false,
  });

/** Like/unlike a provider review. */
export const useToggleExternalReviewLike = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { reviewId: string; liked: boolean }) =>
      args.liked
        ? api.del(`/external-reviews/${args.reviewId}/like`)
        : api.post(`/external-reviews/${args.reviewId}/like`, {}),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['externalReview', vars.reviewId] });
      qc.invalidateQueries({ queryKey: ['comments'] });
    },
  });
}; /** Infinite-scrolling replies for a comment. depth=2 also returns each direct child's first children. */
export const useCommentReplies = (
  commentId: string,
  sort: CommentSortMode,
  opts?: { pageSize?: number; polling?: boolean; depth?: 1 | 2 },
) =>
  useInfiniteQuery({
    queryKey: qk.commentReplies(commentId, sort, opts?.depth ?? 1),
    queryFn: ({ pageParam }) =>
      api.get<Paginated<CommentDto>>(`/comments/${commentId}/replies`, {
        page: pageParam as number,
        pageSize: opts?.pageSize ?? COMMENT_PAGE_SIZE,
        sort,
        depth: opts?.depth ?? 1,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    enabled: !!commentId,
    refetchInterval: opts?.polling ? COMMENT_POLL_INTERVAL : false,
  });

/** Distinct participants in a thread (for @mention suggestions). */
export const useCommentParticipants = (threadType: string, threadId: string) =>
  useQuery({
    queryKey: qk.commentParticipants({ threadType, threadId }),
    queryFn: () =>
      api.get<{ id: string; username: string; avatarUrl?: string | null }[]>(
        '/comments/participants',
        {
          threadType,
          threadId,
        },
      ),
    enabled: !!threadId,
    staleTime: 60_000,
  });

/** Patch a comment wherever it currently lives in the React Query caches (feed/replies/single). */
function patchCommentInCaches(
  qc: ReturnType<typeof useQueryClient>,
  commentId: string,
  patch: (c: CommentDto) => CommentDto,
) {
  const mapPage = (pg: any) =>
    pg && Array.isArray(pg.items)
      ? { ...pg, items: pg.items.map((c: CommentDto) => (c.id === commentId ? patch(c) : c)) }
      : pg;
  const mapInfinite = (old: any) =>
    old && Array.isArray(old.pages) ? { ...old, pages: old.pages.map(mapPage) } : old;

  qc.setQueriesData({ queryKey: ['comments'] }, mapInfinite);
  qc.setQueriesData({ queryKey: ['commentReplies'] }, mapInfinite);
  qc.setQueriesData({ queryKey: ['comment'] }, (old: any) => (old && old.id ? patch(old) : old));
}

export const useCreateComment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: {
      threadType: string;
      threadId: string;
      body?: string;
      parentId?: string;
      gifUrl?: string;
      mediaType?: string;
      mediaId?: string;
      listId?: string;
      isSpoiler?: boolean;
      externalReviewId?: string;
    }) => api.post<CommentDto>('/comments', dto),
    onSuccess: (_data, vars) => {
      logFirstEvent('first_comment');
      qc.invalidateQueries({ queryKey: ['comments'] });
      if (vars.parentId) {
        qc.invalidateQueries({ queryKey: ['commentReplies', vars.parentId] });
        qc.invalidateQueries({ queryKey: ['comment', vars.parentId] });
      }
    },
  });
};

export const useToggleCommentLike = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, liked }: { commentId: string; liked: boolean }) =>
      liked ? api.del(`/comments/${commentId}/like`) : api.post(`/comments/${commentId}/like`, {}),
    onMutate: async ({ commentId, liked }) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: ['comments'] }),
        qc.cancelQueries({ queryKey: ['commentReplies'] }),
        qc.cancelQueries({ queryKey: ['comment'] }),
      ]);
      patchCommentInCaches(qc, commentId, (c) => ({
        ...c,
        likedByMe: !liked,
        likesCount: Math.max(0, c.likesCount + (liked ? -1 : 1)),
      }));
      return { commentId, liked };
    },
    onError: (_e, { commentId, liked }) => {
      patchCommentInCaches(qc, commentId, (c) => ({
        ...c,
        likedByMe: liked,
        likesCount: Math.max(0, c.likesCount + (liked ? 1 : -1)),
      }));
    },
    onSuccess: (_d, { liked }) => {
      // liked === true means the action was an UNlike — only a like counts.
      if (!liked) logFirstEvent('first_comment_like');
    },
  });
};

export const useUpdateComment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, dto }: { commentId: string; dto: UpdateCommentDto }) =>
      api.patch<CommentDto>(`/comments/${commentId}`, dto as Record<string, unknown>),
    onSuccess: (updated) => {
      patchCommentInCaches(qc, updated.id, () => updated);
      qc.invalidateQueries({ queryKey: ['comments'] });
      qc.invalidateQueries({ queryKey: ['commentReplies'] });
    },
  });
};

export const useDeleteComment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => api.del(`/comments/${commentId}`),
    onSuccess: (_data, commentId) => {
      patchCommentInCaches(qc, commentId, (c) => ({
        ...c,
        deletedByUser: true,
        body: '',
        imageUrl: null,
        gifUrl: null,
        image: null,
        likedByMe: false,
      }));
      qc.invalidateQueries({ queryKey: ['comments'] });
      qc.invalidateQueries({ queryKey: ['commentReplies'] });
      qc.invalidateQueries({ queryKey: ['comment', commentId] });
    },
  });
};
export const useLists = () =>
  useQuery({ queryKey: qk.lists, queryFn: () => api.get<any[]>('/me/lists') });
export const useList = (id: string) =>
  useQuery({ queryKey: qk.list(id), queryFn: () => api.get<any>(`/lists/${id}`), enabled: !!id });

// ---------------- Mutations ----------------
export function useInvalidate(keys: readonly unknown[][]) {
  const qc = useQueryClient();
  return () => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
}

/**
 * Invalidate the leaderboard after watch activity: once immediately (the server's
 * leading-edge cache bust is instant) and once delayed — a burst of marks within the
 * server's 45s floor gets one trailing bust, so the delayed pass picks up the final
 * ranking without reinstating a permanent poll.
 */
function invalidateLeaderboardSoon(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['leaderboard'] });
  setTimeout(() => qc.invalidateQueries({ queryKey: ['leaderboard'] }), 10_000);
}

export const useMarkEpisodeWatched = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.post(`/episodes/${id}/watched`, {}) : api.del(`/episodes/${id}/watched`),
    // Optimistically flip the watched state across all caches so the UI reacts instantly.
    // watchCount: 1 when marking watched, 0 when unwatching.
    onMutate: async ({ id, on }) => {
      await qc.cancelQueries({ queryKey: ['watchNext'] });
      const prevWatchNext = qc.getQueryData(qk.watchNext);
      // watchNext: do a full, correct transform (swap the Watch-Next card to the next episode
      // on mark-watched; replace the show's card / dedupe on unwatch) so the ~1s server
      // reconcile is invisible. See ./watch-next-optimistic.
      qc.setQueryData(qk.watchNext, (old: any) =>
        old ? { ...old, items: applyWatchStateToItems(old.items ?? [], id, on) } : old,
      );

      const prevShowEpisodes = qc.getQueriesData({ queryKey: ['showEpisodes'] });
      prevShowEpisodes.forEach(([key, data]: [any, any]) => {
        if (!Array.isArray(data)) return;
        qc.setQueryData(
          key,
          data.map((s: any) => ({
            ...s,
            episodes: s.episodes?.map((e: any) =>
              e.id === id ? { ...e, watched: on, watchCount: on ? 1 : 0 } : e,
            ),
          })),
        );
      });

      const prevEpisode = qc.getQueryData(qk.episode(id));
      qc.setQueryData(qk.episode(id), (old: any) =>
        old ? { ...old, watched: on, watchCount: on ? 1 : 0 } : old,
      );

      return { prevWatchNext, prevShowEpisodes, prevEpisode };
    },
    onError: (_e, vars, ctx) => {
      if (ctx?.prevWatchNext) qc.setQueryData(qk.watchNext, ctx.prevWatchNext);
      ctx?.prevShowEpisodes?.forEach(([key, data]: [any, any]) => qc.setQueryData(key, data));
      if (ctx?.prevEpisode) qc.setQueryData(qk.episode(vars.id), ctx.prevEpisode);
    },
    onSuccess: (_d, vars) => {
      if (vars.on) logFirstEvent('first_watched_episode');
    },
    onSettled: (_d, _e, vars) => {
      // Invalidate all relevant queries so every consumer updates
      qc.invalidateQueries({ queryKey: ['watchNext'] });
      // Stats are NOT invalidated per-mark: the backend marks them stale and the client polls via
      // refetchInterval while the SWR `stale` flag is true. (See useStatsSummary.)
      // Exact episode key only — a bare ['episode'] prefix refetches every mounted
      // episode query (up to 5 in the episode pager) on every tap.
      qc.invalidateQueries({ queryKey: qk.episode(vars.id) });
      qc.invalidateQueries({ queryKey: ['showEpisodes'] });
      qc.invalidateQueries({ queryKey: ['show'] });
      // First watches seed the for-you ranking — refresh the Explore carousel.
      qc.invalidateQueries({ queryKey: qk.discover() });
      invalidateLeaderboardSoon(qc);
      void refreshWidgets();
    },
  });
};

export const useMarkSeasonWatched = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.post(`/seasons/${id}/watched`, {}) : api.del(`/seasons/${id}/watched`),
    onSuccess: (_d, vars) => {
      // A season mark watches episodes in bulk — counts as a first watched episode too.
      if (vars.on) logFirstEvent('first_watched_episode');
      qc.invalidateQueries({ queryKey: ['showEpisodes'] });
      qc.invalidateQueries({ queryKey: ['show'] });
      // A season mark is a bulk watch action — the Shows tab and leaderboard change too.
      qc.invalidateQueries({ queryKey: ['watchNext'] });
      qc.invalidateQueries({ queryKey: ['upcoming'] });
      invalidateLeaderboardSoon(qc);
      void refreshWidgets();
    },
  });
};

/** Bulk rewatch of a season's already-watched aired episodes (watchCount +1 each). */
export const useRewatchSeason = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/seasons/${id}/rewatch`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['showEpisodes'] });
      qc.invalidateQueries({ queryKey: ['show'] });
      qc.invalidateQueries({ queryKey: ['watchNext'] });
      qc.invalidateQueries({ queryKey: ['upcoming'] });
      invalidateLeaderboardSoon(qc);
      void refreshWidgets();
    },
  });
};

/**
 * Record another viewing of an already-watched episode. watchCount increments
 * optimistically across all caches while the watched flag stays true.
 */
export const useRewatchEpisode = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ watchCount: number }>(`/episodes/${id}/rewatch`, {}),
    onMutate: async (id: string) => {
      const bump = (n: any) => Math.max(1, (Number(n?.watchCount) || 1) + 1);

      const prevWatchNext = qc.getQueryData(qk.watchNext);
      qc.setQueryData(qk.watchNext, (old: any) =>
        old
          ? {
              ...old,
              items: old.items.map((it: any) =>
                it.episode?.id === id
                  ? { ...it, episode: { ...it.episode, watchCount: bump(it.episode) } }
                  : it,
              ),
            }
          : old,
      );

      const prevShowEpisodes = qc.getQueriesData({ queryKey: ['showEpisodes'] });
      prevShowEpisodes.forEach(([key, data]: [any, any]) => {
        if (!Array.isArray(data)) return;
        qc.setQueryData(
          key,
          data.map((s: any) => ({
            ...s,
            episodes: s.episodes?.map((e: any) =>
              e.id === id ? { ...e, watchCount: bump(e) } : e,
            ),
          })),
        );
      });

      const prevEpisode = qc.getQueryData(qk.episode(id));
      qc.setQueryData(qk.episode(id), (old: any) =>
        old ? { ...old, watchCount: bump(old) } : old,
      );

      return { prevWatchNext, prevShowEpisodes, prevEpisode };
    },
    onError: (_e, id, ctx) => {
      if (ctx?.prevWatchNext) qc.setQueryData(qk.watchNext, ctx.prevWatchNext);
      ctx?.prevShowEpisodes?.forEach(([key, data]: [any, any]) => qc.setQueryData(key, data));
      if (ctx?.prevEpisode) qc.setQueryData(qk.episode(id), ctx.prevEpisode);
    },
    onSettled: (_d, _e, id) => {
      qc.invalidateQueries({ queryKey: qk.episode(id) });
      qc.invalidateQueries({ queryKey: ['watchNext'] });
      invalidateLeaderboardSoon(qc);
    },
  });
};

/**
 * Undo ONE viewing of an episode watched 2+ times: watchCount decrements
 * optimistically across all caches while the watched flag stays true.
 */
export const useUnwatchEpisodeOnce = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ watchCount: number }>(`/episodes/${id}/unwatch-once`, {}),
    onMutate: async (id: string) => {
      const bump = (n: any) => Math.max(1, (Number(n?.watchCount) || 1) - 1);

      const prevWatchNext = qc.getQueryData(qk.watchNext);
      qc.setQueryData(qk.watchNext, (old: any) =>
        old
          ? {
              ...old,
              items: old.items.map((it: any) =>
                it.episode?.id === id
                  ? { ...it, episode: { ...it.episode, watchCount: bump(it.episode) } }
                  : it,
              ),
            }
          : old,
      );

      const prevShowEpisodes = qc.getQueriesData({ queryKey: ['showEpisodes'] });
      prevShowEpisodes.forEach(([key, data]: [any, any]) => {
        if (!Array.isArray(data)) return;
        qc.setQueryData(
          key,
          data.map((s: any) => ({
            ...s,
            episodes: s.episodes?.map((e: any) =>
              e.id === id ? { ...e, watchCount: bump(e) } : e,
            ),
          })),
        );
      });

      const prevEpisode = qc.getQueryData(qk.episode(id));
      qc.setQueryData(qk.episode(id), (old: any) =>
        old ? { ...old, watchCount: bump(old) } : old,
      );

      return { prevWatchNext, prevShowEpisodes, prevEpisode };
    },
    onError: (_e, id, ctx) => {
      if (ctx?.prevWatchNext) qc.setQueryData(qk.watchNext, ctx.prevWatchNext);
      ctx?.prevShowEpisodes?.forEach(([key, data]: [any, any]) => qc.setQueryData(key, data));
      if (ctx?.prevEpisode) qc.setQueryData(qk.episode(id), ctx.prevEpisode);
    },
    onSettled: (_d, _e, id) => {
      qc.invalidateQueries({ queryKey: qk.episode(id) });
      qc.invalidateQueries({ queryKey: ['showEpisodes'] });
      qc.invalidateQueries({ queryKey: ['watchNext'] });
      invalidateLeaderboardSoon(qc);
    },
  });
};

/** Undo ONE viewing of a whole season (decrements watchCount of re-watched episodes). */
export const useUnwatchSeasonOnce = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/seasons/${id}/unwatch-once`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['showEpisodes'] });
      qc.invalidateQueries({ queryKey: ['show'] });
      qc.invalidateQueries({ queryKey: ['watchNext'] });
      qc.invalidateQueries({ queryKey: ['upcoming'] });
      invalidateLeaderboardSoon(qc);
      void refreshWidgets();
    },
  });
};

// ---------------- Episode voting (icon-based interaction sections) ----------------
// Four independent mutations, each operating only on its own slice of the
// ['episode', id] cache so sections never overwrite one another. Optimistic
// counts are recomputed deterministically; the server response reconciles.

type EpisodeInteractions = EpisodeDetailDto['interactions'];

/** Recompute a generic section (device / rating / reaction) after a vote change. */
function recomputeVoteSection(section: VoteSectionDto, to: string | null): VoteSectionDto {
  const { options, total } = applyVoteChange(section.options, section.total, section.userVote, to);
  return { userVote: to, total, options };
}

/** Recompute the character section (options keyed by castId, not `value`). */
function recomputeCharacterSection(
  section: CharacterVoteSectionDto,
  to: string | null,
): CharacterVoteSectionDto {
  const valueOpts = section.options.map((o) => ({ value: o.castId, count: o.count }));
  const { options, total } = applyVoteChange(valueOpts, section.total, section.userVote, to);
  return {
    userVote: to,
    total,
    options: options.map((o) => ({ castId: o.value, count: o.count })),
  };
}

/**
 * Recompute the multi-select reaction section after toggling one reaction.
 * `total` (distinct users) only changes when the user crosses zero<->nonzero.
 */
function recomputeReactionSection(
  section: ReactionVoteSectionDto,
  toggle: string,
): ReactionVoteSectionDto {
  // Defensive: tolerate an older single-select payload where userVotes is absent.
  const prevVotes = section.userVotes ?? [];
  const has = prevVotes.includes(toggle);
  const userVotes = has ? prevVotes.filter((v) => v !== toggle) : [...prevVotes, toggle];
  const hadAny = prevVotes.length > 0;
  const hasAnyNow = userVotes.length > 0;

  const options = section.options.map((o) => {
    if (o.value !== toggle) return o;
    return { ...o, count: Math.max(0, o.count + (has ? -1 : 1)) };
  });

  let total = section.total;
  if (!hadAny && hasAnyNow) total += 1;
  if (hadAny && !hasAnyNow) total = Math.max(0, total - 1);

  return { userVotes, total, options };
}

/** Coerce a possibly-older single-select reaction payload into the multi-select shape. */
function normalizeReactionSection(data: any): ReactionVoteSectionDto {
  if (data && Array.isArray(data.userVotes)) return data;
  const userVote = data?.userVote;
  return {
    userVotes: userVote ? [userVote] : [],
    total: data?.total ?? 0,
    options: data?.options ?? [],
  };
}

export function useEpisodeVotes(episodeId: string) {
  const qc = useQueryClient();
  const key = qk.episode(episodeId);

  const snapshot = () => qc.getQueryData<EpisodeDetailDto>(key);
  const apply = (fn: (old: EpisodeDetailDto) => EpisodeDetailDto) => {
    const prev = snapshot();
    qc.setQueryData<EpisodeDetailDto>(key, (old) => (old ? fn(old) : old));
    return { prev };
  };
  const merge = (section: keyof EpisodeInteractions, data: any) => {
    qc.setQueryData<EpisodeDetailDto>(key, (old) =>
      old ? { ...old, interactions: { ...old.interactions, [section]: data } } : old,
    );
  };

  const device = useMutation({
    mutationFn: (value: string) =>
      api.put<VoteSectionDto>(`/episodes/${episodeId}/vote/device`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      return apply((old) => ({
        ...old,
        interactions: {
          ...old.interactions,
          device: recomputeVoteSection(old.interactions.device, value),
        },
      }));
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => merge('device', data),
  });

  const rating = useMutation({
    mutationFn: (value: number) =>
      api.put<VoteSectionDto>(`/episodes/${episodeId}/vote/rating`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      return apply((old) => ({
        ...old,
        interactions: {
          ...old.interactions,
          rating: recomputeVoteSection(old.interactions.rating, String(value)),
        },
      }));
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => merge('rating', data),
  });

  const reaction = useMutation({
    mutationFn: (value: string) =>
      api.put<ReactionVoteSectionDto>(`/episodes/${episodeId}/vote/reaction`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      return apply((old) => ({
        ...old,
        interactions: {
          ...old.interactions,
          reaction: recomputeReactionSection(old.interactions.reaction, value),
        },
      }));
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => {
      // Adopt the server's authoritative counts/total, but keep the client's
      // userVotes so a server snapshot can never wipe an in-flight/optimistic
      // selection (the source of the "doesn't stay selected" flicker).
      const norm = normalizeReactionSection(data);
      qc.setQueryData<EpisodeDetailDto>(key, (old) => {
        if (!old) return old;
        const current = old.interactions.reaction;
        const userVotes = current?.userVotes ?? norm.userVotes;
        return {
          ...old,
          interactions: {
            ...old.interactions,
            reaction: { userVotes, total: norm.total, options: norm.options },
          },
        };
      });
    },
  });

  const character = useMutation({
    mutationFn: (value: string | null) =>
      api.put<CharacterVoteSectionDto>(`/episodes/${episodeId}/vote/character`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      return apply((old) => {
        if (!old.interactions.character) return old;
        return {
          ...old,
          interactions: {
            ...old.interactions,
            character: recomputeCharacterSection(old.interactions.character, value),
          },
        };
      });
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => merge('character', data),
  });

  return { device, rating, reaction, character };
}

export function useMovieVotes(movieId: string) {
  const qc = useQueryClient();
  const key = qk.movie(movieId);

  const rating = useMutation({
    mutationFn: (value: number) =>
      api.put<VoteSectionDto>(`/movies/${movieId}/vote/rating`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<MovieDetailDto>(key);
      qc.setQueryData<MovieDetailDto>(key, (old) =>
        old?.interactions
          ? {
              ...old,
              interactions: {
                ...old.interactions,
                rating: recomputeVoteSection(old.interactions.rating, String(value)),
              },
            }
          : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => {
      qc.setQueryData<MovieDetailDto>(key, (old) =>
        old ? { ...old, interactions: { ...old.interactions, rating: data } } : old,
      );
    },
  });

  const reaction = useMutation({
    mutationFn: (value: string) =>
      api.put<ReactionVoteSectionDto>(`/movies/${movieId}/vote/reaction`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<MovieDetailDto>(key);
      qc.setQueryData<MovieDetailDto>(key, (old) =>
        old?.interactions
          ? {
              ...old,
              interactions: {
                ...old.interactions,
                reaction: recomputeReactionSection(old.interactions.reaction, value),
              },
            }
          : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => {
      const norm = normalizeReactionSection(data);
      qc.setQueryData<MovieDetailDto>(key, (old) => {
        if (!old) return old;
        const current = old.interactions.reaction;
        const userVotes = current?.userVotes ?? norm.userVotes;
        return {
          ...old,
          interactions: {
            ...old.interactions,
            reaction: { userVotes, total: norm.total, options: norm.options },
          },
        };
      });
    },
  });

  return { rating, reaction };
}

export function useShowVotes(showId: string) {
  const qc = useQueryClient();
  const key = qk.show(showId);

  const rating = useMutation({
    mutationFn: (value: number) =>
      api.put<VoteSectionDto>(`/shows/${showId}/vote/rating`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ShowDetailDto>(key);
      qc.setQueryData<ShowDetailDto>(key, (old) =>
        old?.interactions
          ? {
              ...old,
              interactions: {
                ...old.interactions,
                rating: recomputeVoteSection(old.interactions.rating, String(value)),
              },
            }
          : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => {
      qc.setQueryData<ShowDetailDto>(key, (old) =>
        old ? { ...old, interactions: { ...old.interactions, rating: data } } : old,
      );
    },
  });

  return { rating };
}

export const useToggleMovieWatchlist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.post(`/movies/${id}/watchlist`, {}) : api.del(`/movies/${id}/watchlist`),
    onSuccess: (_d, vars) => {
      if (vars.on) logFirstEvent('first_movie_watchlist');
      qc.invalidateQueries({ queryKey: ['watchlist'] });
      qc.invalidateQueries({ queryKey: ['movie'] });
    },
  });
};

export const useMarkMovieWatched = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.post(`/movies/${id}/watched`, {}) : api.del(`/movies/${id}/watched`),
    onMutate: async ({ id, on }) => {
      const prevMovie = qc.getQueryData(qk.movie(id));
      qc.setQueryData(qk.movie(id), (old: any) =>
        old ? { ...old, watched: on, watchCount: on ? 1 : 0 } : old,
      );

      // watchlist entries carry { id, ... } keyed by mediaId; flip watched optimistically.
      const prevWatchlist = qc.getQueriesData({ queryKey: ['watchlist'] });
      prevWatchlist.forEach(([key, data]: [any, any]) => {
        if (!data) return;
        if (Array.isArray((data as any).items)) {
          qc.setQueryData(key, {
            ...(data as any),
            items: (data as any).items.map((it: any) =>
              it.id === id ? { ...it, watched: on } : it,
            ),
          });
        }
      });

      return { prevMovie, prevWatchlist };
    },
    onError: (_e, vars, ctx) => {
      if (ctx?.prevMovie) qc.setQueryData(qk.movie(vars.id), ctx.prevMovie);
      ctx?.prevWatchlist?.forEach(([key, data]: [any, any]) => qc.setQueryData(key, data));
    },
    onSuccess: (_d, vars) => {
      if (vars.on) logFirstEvent('first_watched_movie');
    },
    onSettled: () => {
      // Stats refresh is driven by the SWR stale flag + polling (no per-mark invalidation).
      qc.invalidateQueries({ queryKey: ['movie'] });
      qc.invalidateQueries({ queryKey: ['watchlist'] });
      qc.invalidateQueries({ queryKey: ['history'] });
      invalidateLeaderboardSoon(qc);
    },
  });
};

/** Record another viewing of an already-watched movie. */
export const useRewatchMovie = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ watchCount: number }>(`/movies/${id}/rewatch`, {}),
    onMutate: async (id: string) => {
      const prevMovie = qc.getQueryData(qk.movie(id));
      qc.setQueryData(qk.movie(id), (old: any) =>
        old ? { ...old, watchCount: Math.max(1, (Number(old.watchCount) || 1) + 1) } : old,
      );
      return { prevMovie };
    },
    onError: (_e, id, ctx) => {
      if (ctx?.prevMovie) qc.setQueryData(qk.movie(id), ctx.prevMovie);
    },
    onSettled: (_d, _e, id) => {
      qc.invalidateQueries({ queryKey: qk.movie(id) });
      invalidateLeaderboardSoon(qc);
    },
  });
};

/**
 * Reassign a movie to a different media entry (fixes a wrong match): the server moves
 * the user's watch state, ratings, and list membership onto the target movie and
 * returns a summary of what moved.
 */
export const useReassignMedia = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, targetMediaId }: { sourceId: string; targetMediaId: string }) =>
      api.post(`/movies/${sourceId}/reassign`, { targetMediaId }),
    onSuccess: (_data, { sourceId, targetMediaId }) => {
      qc.invalidateQueries({ queryKey: qk.movie(sourceId) });
      qc.invalidateQueries({ queryKey: qk.movie(targetMediaId) });
      qc.invalidateQueries({ queryKey: ['watchlist'] });
      qc.invalidateQueries({ queryKey: ['history'] });
      qc.invalidateQueries({ queryKey: ['favorites'] });
      qc.invalidateQueries({ queryKey: ['myLists'] });
    },
  });
};

export const useToggleWatchlist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.post(`/shows/${id}/watchlist`, {}) : api.del(`/shows/${id}/watchlist`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['watchlist'] });
      qc.invalidateQueries({ queryKey: ['show'] });
      // The Shows tab's "Watch List" and "Upcoming" sections are fed by these
      // queries, not ['watchlist'] — removing a show from the watchlist must
      // evict it from both.
      qc.invalidateQueries({ queryKey: ['watchNext'] });
      qc.invalidateQueries({ queryKey: ['upcoming'] });
      void refreshWidgets();
    },
  });
};

export const useToggleFavorite = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on, kind }: { id: string; on: boolean; kind: 'shows' | 'movies' }) =>
      on ? api.post(`/${kind}/${id}/favorite`, {}) : api.del(`/${kind}/${id}/favorite`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['favorites'] });
      qc.invalidateQueries({ queryKey: ['show'] });
      qc.invalidateQueries({ queryKey: ['movie'] });
      // Favorites drive for-you affinity.
      qc.invalidateQueries({ queryKey: qk.discover() });
    },
  });
};

export const useUpdateProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: any) => api.patch<CurrentUserDto>('/me', dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
};

async function uriToBlob(uri: string): Promise<Blob> {
  const res = await fetch(uri);
  return res.blob();
}

// Native FormData/XHR can't send Blobs ("Creating blobs from 'ArrayBuffer'…"),
// so native sends the { uri, name, type } file descriptor; web needs a real Blob.
function appendImageFile(fd: FormData, uri: string, name: string): Promise<void> | void {
  if (Platform.OS === 'web') {
    return uriToBlob(uri).then((blob) => {
      fd.append('file', blob, name);
    });
  }
  fd.append('file', { uri, name, type: 'image/jpeg' } as any);
}

export const useUploadAvatar = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (uri: string) => {
      const fd = new FormData();
      await appendImageFile(fd, uri, 'avatar.jpg');
      return api.post<{ url: string }>('/me/avatar', fd);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
};

export const useUploadCover = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (uri: string) => {
      const fd = new FormData();
      await appendImageFile(fd, uri, 'cover.jpg');
      return api.post<{ url: string }>('/me/cover', fd);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
};

export const useMarkNotificationRead = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, all }: { id?: string; all?: boolean }) =>
      all
        ? api.post('/me/notifications/mark-all-read', {})
        : api.patch(`/me/notifications/${id}/read`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: qk.notificationsUnreadCount });
    },
  });
};

export const useClearNotifications = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del('/me/notifications'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: qk.notificationsUnreadCount });
    },
  });
};

// ---------------- Import system ----------------
const TERMINAL = ['READY_FOR_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK'];

export const useUploadImport = () =>
  useMutation({
    mutationFn: (fd: FormData) =>
      api.post<{ importId: string; status: string }>('/imports/upload', fd),
  });

export const useImport = (id?: string) =>
  useQuery({
    queryKey: ['import', id],
    queryFn: () => api.get<any>(`/imports/${id}`),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = (q.state.data as any)?.status;
      return s && !TERMINAL.includes(s) ? 2500 : false;
    },
  });

/** Rating/emotion/comment summary for the import preview + result screens. */
export const useImportSummary = (id?: string) =>
  useQuery({
    queryKey: ['importSummary', id],
    queryFn: () => api.get<ImportExtraSummaryDto>(`/imports/${id}/summary`),
    enabled: !!id,
  });

// ---------------- Feature Flags ----------------
export const useFeatureFlags = () =>
  useQuery({
    queryKey: ['featureFlags'],
    queryFn: () => api.get<Record<string, boolean>>('/feature-flags'),
    staleTime: 5 * 60 * 1000, // 5 min cache
  });

// ---------------- Quick-setup onboarding ----------------
export const useUpdateOnboardingState = () =>
  useMutation({
    mutationFn: (dto: UpdateOnboardingStateDto) =>
      api.patch<OnboardingStateDto>('/me/onboarding', dto as any),
  });

/**
 * Bulk-apply quick-setup selections (one request for the whole draft). The server
 * marks onboarding COMPLETED on success, so callers should refreshUser() and clear
 * the local draft. Replay-safe: re-applying the same payload is a no-op server-side.
 */
export const useApplyOnboarding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: OnboardingApplyDto) =>
      api.post<OnboardingApplyResultDto>('/me/onboarding/apply', dto as any),
    onSuccess: () => {
      // Stats screens rely on the server stale-flag + polling (same convention as
      // single-entity marks) — no stats invalidation here.
      qc.invalidateQueries({ queryKey: qk.watchNext });
      qc.invalidateQueries({ queryKey: qk.upcoming });
      // "Top shows for you" gets its first taste signal from the apply.
      qc.invalidateQueries({ queryKey: qk.discover() });
      qc.invalidateQueries({ queryKey: ['show'] });
      qc.invalidateQueries({ queryKey: ['showEpisodes'] });
      qc.invalidateQueries({ queryKey: ['movie'] });
      qc.invalidateQueries({ queryKey: ['watchlist'] });
      qc.invalidateQueries({ queryKey: ['history'] });
      qc.invalidateQueries({ queryKey: qk.me });
      qc.invalidateQueries({ queryKey: qk.feed });
      refreshWidgets();
    },
  });
};

// ---------------- Announcements ----------------
export const useActiveAnnouncement = () =>
  useQuery({
    queryKey: ['activeAnnouncement'],
    queryFn: () => api.get<AnnouncementDto | null>('/announcements/active'),
    staleTime: 5 * 60 * 1000, // 5 min cache
  });

// A single large page instead of an infinite query: the review list's underlying set shifts
// as items change status, which breaks offset pagination and causes stale/duplicate rows.
export const useImportItems = (
  id: string,
  status: string | undefined,
  entity: string | undefined,
) =>
  useQuery({
    queryKey: ['importItems', id, status ?? 'all', entity ?? 'all'],
    queryFn: () =>
      api.get<{
        items: any[];
        total: number;
        page: number;
        pageSize: number;
        entityCounts?: Record<string, number>;
      }>(`/imports/${id}/items`, {
        status,
        entity,
        page: 1,
        pageSize: 500,
      }),
    enabled: !!id,
    // No placeholderData: after a status change / filter switch we'd otherwise briefly show the
    // previous (wrong) filter's rows. Correctness over flicker for the review list.
  });

/** Manually resolve a staged import item: match it to a media id, or skip it. */
export const usePatchImportItem = (importId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { itemId: string; matchedMediaId?: string; userResolution?: 'skip' }) =>
      api.patch<any>(`/imports/${importId}/items/${args.itemId}`, {
        matchedMediaId: args.matchedMediaId,
        userResolution: args.userResolution,
      }),
    // Invalidate the item list AND the import summary so the counts (needs_review, etc.) refresh.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['importItems'] });
      qc.invalidateQueries({ queryKey: ['import'] });
    },
  });
};

/** Resolve every unresolved item for the same source show at once ("apply to all episodes"). */
export const useResolveAllForShow = (importId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { matchedMediaId: string; sourceTitle: string; season?: number | null }) =>
      api.post<{ resolved: number; matched: number; needsReview: number }>(
        `/imports/${importId}/resolve-episodes`,
        {
          matchedMediaId: args.matchedMediaId,
          sourceTitle: args.sourceTitle,
          season: args.season ?? undefined,
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['importItems'] });
      qc.invalidateQueries({ queryKey: ['import'] });
    },
  });
};

/** Bulk-resolve the currently filtered review items by their source titles (server-verified). */
export const useResolveByName = (importId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { status?: string; entity?: string }) =>
      api.post<{ examined: number; resolved: number; stillUnresolved: number }>(
        `/imports/${importId}/resolve-by-name`,
        { status: args.status, entity: args.entity },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['importItems'] });
      qc.invalidateQueries({ queryKey: ['import'] });
    },
  });
};

export const useConfirmImport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ importId: string; created: number; skipped: number }>(
        `/imports/${id}/confirm`,
        {},
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['import'] }),
  });
};

export const useCancelImport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/imports/${id}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['import'] }),
  });
};

// ---------------- Comment images ----------------
export const useUploadCommentImage = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, uri }: { commentId: string; uri: string }) => {
      const fd = new FormData();
      fd.append('file', { uri, name: 'image.jpg', type: 'image/jpeg' } as any);
      return api.post<{ commentImageId: string; status: string }>(
        `/comments/${commentId}/image`,
        fd,
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comments'] }),
  });
};

export const useCommentImageStatus = (imageId: string | null) =>
  useQuery({
    queryKey: ['commentImageStatus', imageId],
    queryFn: () => api.get<any>(`/comment-images/${imageId}/status`),
    enabled: !!imageId,
    refetchInterval: (q) => {
      const s = (q.state.data as any)?.status;
      return s && !['ready', 'rejected', 'failed', 'deleted', 'needs_manual_review'].includes(s)
        ? 2000
        : false;
    },
  });

// ---------------- Leaderboard ----------------
export const useLeaderboard = (type: LeaderboardType, page: number, pageSize = 10) =>
  useQuery({
    queryKey: ['leaderboard', type, page, pageSize],
    queryFn: () =>
      api.get<LeaderboardPageDto>(
        `/me/stats/leaderboard?type=${type}&page=${page}&pageSize=${pageSize}`,
      ),
    placeholderData: keepPreviousData,
    // No refetchInterval: tab screens stay mounted, so a timer would poll every minute
    // for the rest of the session. The component refetches on focus instead (covers the
    // trailing leaderboard cache bust after watch activity).
  });

/** Prefetch the next page (if any) so arrow/swipe navigation is instant. */
export const usePrefetchLeaderboard = (
  type: LeaderboardType,
  page: number,
  totalPages: number,
  pageSize = 10,
) => {
  const qc = useQueryClient();
  useEffect(() => {
    if (page + 1 <= totalPages) {
      qc.prefetchQuery({
        queryKey: ['leaderboard', type, page + 1, pageSize],
        queryFn: () =>
          api.get<LeaderboardPageDto>(
            `/me/stats/leaderboard?type=${type}&page=${page + 1}&pageSize=${pageSize}`,
          ),
      });
    }
  }, [type, page, totalPages, pageSize, qc]);
};

export function formatWatchTime(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(mins / 60) % 24;
  const days = Math.floor(mins / (60 * 24)) % 30;
  const months = Math.floor(mins / (60 * 24 * 30)) % 12;
  const years = Math.floor(mins / (60 * 24 * 365));
  const parts: string[] = [];
  if (years > 0) parts.push(`${years}y`);
  if (years > 0 || months > 0) parts.push(`${months}mo`);
  if (years > 0 || months > 0 || days > 0) parts.push(`${days}d`);
  parts.push(`${hours}h`);
  return parts.join(' ');
}

// ---------------- Lists ----------------
export const useMyLists = () =>
  useQuery({ queryKey: ['myLists'], queryFn: () => api.get<any[]>('/me/lists') });

export const useFollowedLists = () =>
  useQuery({ queryKey: ['followedLists'], queryFn: () => api.get<any[]>('/me/followed-lists') });

// Infinite accumulation: pages append as the user scrolls (the old per-page useQuery
// swapped the whole list on every page advance, discarding already-loaded items).
export const useListItems = (id: string) =>
  useInfiniteQuery({
    queryKey: ['listItems', id],
    queryFn: ({ pageParam = 1 }) => api.get<any>(`/lists/${id}/items?page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last: any, pages: any[]) => (last?.hasMore ? pages.length + 1 : undefined),
    enabled: !!id,
  });

export const useToggleListLike = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/lists/${id}/like`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['list'] });
      qc.invalidateQueries({ queryKey: ['myLists'] });
    },
  });
};

export const useToggleListSub = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/lists/${id}/subscribe`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['list'] });
      qc.invalidateQueries({ queryKey: ['followedLists'] });
    },
  });
};

export const useToggleTrackingPause = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      paused
        ? api.post<{ trackingPaused: boolean }>(`/shows/${id}/pause`)
        : api.del<{ trackingPaused: boolean }>(`/shows/${id}/pause`),
    onSuccess: () => {
      // Paused shows leave watch-next/upcoming; the show detail carries the flag.
      qc.invalidateQueries({ queryKey: ['show'] });
      qc.invalidateQueries({ queryKey: ['watchNext'] });
      qc.invalidateQueries({ queryKey: ['upcoming'] });
    },
  });
};

export const useToggleListNotify = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/lists/${id}/notify`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['list'] }),
  });
};

export const useProviderCatalog = (country?: string) =>
  useQuery({
    queryKey: qk.providerCatalog(country),
    queryFn: () =>
      api.get<WatchProviderCatalogEntryDto[]>(
        `/watch-providers/catalog${country ? `?country=${country}` : ''}`,
      ),
    staleTime: 24 * 60 * 60 * 1000, // regional catalog changes rarely
  });

export const useProviderAlerts = (mediaId: string) =>
  useQuery({
    queryKey: qk.providerAlerts(mediaId),
    queryFn: () => api.get<ProviderAlertDto[]>(`/media/${mediaId}/provider-alerts`),
    enabled: !!mediaId,
  });

export const useSaveProviderAlert = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      mediaId,
      offerType,
      providerIds,
      country,
    }: {
      mediaId: string;
      offerType: ProviderOfferType;
      providerIds: number[];
      country?: string;
    }) =>
      api.put<ProviderAlertDto[]>(`/media/${mediaId}/provider-alerts/${offerType.toLowerCase()}`, {
        providerIds,
        country,
      }),
    onSuccess: (data, { mediaId }) => {
      qc.setQueryData(qk.providerAlerts(mediaId), data);
    },
  });
};

export const useRemoveProviderAlert = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ mediaId, offerType }: { mediaId: string; offerType: ProviderOfferType }) =>
      api.del<ProviderAlertDto[]>(`/media/${mediaId}/provider-alerts/${offerType.toLowerCase()}`),
    onSuccess: (data, { mediaId }) => {
      qc.setQueryData(qk.providerAlerts(mediaId), data);
    },
  });
};

export const useCreateList = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: {
      title: string;
      description?: string;
      visibility?: string;
      items?: string[];
    }) => api.post<any>('/me/lists', dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['myLists'] }),
  });
};

export const useAddListItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, mediaId }: { listId: string; mediaId: string }) =>
      api.post(`/lists/${listId}/items`, { mediaId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['listItems'] });
      qc.invalidateQueries({ queryKey: ['list'] });
    },
  });
};

export const useRemoveListItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, itemId }: { listId: string; itemId: string }) =>
      api.del(`/lists/${listId}/items/${itemId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['listItems'] });
      qc.invalidateQueries({ queryKey: ['list'] });
    },
  });
};

// ---------------- Users ----------------
export const useSearchUsers = (q: string) =>
  useQuery({
    queryKey: ['userSearch', q],
    queryFn: () => api.get<any[]>('/users/search', { q }),
    enabled: q.trim().length >= 2,
  });

export const usePublicProfile = (username: string) =>
  useQuery({
    queryKey: ['profile', username],
    queryFn: () => api.get<any>(`/users/${username}`),
    enabled: !!username,
  });

export const useFollows = (username: string, type: 'followers' | 'following') =>
  useQuery({
    queryKey: ['follows', username, type],
    queryFn: () => api.get<any[]>(`/users/${username}/follows?type=${type}`),
    enabled: !!username,
  });

export const useUserLists = (username: string) =>
  useQuery({
    queryKey: ['userLists', username],
    queryFn: () =>
      api.get<
        {
          id: string;
          title: string;
          description?: string | null;
          coverUrl?: string | null;
          showCount: number;
          movieCount: number;
          likeCount: number;
          subscriberCount: number;
        }[]
      >(`/users/${username}/lists`),
    enabled: !!username,
  });

export const useFollowUser = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post(`/users/${userId}/follow`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['userSearch'] });
      qc.invalidateQueries({ queryKey: ['follows'] });
    },
  });
};

export const useUnfollowUser = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.del(`/users/${userId}/follow`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['userSearch'] });
      qc.invalidateQueries({ queryKey: ['follows'] });
    },
  });
};
