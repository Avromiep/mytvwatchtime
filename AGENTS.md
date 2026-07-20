# AGENTS.md — how to work in this repo

## Stack
- Monorepo: pnpm workspaces. Apps in `apps/*`, shared packages in `packages/*`.
- Mobile: `@tvwatch/mobile` (Expo SDK 54 + Expo Router 6). TypeScript + React Native.
- API: `@tvwatch/api` (NestJS 10 + Prisma 5 + PostgreSQL 16 + Redis 7 + BullMQ).
- Admin: `@tvwatch/admin` (Next.js 14 + Tailwind + Recharts).
- Shared: `@tvwatch/shared` (types/contracts used by both apps, CJS dist).

## Common commands
- Install: `pnpm install`
- Infra: `docker compose up -d` (Postgres, Redis, MinIO)
- DB: `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:seed`
- Dev: `pnpm dev:api`, `pnpm dev:mobile`, `pnpm --filter @tvwatch/admin dev`
- Validate: `pnpm typecheck`, `pnpm lint`, `pnpm test`
- After schema changes: `$env:DATABASE_URL="..."; pnpm --filter @tvwatch/api prisma db push --accept-data-loss; pnpm --filter @tvwatch/api prisma generate`
- Data-migrating schema changes: `prisma db push` only applies DDL diffs — it CANNOT run backfill SQL (it will offer to reset the DB instead). For migrations that transform existing rows (e.g. `20260712195500_episode_voting` re-keying `character_votes.character_name` → `cast_id`), apply the migration SQL directly, then `db push` is a no-op:
  ```powershell
  pnpm --filter @tvwatch/api prisma db execute --file prisma/migrations/<migration>/migration.sql --schema prisma/schema.prisma
  pnpm --filter @tvwatch/api prisma db push   # no-op once the DB matches the schema
  ```

## Required builds after changes but ask user to confirm
- If any API code, API dependency, Prisma schema, shared backend contract, or API Dockerfile/configuration changes, rebuild and publish the API image from the repository root:
  ```powershell
  docker build --no-cache -t ghcr.io/metalingus/tvwatch-api:latest -f apps/api/Dockerfile .
  docker push ghcr.io/metalingus/tvwatch-api:latest
  ```
- If any web-facing code in `apps/mobile` or a shared package used by the web app changes, rebuild the Expo web export from `apps/mobile`:
  ```powershell
  npx expo export --platform web --output-dir ../app-web
  ```
- Do not claim a build succeeded unless the corresponding command completed successfully. Report any build or push failure with the relevant error.

## Conventions
- Always import shared types from `@tvwatch/shared` — do not duplicate DTOs across apps.
- The Prisma schema (`apps/api/prisma/schema.prisma`) is the source of truth for the data model. Regenerate after edits: `pnpm db:generate`.
- TMDB hydration is ONE call per entity: `TmdbProvider.getShow/getMovie` use `append_to_response` (external_ids, credits, watch/providers, videos, **keywords, translations, reviews**, + up to 13 `season/N` appends — TMDB caps appends at 20; longer shows fall back to per-season calls for the tail). `ensureShowFull/ensureMovieFull` hydrate the English base from that single call (no second en fetch) and bulk-store all translation locales as overrides; non-en requests additionally run `applyLocaleOverrides` for episode-level text. Show/Movie `keywords` (JSON) are persisted and the TMDB `anime` keyword (id 210024) is decisive: it short-circuits Kitsu/Jikan matching (no provider calls) → ANIME/confirmed at 0.9. Old rows with `keywords = null` get ONE light `/keywords` lookup before any Kitsu/Jikan call (result persisted; `[]` = checked-none, never re-checked; provider error = stays eligible).
- TMDB reviews: page-1 `reviews` from the hydration append is persisted to `external_reviews` (replace-per-target, `ExternalReviewsService.syncMediaReviews` in `persistShow/persistMovie`; TVDB hydrations carry none and are skipped). Targets synced before reviews existed are lazily backfilled when a comments thread opens (`reviewsSyncedAt` on MediaItem/Episode; never-synced → ONE light standalone fetch inline — `/movie|tv/{id}/reviews` or `/tv/{id}/season/{s}/episode/{e}/reviews`; stale >30d → background refresh; 404 = sync EMPTY, transient = stays unsynced). `GET /social/comments` merges the stored set as `externalReviews` on page 1 for SHOW/MOVIE/EPISODE threads; the mobile feed renders them below user comments with a TMDB badge that opens the canonical review URL (`ExternalReviewCard`). Reviews are first-class thread roots: they merge INTO the main feed as pseudo-comments (`kind='review'`, TMDB badge, pseudo author) sorted with the comments (page-1 merge, capped 10). Users like them (`external_review_likes` + denormalized `likesCount`, POST/DELETE `/social/external-reviews/:id/like`) and open a full thread page (`/review/[id]` mobile route; header = `GET /social/external-reviews/:id` with thread target + likedByMe). Users reply via `Comment.externalReviewId` (FK; alternative to `parentId`, validated on create) — review replies are EXCLUDED from the top-level feed (`externalReviewId: null` in the list query) exactly like comment replies, `GET /social/external-reviews/:id/replies` lists them, nested replies use `parentId` normally.
- Mobile NEVER calls third-party media APIs directly. All media data flows through the backend, which normalizes + caches external IDs.
- Use snake_case only in DB column names via Prisma `@map`. In code/TS use camelCase.
- Prettier config is at repo root (`.prettierrc.json`). Single quotes, trailing comma all, 100 width.
- Env vars: read via NestJS `ConfigService`. Never hardcode secrets.
- Special seasons (S0, `isSpecial = true`) are excluded from ALL counts, progress, and watch-next queries.
- Aired episodes only: unaired episodes (`airDate > now`) are excluded from progress bars and watch-next counts.
- Multi-network shows: `shows.network` stays ONE string column, but hydration joins up to 2 network names with ` · ` (`NETWORK_SEPARATOR`) — TMDB from `networks[]`, TVDB from `companies[]` filtered to Network type (`companyTypeId = 1`, studios skipped) with `originalNetwork` fallback. Shared helpers in `packages/shared/src/media.ts`: `formatNetworks` (storage) / `firstNetwork` (display). Episode details render the full joined string; compact surfaces (watch-next/upcoming cards, Android widgets via `widgets/data.ts`, iOS widgets via a Swift-side split) show the first network only.
- Animation-genre shows (genre slug `animation` OR English name — localized genre rows exist from non-en hydrations; `upsertGenres` index-matches the English list for TVDB so new rows keep the canonical slug) are TVDB-authoritative everywhere. The single repair path is `MetadataBackfillService.fixAnimeShowFromTvdb(mediaId)` — resolve TVDB id → force TVDB hydration (bypasses the 24h staleness gate) → `StructureRemapService.remapShow` — shared by the daily `anime_tvdb_rehydrate` cron (`rehydrateAnimeFromTvdb`, stops early on TVDB rate limits), backfill `hydrateOne`, and the show detail + episodes endpoints (`ShowsService.getShow`/`getSeasons`; cheap no-op once fixed (a kept-unmapped count in `metadataProvenance.animeTvdbKeptUnmapped` prevents re-hydration loops over preserved leftover rows; new stale rows re-arm it); concurrent calls COALESCE into one repair via an inflight map so parallel detail+episodes requests both answer post-fix; animation shows never refresh from TMDB). TMDB Changes sync skips them. "Needs repair" = ≥1 stale episode row (has TMDB episode external id, lacks THE_TVDB — fresh rows carry both, so partially-switched shows still count). Missing TVDB ids resolve in trust order: stored `ExternalId` → TMDB `/tv/{id}/external_ids` cross-id (authoritative; claimed-by-another-row = duplicate, skip) → strict title+year TVDB search. The remap transfers user watch data (statuses/history/ratings/reactions/votes/comments) by airDate then exact-title matching; ambiguous/unmatched rows with user data are KEPT, never dropped. Admin: Metadata Health `animeOnTmdb` stat + `POST /admin/anime-tvdb-rehydrate/run`.
- Anime classification checks (Kitsu/Jikan `matchAnime`): a FAILED match never persists a degraded classification — `anime-hydrate` rethrows and BullMQ retries (attempts 5, exponential 2min base ≈ 1h window, so provider-saturation waves don't retry-storm), then the next hydration-versioned classify re-runs. A SUCCESSFUL no-match persists (GENERAL = not-anime tag) and is not re-checked until new hydration data arrives. A confirmed ANIME verdict is terminal — `animeHydrate` returns early (no Kitsu/Jikan re-match on re-hydration bumps). Cast-purpose TVDB rehydrations (`backfillCharacterIds`, import `tvdb-rehydrate`) call `ensureShowFullTvdb(..., { skipClassification: true })` — the anime evidence doesn't change from a same-provider cast refresh, and the enqueue storm was saturating Jikan ("concurrency timeout for jikan" — its semaphore is concurrency 2 with a 30s acquire timeout).
- Cross-type contamination (a MOVIE row carrying a `shows` row or vice versa, e.g. a TVDB series id attached to a TMDB movie row): prevented by kind-aware `findMediaByExternal(provider, value, kind)` (TMDB/TVDB ids live in separate movie/series namespaces) + type guards in `persistShow`/`persistMovie` (wrong-type existing → create a new row, never merge). Cured by `MetadataBackfillService.repairTypeMismatches` (Metadata Health `structuralTypeMismatch` stat + `POST /admin/repair-type-mismatch/run`): detach stray-kind external id → recreate the correct entity → `StructureRemapService.remapEpisodesToMedia` transfers watch data → stray structure deleted only after an explicit check that NO stray episode still carries user data (status/rating/reaction/vote/comment — guards the empty-target partial-fetch case) → own-provider rehydration restores base metadata.
- TVDB-id conflicts (a row carrying MORE THAN ONE TVDB id of the same kind): benign TVDB-merge leftovers vs id poisoning from the old `lightUpsertShowTvdb/lightUpsertMovieTvdb` title-attach (removed — unknown id = new row, never attach by title). Metadata Health `multiTvdbIds` stat + `POST /admin/repair-tvdb-id-conflicts/run` (`repairTvdbIdConflicts`): every id is verified via TMDB `/find` — all ids mapping to the SAME TMDB entity are kept (merge leftovers); when they map to different entities, the id matching the row's own TMDB id stays and the others are detached; indecisive rows are reported as ambiguous, never guessed. Detaching an external id NEVER deletes user data — it only stops future lookups from resolving to the wrong row.
- Non-English base titles (rows whose base/override was written in the wrong language — old contamination that makes English users see foreign titles): Metadata Health `nonEnglishBase` stat (rows explicitly marked `title_locale != 'en'` — rows with an UNSET marker are NOT counted since most have a fine English base; rows marked 'en' with wrong content are SQL-undetectable but heal the same way on re-hydration) + `POST /admin/repair-non-english-base/run` (`repairNonEnglishBase`): clears `metadataRefreshedAt` and re-runs the standard hydration (TMDB id first, TVDB fallback) — `persistShow/persistMovie` rewrite the English base and overwrite the wrong value in the `en` slot. User data untouched.
- The app reads `POSTGRES_*` and `REDIS_*` env vars directly (passwords with special chars are fine). `DATABASE_URL` is only for the Prisma CLI — URL-encode special chars there.

## Adding a backend module
1. Add models to `schema.prisma` + run `pnpm db:generate` and a migration.
2. Create `module`/`service`/`controller`/`dto` under `apps/api/src/<module>`.
3. Use `@CurrentUser()` decorator + `JwtAuthGuard` for authenticated routes.
4. Export the module from `AppModule`.

## Adding a mobile screen
1. Add route under `apps/mobile/app/` (Expo Router file-based).
2. Fetch via `apps/mobile/api/client.ts` (`api.get`/`api.post`) which injects the JWT.
3. Use the shared theme (`apps/mobile/theme/theme.ts`) + component system in `apps/mobile/components`.
4. Respect dark theme + safe areas.
5. Icons: `@expo/vector-icons` (Ionicons).
6. Images: `expo-image` `Image` (NOT React Native Image, NOT `PosterImage` for search results — use `expo-image` directly with `contentFit="cover"`).

## Localization and theme requirements
- All user-facing text must use the existing translation/i18n system. Do not introduce hardcoded UI strings when a translation key should be used.
- When adding or changing user-facing copy, add or update the key in every supported locale. Check for missing, stale, or fallback-only translations before finishing.
- Reuse existing translation keys when their meaning matches; keep key names consistent and descriptive.
- All colors, spacing, typography, radii, shadows, and other visual values must come from the shared theme/design tokens whenever a token exists. Do not add unexplained hardcoded visual values.
- Components must work with the supported light, dark, and system-selected themes. Verify contrast and state styling in both light and dark modes.

## Mobile grid pattern (IMPORTANT)
- NEVER use `FlatList numColumns` or `flexWrap` + `gap` — both cause bugs on Android.
- Use chunked rows: split items into arrays of N, render each row as a `<View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>`, add invisible spacer Views for incomplete rows.
- `PosterCard` accepts a `style` prop — pass `{ marginRight: 0 }` inside grids.
- For large lists (100+ items): use FlatList with `initialNumToRender`, `maxToRenderPerBatch`, `windowSize`.

- Comment spoilers: `Comment.isSpoiler` + `Comment.spoilerCount` + `comment_spoiler_reports` (one row per user+comment). Community flagging via `POST /social/comments/:id/spoiler-report` (idempotent, no self-reports); `isSpoiler` flips at `COMMENT_SPOILER_THRESHOLD = 5` (shared constant in `packages/shared/src/social.ts`). Authors self-mark at creation (`isSpoiler` on the create DTO; composer eye-off toggle). Imported spoiler state comes from TV Time `is_spoiler`/`spoiler_count` columns. The DTO carries `isSpoiler`/`spoilerCount`/`spoilerReportedByMe`; mobile `CommentCard` censors spoiler comments behind a "view anyway" cover (per-card session state, body + attachments hidden).

## Episode interaction voting (IMPORTANT)- Four categories on watched episodes: **device** / **rating** / **reaction** (multi-select) / **character** (single-select). Writes are upsert-style — one active vote per user+episode+category, except reactions which toggle on/off (`reactions` table, one row per user+episode+reaction).
- **Character vote is keyed by `cast_id`** (FK → `media_cast.id`). NEVER key it by character name (breaks on duplicate names, multi-role actors, renames). The cast DTO exposes `creditId` = `media_cast.id` for this.
- **Percentages are hidden until the user votes** in that category (`reveal = userVote != null` / `userVotes.length > 0`). Once voted, every option's percentage shows; returning voters see them immediately. Percentages come from **real aggregates** (never hardcoded). Single-select categories use largest-remainder (sum to 100); multi-select reactions use independent rounding.
- Client state: `useEpisodeVotes` runs four independent optimistic mutations, each on its own slice of the `['episode', id]` cache (sections never overwrite each other), with rollback on error and server reconcile on success. Do NOT invalidate/refetch the whole episode on a vote.
- Reusable components live in `apps/mobile/components/voting/`; the math is in `packages/shared/src/vote-math.ts` (shared by API + mobile).

## Mobile push notifications
- `usePushNotifications(enabled)` hook in `apps/mobile/hooks/usePushNotifications.ts`.
- Called from `(tabs)/_layout.tsx` with `enabled = !!user`.
- Expo Go: works via Expo Push API with `EXPO_ACCESS_TOKEN`.
- Dev build: requires Firebase `google-services.json` in `android/app/` + gradle plugins in both `build.gradle` files.
- Self-hosted: `PUSH_MODE=relay` sends through public server's `/api/push/relay` endpoint.
- Episode notifications spread across afternoon (noon→3pm→4pm...), computed **per user in their device timezone** (devices register with `timezone` from `Intl.DateTimeFormat().resolvedOptions().timeZone`; latest active device wins, then `NotificationPreference.timezone`, then server tz). "Today" is the user's local day (`common/utils/timezone.util.ts` — Intl-based, DST-safe). Devices re-register on every app start, which also backfills tz for pre-feature users.

## Self-hosted backend support
- Mobile app has a "Self-hosted backend" checkbox on login/register.
- When checked: hides social login, shows URL input, stores URL in SecureStore.
- API client reads base URL from SecureStore via `getBaseUrl()` in `apps/mobile/api/client.ts`.
- Backend URL editable in Settings page.
- `PUBLIC_API_URL` in `app.json` (extra.publicApiUrl) is constant — used for push relay only.
- `SITE_URL` in `.env` is used for data deletion + password reset email links.

## OAuth flow
- Mobile app opens browser via `WebBrowser.openBrowserAsync()` to Google/Facebook OAuth.
- Redirect URI: `{API_BASE}/auth/oauth-callback` (backend endpoint).
- Backend receives code → 302 redirect to `tvwatchtime://expo-auth-session?code=xxx`.
- Mobile `expo-auth-session.tsx` route captures code via `useLocalSearchParams()`.
- No Expo auth proxy — uses app's own domain.

## Admin console
- Next.js App Router under `apps/admin/app/(admin)/`.
- Auth: JWT stored in localStorage, axios interceptor injects Bearer token. Login has a "Stay connected" checkbox → `/auth/login` with `rememberMe: true` → 30d access token (`JWT_REMEMBER_TTL`, default `30d`; normal logins keep `JWT_ACCESS_TTL` 15m).
- `API_URL` env var (runtime, NOT `NEXT_PUBLIC_*`) — injected into HTML via `layout.tsx`.
- Role-based: `useAuth()` hook, sidebar items filtered by role.
- Settings are AES-256-GCM encrypted in DB (SettingService).
- Feature flags enforced server-side (FeatureFlagService).
- Moderation page at `/moderation` for MODERATOR+ roles.
- Scheduled Jobs (`/cron`): DB-driven via CronManagerService (node-cron). Each job has an optional **IANA timezone** (stored on `CronJob.timezone`, null = server default) applied at scheduling; schedules are edited through a friendly frequency picker (`apps/admin/components/SchedulePicker.tsx`, custom cron stays available). Every run persists an outcome summary in `CronJobRun.result` (rendered as the Report column in history). Jobs execute ONLY through CronManager — never add `@Cron` decorators for DB-managed jobs (the NotificationScheduler methods are decorator-free for exactly this reason).
- Auto Hydrations (`/scheduled-hydrations`): each row is its own dynamic node-cron job with its own schedule + timezone (`CronManagerService.syncHydrationSchedules` at boot + hourly resync). Rows do NOT fire in a shared hourly batch. Run reports land on the Jobs page (`HydrationJob` tracking).
- TMDB Changes sync: `POST /admin/tmdb-changes/run?start=YYYY-MM-DD` runs a one-off custom range WITHOUT moving the Redis cursor (`TMDB_CHANGES_LAST_RUN`); the daily cron keeps its progression.

## Import system
- TVTime GDPR export: `seen_episode_source.csv` + `tracking-prod-records.csv` (v1+v2) + `user_tv_show_data.csv` + `followed_tv_show.csv` + `lists-prod-lists.csv`.
- v2 per-episode rows → WATCHED_EPISODE. v2 summary rows → WATCHLIST_SHOW.
- Lists + favorites: `lists-prod-lists.csv` has three row kinds — metadata (`collection`/`count`), favorites pseudo-lists (`s_key` = `favorite-series`/`favorite-movies` → NOT lists: staged as FAVORITE_SHOW/FAVORITE_MOVIE items, applied by the shared favorites pipeline, deduped by mediaId), and real custom lists (`s_key` = uuid → `CustomList` with `source=TVTIME`, identity by `(userId, source, sourceKey)`). Unnamed list rows recover their title from the `collection` row's `lists` blob (a Go-map dump mapping s_key→name; `parseGoMaps` in `lib/list-objects.ts`). Series objects carry a TVDB `id` → matched through the id-authority gate (title search only when a name exists in the `{tv_show_id→name}` map — never title-match a placeholder). Movie objects carry ONLY a `uuid` → resolved via `buildMovieUuidNameMap` (uuid→name recovered from v1 tracking / ratings-live / emotions-live rows). No-identity objects (unknown uuid, dead id without name) are counted in the list's `unresolvedCount`, NEVER staged (a title-less row is unreviewable noise). Visibility defaults PRIVATE. Re-import updates metadata + adds missing items; manual lists untouched. Legacy cleanup: pre-fix imports created CustomLists with sourceKey `favorite-series`/`favorite-movies` — every TVTIME confirm runs `migrateFavoritePseudoLists` (items → real Favorite rows deduped by mediaId, then the pseudo-lists are deleted; idempotent). See `lib/list-objects.ts` + `lib/lists.ts`.
- Ratings: episode/movie vote files (`ratings-*-votes`) use the verified `stars_wording_scalev2` set (id→star via final `vote_key` segment; UUID movie keys split on last `-` only). `tv_show_rate.csv` → direct 1–5 show rating (out-of-range skipped). Unknown ids/sets skipped with warnings, never guessed. Conflict policy: never overwrite manual/local ratings; idempotent via `source=TVTIME`+`sourceKey`. See `lib/ratings.ts`. NOTE: `tv_show_rate.csv` is also explicitly in `SKIP_PATTERNS` (`"rate"` ≠ `"rating"`) — without it the main watched-content pipeline misclassifies the file as `generic_movie_watched` and fabricates WATCHED_MOVIE items (the Sense8 regression). Cross-type safety is layered on top: `matchByTvdbId` refuses matches whose resolved media type ≠ item type, and `applyBatch` runs a batched type guard (wrong-type items dropped + logged). Existing wrong-type rows (`user_movie_status` / `watch_history(MOVIE)` on SHOW rows) are purged by the type-mismatch repair (Metadata Health `movieDataOnShows` stat).
- Emotions: `emotions-*-votes` use the verified `12_all` set (id 36 → enum `UNDERSTANDING`). Legacy `episode_emotion.csv` ids (1,3,6,7,…) are unsupported. Multiple emotions per target retained; additive apply (never removes existing); `tv_show_user_emotion_count.csv` is an aggregate, skipped. See `lib/emotions.ts`.
- Character votes: `show_character_episode_vote.csv` → `EPISODE_CHARACTER_VOTE` (favorite character per episode). Episodes resolve via the standard chain (TVDB episode id → `episode_external_ids` → S/E → TMDB `/find`). Characters resolve **fully locally** via `media_cast.characterExternalId` (TVDB character id, written by TVDB hydration into top-20 cast; `slice(0,20)` caveat) — zero provider calls per vote. Shows whose cast predates the field are queued for ONE background TVDB re-hydration each (`tvdb-rehydrate` BullMQ job — stable id dedupe, 5 attempts, exponential 2min backoff) so the import apply NEVER blocks on TVDB; their votes stay MATCHED and apply on a later confirm. Unresolvable characters (beyond top-20, or id-type mismatch) count `characterVotesSkippedUnresolved`. Conflict policy mirrors ratings: `source`+`sourceKey` (`episode:<tvdbEpId>:char:<showCharacterId>`) idempotent; existing votes (manual or different character) NEVER overwritten. Concurrent cast rewrites (a queued rehydrate landing mid-apply) are guarded: castIds are re-validated inside the insert transaction (plus one retry on FK error P2003); vanished rows degrade to PENDING_MATCH instead of failing the apply. Dedupe by (episode, character) keeping latest `updated_at`; historical `created_at` preserved. See `lib/character-votes.ts` + `applyCharacterVotes` in `import.service.ts`. Old casts are backfilled via Metadata Health `castMissingCharacterIds` stat + `POST /admin/cast-character-ids/run` (`backfillCharacterIds` — one TVDB hydration per show, rate-limit early stop).
- Comments: FULL-THREAD import (`comments-prod-comments.csv` + legacy `episode_comment.csv` + `show_comment.csv`) — owner-authored AND third-party comments, top-level AND replies. Owner resolved from `user.csv`/`user_personal_data.csv` (unresolvable → whole file skipped, safe). Embedded `replies` blobs, likes, reports, read markers, translations, profile-wall comments still skipped+counted. Third-party authors get deterministic SHADOW accounts (`users.isShadow`, email `shadow+<source>-<externalId>@shadow.local`, stable generated username from `lib/shadow-user.ts`) — shared across imports, so the same author imported from two archives is one identity; re-import dedupes by (author, source, sourceKey). Legacy files without `user_id` attribute to the owner. Replies keep their parent link: parent resolved in-batch (topological passes) or from the DB by (source, sourceKey); a reply whose parent is missing stores `parentSourceKey` (the parent's staged sourceKey, `tvtime|<uuid>`) and is linked later by `reconcileCommentParents` — which runs after every comments apply, so a parent imported later (even by a DIFFERENT user) completes threads retroactively. Episode → episode thread; show-page (`show_comment.csv`, v2 `entity_type=series/show`) → show thread; movie → movie thread. Visual attachments from the `image` column: **GIFs** stored by URL (`comment.gifUrl`); **static images** (png/jpg) downloaded + fed through the `CommentImage` pipeline (`CommentImageService.attachFromBuffer` → resize/encrypt/store/moderate), same as user-uploaded pictures; image-only comments are imported too. Created directly via Prisma (no `comment.created` event → no badges, no notifications); historical timestamps preserved; `source=TVTIME`+`sourceKey` for idempotent re-import. Dedupe is multi-key: a candidate merges with an earlier one if ANY collide — source identity (uuid / legacy `id`), the canonical numeric comment id (v2 `comment_id` column, rare legacy-era backfill, or any bare-numeric source id), or a content fingerprint (target + text-hash + created MINUTE). Covers the same comment exported twice across files with different id spaces. `is_spoiler`/`spoiler_count` map to `Comment.isSpoiler`/`Comment.spoilerCount` (isSpoiler = flag OR count ≥ 5). Comment text is NEVER logged. See `lib/comments.ts`.
- CSV compatibility: header-based mapping only (never positional); `<nil>`/empty → null; reordered/extra columns tolerated; unknown files skipped.
- Trakt GDPR export (JSON zip): detected by `isTraktArchive(zip entry names)` in `lib/trakt/detect.ts` BEFORE CSV inference (a standalone `.json` upload with a Trakt filename also routes there). Processed: `watched-history-*.json` (authoritative per-play history, episodes+movies — collapsed per item: `watchCount` = plays, `watchedAt` = earliest play, one `watchHistory` row), `ratings-{shows,episodes,movies}.json` (Trakt 1–10 → `clamp(round(r/2),1,5)`), `lists-watchlist.json`, `lists-favorites.json` (→ FAVORITE_SHOW/MOVIE), `lists-lists.json`, `comments-{episodes,movies,shows}.json` (top-level only, `parent_id` skipped, reviews imported as comments), `user-settings.json` (`browsing.locale` → archive language for title fallback). `watched-movies/shows-*.json` are aggregates — used ONLY when no history files exist (movies via plays/last_watched_at; aggregate-only shows skipped, never fabricate episode rows); superseded when history exists. Everything else (`collection-*`, `hidden-*`, `likes-*`, `network-*`, `notes-*`, `user-*`, `watched-playback`, `ratings-seasons`, `comments-{seasons,lists}`) unsupported+counted. See `lib/trakt/*`.
- Trakt matching is external-ID-first (`matcher.matchByExternalIds`): TMDB id (local `ExternalId` → light upsert by id; shows skip the heavy `getShow`) → TVDB id (same authority gate as CSV's `rawTvdbSeriesId`) → IMDB id (local → `/find` recovery) → title fallback. Episodes: `resolveEpisodeByExternalIds` (EpisodeExternalId, TMDB then TVDB) → S/E fallback. `Import.format` (`'tvtime'|'trakt'`) is persisted during processing; the apply stage tags Rating/Reaction/Comment/CustomList records `source=TRAKT` (parameterized, never hardcoded) so both imports stay idempotent independently.
- TV Time JSON GDPR export (JSON zip + flattened CSV duplicates): detected by `isTvTimeJsonArchive(zip entry names)` in `lib/tvtime-json/detect.ts` AFTER the Trakt check, BEFORE CSV inference (markers: `shows.json` / `movies.json` / `activity_history.csv` basenames; standalone `shows.json` etc. uploads also route there). Processed: `shows.json` (watched episodes + structural footprint; `imdb:"-1"` sentinel → null), `movies.json` (`is_watched=true` → watched, `false` → WATCHLIST_MOVIE), `favorites.json` (→ FAVORITE_SHOW/MOVIE via `added_at`), `lists.json` (→ CustomList; `is_public` respected — PUBLIC when true; `sourceKey = tvtime:list:<normName>`). Ratings are the nullable 1–10 `rating` field inside those files → `clamp(round(r/2),1,5)`; episode ratings deduped by TVDB episode id across ALL files (a rating can exist only in favorites/lists embedded seasons); `voteKey=null` → stable `episode:<id>`/`media:<id>` apply identity. **`activity_history.csv` is parsed ONLY for its show `is_watchlisted` flag** (→ WATCHLIST_SHOW) — that signal exists nowhere in the JSON and shows.json `status` can't reproduce it; every other CSV (`favorites.csv`, `list_*.csv`, …) is a flattened duplicate → unsupported+counted. `special:true` episodes (embedded in REGULAR season numbers, sharing S/E keys with regular episodes) resolve ONLY via the TVDB episode external-id path — never S/E-matched (would corrupt into regular episodes); unresolved specials are skipped+counted. `Import.format` stays `'tvtime'` so records tag `source=TVTIME` and share the conflict domain with legacy CSV imports. Show `status` (up_to_date/continuing/…) is NOT imported. See `lib/tvtime-json/*`.
- External-id matching (BOTH imports): TVDB series ids resolve via exact TMDB `/find?external_source=tvdb_id` — NEVER title-search verification; an unresolvable id refuses title fallback, **unless EVERY collected id is provably dead (404)** — a TVDB merge/deletion leaves the export's id stale with no identity signal, so the normal title flow (exact → first-hit confidence) is allowed as the last resort. Inconclusive failures (throttle/timeout/upstream) keep the refusal. Cross-type matches are RESOLVED by id authority (a MOVIE item carrying a live TVDB series id — legacy TV Time rows mis-track shows through the movie entity — resolves to the SHOW row at 0.9/0.8 confidence; a 404 on the expected kind probes the sibling TVDB endpoint before the id is declared dead). Data safety is downstream: the apply-time type guard drops wrong-type writes (e.g. WATCHED_MOVIE → SHOW writes nothing). **Multi-id gate**: ALL distinct TVDB series ids collected across a title's rows are tried in order (TVDB merges leave dead ids in old exports; a working sibling id wins). Last-resort show identification via a TVDB EPISODE id (`recoverShowByEpisodeId` — chain: local `episode_external_ids` → TMDB `/find` (returns the parent show) → TVDB episode → parent series id → the TVDB authority gate; covers translated titles like "The Mantis"→"La Mante", rows without series ids, TVDB-only shows whose export series id is dead, and title-less vote rows). Title-less rating/emotion/comment rows (empty `series_name`) resolve through the same chain in `resolveShowEpisode` instead of going straight to UNMATCHED; when even that fails, title-less unresolvable items (ratings/emotions/comments/character votes) are silently skipped at staging — the user couldn't search for them anyway, so they never clutter the review list. **Anime is TVDB-authoritative**: /find genre 16 (Animation) + origin `JP` → TVDB-backed record (0.9) + TVDB-first hydration (matcher `providerPref`), because TMDB anime season/episode structures are wrong; TMDB id still attached for cross-lookups. Anime movies stay TMDB-first.
- **Structural guard** (`needsTvdbRehydration`): after show match+hydration, the import's S/E footprint is compared to the hydrated structure (max season + max episode per season). If it can't contain the footprint — wrong-provider structure (anthologies like The Haunting, reboot continuations like Unsolved Mysteries S15+, split/merged hour-longs like The Office S7E26) or a poisoned partial hydration — the show is re-hydrated from TVDB (union upsert, never deletes). 
- Episode resolution chain: local `episode_external_ids` (written by show hydration — TMDB path stores TMDB ep ids, TVDB path stores TVDB ep ids via `syncSeasons`) → S/E → TMDB `/find` recovery with the TVDB episode id (only on local failures). TV Time `episode_id` columns feed this (`rawTvdbEpisodeId`, ratings/emotions/comments `externalEpisodeId`).
- Title normalization (`normTitle`) is **Unicode-aware** — it keeps letters/numbers from EVERY script (Korean, Japanese, Arabic, Cyrillic…), so distinct non-Latin titles NEVER collide. An ASCII-only class normalizes them all to `''`, which once let a bulk by-title resolve match dozens of unrelated Korean/Japanese items to one show (the Yatterman incident). Bulk title paths (`resolveAllForShow`) also refuse an empty normalized identity outright.
- Anime classification evidence: TVDB extended genres are mapped (not dropped), and TMDB hydration persists `shows.original_language`/`origin_countries` → `inputFromMedia` feeds them to the classifier, so the animation+JP "probable anime" tier works in production.
- Batched apply: `createMany` in 5000-row chunks, **one raised-timeout `$transaction` per section** (episodes/movies/watchlist/favorites/lists), not one giant transaction — each section marks its items `APPLIED` so BullMQ/manual retries are idempotent. Apply timeouts via `IMPORT_TX_TIMEOUT_MS` (default 60s).
- `<nil>` values are normalized to null (not 0).
- After import confirm: `rebuildShowStatuses` recalculates watched/total counts.
- Configurable worker concurrency via `IMPORT_WORKER_CONCURRENCY` env.

## Graceful degradation (CapabilityService)
- `CapabilityService` detects what features are available from env config.
- Exposed via `GET /feature-flags` endpoint (public).
- Missing `OPENAI_API_KEY` → moderation skipped, images still stored.
- Missing S3/MinIO config → comment images return 503, user images use local files.
- Missing `TMDB_API_KEY` / `TVDB_API_KEY` → search falls back to DB.
- Missing OAuth credentials → social login buttons hidden in mobile app.

## Windows development notes
- Use `node-linker=hoisted` in `.npmrc` (avoids pnpm path length issues with CMake).
- Set `JAVA_HOME=C:\Program Files\Java\jdk-18.0.2` as User environment variable.
- Prisma generate may fail with EPERM if node processes are running — kill all node first.
- After `pnpm install`, always run `pnpm --filter @tvwatch/api prisma generate` to regenerate client types.


## Final verification and response
Before considering a task complete, review the final diff and explicitly check every applicable item below:
- API changes: API validation completed, and the API Docker image was rebuilt and pushed with the required commands.
- Web changes: the Expo web export was rebuilt with the required command.
- Localization: all user-facing strings use translation keys and every supported locale includes the required translations.
- Theme: UI changes use shared theme/design tokens and support light, dark, and system themes.
- Quality: relevant typechecks, linting, and tests were run, or any skipped checks are clearly identified.

In the final response, provide a concise checklist stating which items were applicable, which commands/checks completed, and any failures or remaining risks. Explicitly confirm that API build/publish, web build, localization, and theme tokens were considered; never imply that an unrun command was completed.

## Testing (Ask user for confirmation to run the tests)
- Backend: Jest. Unit tests for services, e2e for controllers.
- Mobile: Jest for logic/hooks; React Native Testing Library for components.
- Import tests: `apps/api/src/import/import.spec.ts` + `lib/{ratings,emotions,comments}.spec.ts` + `lib/trakt/*.spec.ts` + `lib/tvtime-json/*.spec.ts` + `import-pipeline{,-trakt,-tvtime-json}.spec.ts` (248 tests covering zip safety, inference, ratings/emotions mappings, comment filtering/ownership/dedup, Trakt classification/collapse/rating-conversion/lists/comments, TVTime-JSON detection/watchlist-CSV extraction/rating dedup/specials rules, the external-id matcher paths, and all fixture pipelines).

## Key files to know
- `apps/api/prisma/schema.prisma` — full DB schema (60+ tables)
- `apps/api/src/common/prisma/prisma.module.ts` — global module (Prisma + FeatureFlags + Settings + Capability + Email)
- `apps/api/src/common/capability.service.ts` — graceful degradation detection
- `apps/api/src/common/email.service.ts` — SMTP via nodemailer
- `apps/api/src/notifications/notification.scheduler.ts` — episode + watchlist notifications, export cleanup
- `apps/api/src/import/import.service.ts` — batched import apply (createMany)
- `apps/api/src/media-metadata/providers/tmdb.client.ts` — TMDb rate limiter
- `apps/api/src/media-metadata/providers/tvdb.client.ts` — TVDB rate limiter + JWT auth
- `apps/api/src/media-metadata/providers/tvdb.provider.ts` — TVDB search + hydration
- `apps/api/src/media-metadata/discovery.service.ts` — merged TMDb + TVDB search with Redis cache
- `apps/api/src/social/moderation.service.ts` — block/report/admin moderation
- `apps/api/src/users/export.service.ts` — data export (JSON, 24h expiry)
- `apps/api/src/data-deletion/data-deletion.service.ts` — email-based account deletion
- `apps/mobile/api/client.ts` — HTTP client with auth + self-hosted URL + `SITE_URL`
- `apps/mobile/api/hooks.ts` — all React Query hooks (50+); `useEpisodeVotes` = per-section optimistic vote mutations
- `apps/mobile/components/cards.tsx` — PosterCard, EpisodeCard, grids
- `apps/mobile/components/ListCard.tsx` — custom list card with poster background
- `apps/mobile/components/primitives.tsx` — PosterImage (uses expo-image), T, Button, Card, etc.
- `apps/mobile/components/voting/` — icon-based episode voting (VotingSection, SelectableIconTile, StarRatingControl, ReactionGrid, FavoriteCharacterVote, `meta.ts`)
- `packages/shared/src/vote-math.ts` — largest-remainder `computePercentages` + `applyVoteChange` (optimistic recompute), shared by API tests + mobile
- `apps/mobile/app/_layout.tsx` — Gate component (auth routing, mustChangePassword)
- `docs/DOCUMENTATION.md` — complete technical reference
- `docs/ENVIRONMENT.md` — full env variable reference + feature degrade summary
- `docs/To_DO.md` — project status tracker
- `production-docs/` — deployment, scaling, and build guides