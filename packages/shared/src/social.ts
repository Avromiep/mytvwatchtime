import { Paginated, PaginationQuery } from './common';
import { ListVisibility, MediaType } from './enums';
import { PublicUserDto } from './auth';

/** Sort order for comment feeds and reply threads. */
export type CommentSort = 'LATEST' | 'MOST_LIKED';

/** Image attachment metadata surfaced on a comment DTO. */
export interface CommentImageDto {
  id: string;
  status: string;
  width?: number | null;
  height?: number | null;
  blurhash?: string | null;
}

/** Media (show/movie) card attached to a comment. mediaId is the media_items id used by detail routes. */
export interface CommentMediaRefDto {
  mediaType: 'SHOW' | 'MOVIE';
  mediaId: string;
  title: string;
  posterUrl?: string | null;
  year?: number | null;
}

/** Custom-list card attached to a comment. */
export interface CommentListRefDto {
  id: string;
  title: string;
  coverUrl?: string | null;
  showCount: number;
  movieCount: number;
}

/** Community spoiler-flag threshold: at this many reports a comment becomes a spoiler. */
export const COMMENT_SPOILER_THRESHOLD = 5;

export interface CommentDto {
  id: string;
  parentId?: string | null;
  /** Nesting level within the thread: 0 = top-level, 1 = direct reply, etc. */
  depth: number;
  threadType: 'SHOW' | 'MOVIE' | 'EPISODE' | 'GROUP';
  threadId: string;
  author: PublicUserDto;
  body: string;
  imageUrl?: string | null;
  /** Final GIPHY media URL when the comment carries a GIF attachment (https *.giphy.com). */
  gifUrl?: string | null;
  image?: CommentImageDto | null;
  /** Attached show/movie card (mutually exclusive with image/GIF/list attachments). */
  media?: CommentMediaRefDto | null;
  /** Attached custom-list card (mutually exclusive with image/GIF/media attachments). */
  list?: CommentListRefDto | null;
  likesCount: number;
  /** Direct children count (not descendants). */
  repliesCount: number;
  likedByMe: boolean;
  reportedByMe: boolean;
  /** Community-confirmed (or author-marked/imported) spoiler — censored client-side. */
  isSpoiler: boolean;
  /** Spoiler-flag tally; `isSpoiler` flips at COMMENT_SPOILER_THRESHOLD. */
  spoilerCount: number;
  spoilerReportedByMe: boolean;
  /** True when the author soft-deleted the comment (tombstone): body/attachments are hidden. */
  deletedByUser: boolean;
  /** True when the comment has been edited at least once. */
  isEdited: boolean;
  editedAt?: string | null;
  createdAt: string;
}

export interface CommentQuery extends PaginationQuery {
  sort?: CommentSort;
}

/** Provider-authored review (TMDB) shown in media/episode comment threads. */
export interface ExternalReviewDto {
  id: string;
  provider: 'TMDB';
  author: string;
  username?: string | null;
  avatarUrl?: string | null;
  /** TMDB 1..10 author rating (null when the review has none). */
  rating?: number | null;
  content: string;
  /** Canonical TMDB review URL (badge link target). */
  url: string;
  createdAt: string;
  /** User replies posted against this review. */
  repliesCount: number;
}

export interface CommentRepliesQuery extends PaginationQuery {
  sort?: CommentSort;
  /**
   * How many levels of descendants to return, relative to the requested comment.
   * 1 (default) = direct children only (paginated). 2 = additionally each direct
   * child's first children (capped per parent), flat in the same items array;
   * `total` always counts direct children only.
   */
  depth?: 1 | 2;
}

export interface CreateCommentDto {
  threadType: 'SHOW' | 'MOVIE' | 'EPISODE' | 'GROUP';
  threadId: string;
  body?: string;
  imageUrl?: string;
  /** Final GIPHY media URL. Must be https and hosted on giphy.com / *.giphy.com. */
  gifUrl?: string;
  /** Attached show/movie card. Both fields required together; exclusive with imageUrl/gifUrl/listId. */
  mediaType?: 'SHOW' | 'MOVIE';
  mediaId?: string;
  /** Attached custom-list card. Exclusive with imageUrl/gifUrl/mediaType+mediaId. */
  listId?: string;
  parentId?: string;
  /** Author-marked spoiler — body is censored for readers. */
  isSpoiler?: boolean;
  /** Reply target: an external (TMDB) review id (alternative to parentId). */
  externalReviewId?: string;
}

export interface UpdateCommentDto {
  body?: string;
  /** Set to null to clear an existing GIF attachment. */
  gifUrl?: string | null;
  /** When true, detaches (deletes) the current image attachment. */
  detachImage?: boolean;
}

export interface PaginatedComments extends Paginated<CommentDto> {}

/** Thread context attached to comments in the "my comments" list. */
export interface MyCommentContextDto {
  threadType: 'SHOW' | 'MOVIE' | 'EPISODE' | 'GROUP';
  threadId: string;
  /** Display label: media title, "Show · S01E05" for episodes, or the group slug (localized client-side via `groups:names.<id>`). */
  label: string;
  /** Episode title for EPISODE threads. */
  sublabel?: string | null;
  mediaType?: 'SHOW' | 'MOVIE';
  /** Media id for SHOW/MOVIE threads and for an EPISODE thread's parent show. */
  mediaId?: string | null;
  episodeId?: string;
  groupId?: string;
}

export interface MyCommentDto extends CommentDto {
  context: MyCommentContextDto | null;
}

export interface PaginatedMyComments extends Paginated<MyCommentDto> {}

export interface RatingDto {
  mediaType: MediaType;
  mediaId: string;
  rating: number; // 1..5
}

export interface ReactionDto {
  episodeId: string;
  reaction: string;
}

export interface CharacterVoteDto {
  episodeId: string;
  characterId: string;
}

export interface CustomListSummaryDto {
  id: string;
  title: string;
  description?: string | null;
  coverUrl?: string | null;
  visibility: ListVisibility;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomListDto extends CustomListSummaryDto {
  items: {
    id: string;
    mediaType: MediaType;
    mediaId: string;
    title: string;
    posterUrl?: string | null;
  }[];
}

export interface CreateListDto {
  title: string;
  description?: string;
  coverUrl?: string;
  visibility?: ListVisibility;
}

export interface AddListItemDto {
  mediaType: MediaType;
  mediaId: string;
}

export interface FollowDto {
  userId: string;
}

export interface FollowCountsDto {
  followingCount: number;
  followersCount: number;
}

export interface ActivityItemDto {
  id: string;
  type: 'WATCHED' | 'RATED' | 'FAVORITED' | 'ADDED_LIST' | 'BADGE';
  text: string;
  mediaTitle?: string | null;
  mediaPoster?: string | null;
  createdAt: string;
}

export interface SearchQuery extends PaginationQuery {
  q: string;
  type?: MediaType | 'ALL';
}
