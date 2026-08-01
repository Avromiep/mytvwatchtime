-- Additive rollout. Existing episode rows remain active until structure reconciliation
-- classifies provider-only leftovers; this migration does not delete or remap user data.
CREATE TYPE "StructureProvider" AS ENUM ('TMDB', 'TVDB');
CREATE TYPE "StructureReason" AS ENUM (
  'GENERAL_TMDB',
  'ANIME_TVDB',
  'TVDB_ONLY_FALLBACK',
  'MANUAL_OVERRIDE'
);
CREATE TYPE "EpisodeStructureState" AS ENUM ('ACTIVE', 'LEGACY_UNMAPPED');

ALTER TABLE "shows"
  ADD COLUMN "structure_provider" "StructureProvider",
  ADD COLUMN "structure_reason" "StructureReason",
  ADD COLUMN "structure_rule_version" INTEGER,
  ADD COLUMN "structure_decided_at" TIMESTAMP(3);

ALTER TABLE "episodes"
  ADD COLUMN "structure_state" "EpisodeStructureState" NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX "shows_structure_provider_idx" ON "shows"("structure_provider");
CREATE INDEX "episodes_structure_state_idx" ON "episodes"("structure_state");

-- Remaps may need to stage the canonical episode beside a provider-foreign row with
-- identical S/E coordinates. The media write lock keeps this window bounded; after
-- transfer the foreign row is deleted or quarantined as LEGACY_UNMAPPED.
DROP INDEX "episodes_season_id_number_key";
CREATE INDEX "episodes_season_id_number_idx" ON "episodes"("season_id", "number");

-- Re-evaluate every existing show with the strict routing rule. Kitsu/Jikan matches,
-- Japanese origin, content_classification, and legacy first-hydration stamps are not
-- anime authority. TVDB-only rows remain locked fallbacks.
UPDATE "shows" sh
SET "structure_provider" = CASE
      WHEN m."manual_classification" THEN
        CASE WHEN m."content_classification" = 'ANIME'
          THEN 'TVDB'::"StructureProvider" ELSE 'TMDB'::"StructureProvider" END
      WHEN sh."keywords" @> '"anime"'::jsonb
       AND EXISTS (
         SELECT 1 FROM "media_genres" mg
         JOIN "genres" g ON g."id" = mg."genre_id"
         WHERE mg."media_id" = sh."media_id"
           AND (g."slug" = 'animation' OR lower(g."name") = 'animation')
       ) THEN 'TVDB'::"StructureProvider"
      WHEN NOT EXISTS (
        SELECT 1 FROM "external_ids" x
        WHERE x."media_id" = sh."media_id"
          AND x."provider" = 'TMDB'
          AND x."provider_entity_kind" = 'SERIES'
      ) AND EXISTS (
        SELECT 1 FROM "external_ids" x
        WHERE x."media_id" = sh."media_id"
          AND x."provider" = 'THE_TVDB'
          AND x."provider_entity_kind" = 'SERIES'
      ) THEN 'TVDB'::"StructureProvider"
      ELSE 'TMDB'::"StructureProvider"
    END,
    "structure_reason" = CASE
      WHEN m."manual_classification" THEN 'MANUAL_OVERRIDE'::"StructureReason"
      WHEN sh."keywords" @> '"anime"'::jsonb
       AND EXISTS (
         SELECT 1 FROM "media_genres" mg
         JOIN "genres" g ON g."id" = mg."genre_id"
         WHERE mg."media_id" = sh."media_id"
           AND (g."slug" = 'animation' OR lower(g."name") = 'animation')
       ) THEN 'ANIME_TVDB'::"StructureReason"
      WHEN NOT EXISTS (
        SELECT 1 FROM "external_ids" x
        WHERE x."media_id" = sh."media_id"
          AND x."provider" = 'TMDB'
          AND x."provider_entity_kind" = 'SERIES'
      ) AND EXISTS (
        SELECT 1 FROM "external_ids" x
        WHERE x."media_id" = sh."media_id"
          AND x."provider" = 'THE_TVDB'
          AND x."provider_entity_kind" = 'SERIES'
      ) THEN 'TVDB_ONLY_FALLBACK'::"StructureReason"
      ELSE 'GENERAL_TMDB'::"StructureReason"
    END,
    "structure_rule_version" = 1,
    "structure_decided_at" = CURRENT_TIMESTAMP
FROM "media_items" m
WHERE m."id" = sh."media_id";
