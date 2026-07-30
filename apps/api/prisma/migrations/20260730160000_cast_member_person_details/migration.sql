-- Person details page: provider-namespaced ids + cached person details/credits on
-- cast_members. All columns additive/nullable; external_id stays the hydration
-- upsert key. tmdb_id/tvdb_id are plain indexes (NOT unique): duplicate members
-- for the same human still exist and heal over time via merge-on-view.
ALTER TABLE "cast_members" ADD COLUMN "tmdb_id" INTEGER,
ADD COLUMN "tvdb_id" INTEGER,
ADD COLUMN "imdb_id" TEXT,
ADD COLUMN "birth_date" DATE,
ADD COLUMN "death_date" DATE,
ADD COLUMN "birth_place" TEXT,
ADD COLUMN "biography" TEXT,
ADD COLUMN "names" JSONB,
ADD COLUMN "biographies" JSONB,
ADD COLUMN "details_locales" JSONB,
ADD COLUMN "details_synced_at" TIMESTAMP(3),
ADD COLUMN "credits" JSONB,
ADD COLUMN "credits_synced_at" TIMESTAMP(3);

-- cast_members is small (one row per person); a plain index build locks briefly,
-- unlike CONCURRENTLY which Prisma's transaction-wrapped deploy rejects (25001).
CREATE INDEX IF NOT EXISTS "cast_members_tmdb_id_idx" ON "cast_members"("tmdb_id");
CREATE INDEX IF NOT EXISTS "cast_members_tvdb_id_idx" ON "cast_members"("tvdb_id");
