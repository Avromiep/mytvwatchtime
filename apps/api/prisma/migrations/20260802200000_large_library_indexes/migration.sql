-- Additive indexes for bounded library/watch-next/upcoming reads.
-- Prisma applies PostgreSQL migrations in a transaction, so these statements
-- intentionally do not use CREATE INDEX CONCURRENTLY.
CREATE INDEX IF NOT EXISTS "episodes_season_structure_air_idx"
  ON "episodes" ("season_id", "structure_state", "air_date");

CREATE INDEX IF NOT EXISTS "episodes_structure_air_idx"
  ON "episodes" ("structure_state", "air_date");

CREATE INDEX IF NOT EXISTS "user_show_status_library_idx"
  ON "user_show_status" ("user_id", "dropped", "paused_at", "last_watched_at");

CREATE INDEX IF NOT EXISTS "user_movie_status_library_idx"
  ON "user_movie_status" ("user_id", "watched", "watched_at");

CREATE INDEX IF NOT EXISTS "watch_history_user_type_cursor_idx"
  ON "watch_history" ("user_id", "media_type", "watched_at", "id");

CREATE INDEX IF NOT EXISTS "watchlist_items_user_created_idx"
  ON "watchlist_items" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "favorites_user_created_idx"
  ON "favorites" ("user_id", "created_at");
