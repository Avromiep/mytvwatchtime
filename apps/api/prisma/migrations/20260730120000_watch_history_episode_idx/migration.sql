-- watch_history(episode_id) was unindexed: every per-episode remap/transfer query
-- (structure reconcile, episode merges) seq-scanned the whole table once per touch,
-- 3-4x per episode pair. On prod-scale watch_history that is the difference between
-- minutes and hours per repaired show.
-- CONCURRENTLY avoids a write lock on prod; Prisma does not wrap migration files in
-- a transaction on Postgres, so this is safe. Index name matches Prisma's convention.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "watch_history_episode_id_idx" ON "watch_history"("episode_id");
