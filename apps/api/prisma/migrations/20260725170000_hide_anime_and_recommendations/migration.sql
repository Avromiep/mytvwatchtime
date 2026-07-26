-- Add the per-user "hide anime in explore" preference.
ALTER TABLE "user_profiles" ADD COLUMN "hide_anime_in_explore" BOOLEAN NOT NULL DEFAULT false;

-- TMDB /recommendations snapshot + sync marker (null = never synced; drives the
-- metadata-health stat and the 500-per-run backfill cron).
ALTER TABLE "media_items" ADD COLUMN "recommendations" JSONB;
ALTER TABLE "media_items" ADD COLUMN "recommendations_synced_at" TIMESTAMP(3);
