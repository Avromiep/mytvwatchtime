-- Reconstructed on 2026-07-25: this directory was committed empty. SQL rebuilt from
-- the production schema (constraint/index names verified against prod). The
-- "ListSource" enum predates the repo's migration history and is assumed to exist.
CREATE TABLE "character_votes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "episode_id" TEXT NOT NULL,
    "cast_id" TEXT NOT NULL,
    "source" "ListSource" DEFAULT 'MANUAL',
    "source_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_votes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "character_votes_user_id_episode_id_key" ON "character_votes"("user_id", "episode_id");
CREATE INDEX "character_votes_episode_id_idx" ON "character_votes"("episode_id");
CREATE INDEX "character_votes_cast_id_idx" ON "character_votes"("cast_id");
CREATE INDEX "character_votes_user_id_source_source_key_idx" ON "character_votes"("user_id", "source", "source_key");

ALTER TABLE "character_votes" ADD CONSTRAINT "character_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "character_votes" ADD CONSTRAINT "character_votes_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "character_votes" ADD CONSTRAINT "character_votes_cast_id_fkey" FOREIGN KEY ("cast_id") REFERENCES "media_cast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
