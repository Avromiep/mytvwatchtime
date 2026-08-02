# Social Systems — Comments, External Reviews, Spoilers, Voting, Account Deletion

Deep operational reference for the social domain. Relocated from `AGENTS.md`.
Summaries: `docs/DATA_MODEL.md` (voting), `docs/DOCUMENTATION.md` §13 (Comments & Images) and §21 (Data Export & Deletion).
Read this file BEFORE touching `apps/api/src/social/**`, `apps/api/src/users/**` deletion paths, `apps/mobile/components/voting/**`, or comment/review UI.

## Non-negotiable invariants

- Never delete a user row directly; use the anonymize-and-delete helper so comments and counters remain consistent.
- Character votes are keyed by `media_cast.id`/`cast_id`, never by character name.
- Voting percentages come from real aggregates and remain hidden until the user has voted in that category.
- Replies to comments or external reviews stay out of the top-level feed.
- Preserve localization, spoiler shielding, and profile-navigation restrictions for deleted users.

## External reviews (TMDB reviews as first-class thread roots)

- TMDB reviews: page-1 `reviews` from the hydration append is persisted to `external_reviews` (replace-per-target, `ExternalReviewsService.syncMediaReviews` in `persistShow/persistMovie`; TVDB hydrations carry none and are skipped). Targets synced before reviews existed are lazily backfilled when a comments thread opens (`reviewsSyncedAt` on MediaItem/Episode; never-synced → ONE light standalone fetch inline — `/movie|tv/{id}/reviews` or `/tv/{id}/season/{s}/episode/{e}/reviews`; stale >30d → background refresh; 404 = sync EMPTY, transient = stays unsynced). `GET /social/comments` merges the stored set as `externalReviews` on page 1 for SHOW/MOVIE/EPISODE threads; the mobile feed renders them below user comments with a TMDB badge that opens the canonical review URL (`ExternalReviewCard`). Reviews are first-class thread roots: they merge INTO the main feed as pseudo-comments (`kind='review'`, TMDB badge, pseudo author) sorted with the comments (page-1 merge, capped 10). Users like them (`external_review_likes` + denormalized `likesCount`, POST/DELETE `/social/external-reviews/:id/like`) and open a full thread page (`/review/[id]` mobile route; header = `GET /social/external-reviews/:id` with thread target + likedByMe). Users reply via `Comment.externalReviewId` (FK; alternative to `parentId`, validated on create) — review replies are EXCLUDED from the top-level feed (`externalReviewId: null` in the list query) exactly like comment replies, `GET /social/external-reviews/:id/replies` lists them, nested replies use `parentId` normally.

## Comment spoilers

- Comment spoilers: `Comment.isSpoiler` + `Comment.spoilerCount` + `comment_spoiler_reports` (one row per user+comment). Community flagging via `POST /social/comments/:id/spoiler-report` (idempotent, no self-reports); `isSpoiler` flips at `COMMENT_SPOILER_THRESHOLD = 5` (shared constant in `packages/shared/src/social.ts`). Authors self-mark at creation (`isSpoiler` on the create DTO; composer eye-off toggle). Imported spoiler state comes from TV Time `is_spoiler`/`spoiler_count` columns. The DTO carries `isSpoiler`/`spoilerCount`/`spoilerReportedByMe`; mobile `CommentCard` censors spoiler comments behind a "view anyway" cover (per-card session state, body + attachments hidden).

## Episode interaction voting (IMPORTANT)

- Four categories on watched episodes: **device** / **rating** / **reaction** (multi-select) / **character** (single-select). Writes are upsert-style — one active vote per user+episode+category, except reactions which toggle on/off (`reactions` table, one row per user+episode+reaction).
- **Character vote is keyed by `cast_id`** (FK → `media_cast.id`). NEVER key it by character name (breaks on duplicate names, multi-role actors, renames). The cast DTO exposes `creditId` = `media_cast.id` for this.
- **Percentages are hidden until the user votes** in that category (`reveal = userVote != null` / `userVotes.length > 0`). Once voted, every option's percentage shows; returning voters see them immediately. Percentages come from **real aggregates** (never hardcoded). Single-select categories use largest-remainder (sum to 100); multi-select reactions use independent rounding.
- Client state: `useEpisodeVotes` runs four independent optimistic mutations, each on its own slice of the `['episode', id]` cache (sections never overwrite each other), with rollback on error and server reconcile on success. Do NOT invalidate/refetch the whole episode on a vote.
- Reusable components live in `apps/mobile/components/voting/`; the math is in `packages/shared/src/vote-math.ts` (shared by API + mobile).

## Account deletion (anonymize-and-delete)

- Every path (`DataDeletionService.confirmDeletion`, `UsersService.deleteMe`, and audited Admin user deletion) calls `anonymizeAndDeleteUser` (`apps/api/src/users/lib/deleted-user.ts`). Never delete a user row directly.
- New deletions create ONE unique, suspended, non-login shadow identity per deleted account. A shared ghost cannot own ratings/reactions/votes because their per-user unique constraints would collide across deleted people. The legacy shared `deleted-user@system.local` account remains supported for older comments.
- Before deleting the original row, the helper reassigns only comments that are ancestors of a reply authored by another account. It deletes comments without surviving replies, including an all-self-authored branch; actual tree rows, not the denormalized `repliesCount`, decide this. Preserved comment-image ownership moves to the ghost, and affected surviving parents have `repliesCount` rebuilt. Media/episode ratings, media/episode reactions, and character votes also move to the unique ghost. Episode/movie status rows carrying a `device` vote are reassigned, but `watched=false`, `watchedAt=null`, and `watchCount=0`; status rows without a device vote cascade away. Thus aggregate “where did you watch?” votes survive without retaining viewing history.
- The original user is then deleted so credentials, auth providers, profile, devices, show/progress state, history, watchlist, favorites, custom lists, follows/blocks, notifications, provider alerts, imports, badges/stats, reports, and contacts follow their existing cascades. Password-reset tokens are deleted, deletion-request email/user references are anonymized, queued push jobs are deleted explicitly, and `ExportService.deleteForUser` removes still-downloadable export files plus their records because those tables do not have a User FK.
- Denormalized comment `likesCount`/`spoilerCount` and external-review `likesCount` are decremented for the deleted user's removed likes/reports. Comments required by another account's replies survive because their author moves before the original user is deleted; all other comments are deleted.
- Clients recognize both legacy and per-deletion ghosts through `PublicUserDto.isDeletedUser` (set in `mapPublicUser`): localized `common:deletedUser` label, no profile navigation, and no avatar. Generated deleted-ghost emails are reserved from registration/authentication. Shadow identities are excluded from Admin user counts/listings.
- RECLAIM: if the same person re-registers and re-imports, `applyComments` returns their comments — a staged OWNER-authored candidate whose `(source, sourceKey)` exists under either a legacy or per-deletion ghost is reassigned to the importing user instead of dedupe-skipped (guarded by the exact old `userId`; third-party/shadow candidates never reclaim; no audit rows so rollback cannot delete the pre-existing comments).
- Admin deletion is `DELETE /admin/users/:id` (ADMIN+), requires the exact username in `confirmUsername`, prevents self/SUPER_ADMIN/deleted-shadow deletion, requires SUPER_ADMIN for staff targets, uses the same helper, and writes a `delete_user` audit record with preservation totals.
