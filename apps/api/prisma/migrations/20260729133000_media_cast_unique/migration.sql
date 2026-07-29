-- One credit row per (media, person). Exact duplicates (same media_id +
-- cast_member_id) were created by concurrent hydrations and the old index-based
-- fallback person ids. Before adding the unique index:
--   1. character votes on duplicate rows are re-pointed to the surviving row
--      (most votes, then lowest id) — votes are never lost;
--   2. pathological duplicate votes (same user + episode already on the survivor —
--      impossible via the API) are discarded, keeping the survivor's vote;
--   3. vote-free duplicate rows are deleted.
-- Cross-person duplicates (same human under TMDB_ vs TVDB_ external ids) are NOT
-- touched here — merge those first with POST /admin/cast-dedup/run?mode=repair.

-- 1) Re-point votes to the surviving row.
WITH ranked AS (
  SELECT id, media_id, cast_member_id,
         ROW_NUMBER() OVER (
           PARTITION BY media_id, cast_member_id
           ORDER BY (
             SELECT count(*) FROM character_votes cv WHERE cv.cast_id = media_cast.id
           ) DESC, id
         ) AS rn
  FROM media_cast
),
survivors AS (SELECT id, media_id, cast_member_id FROM ranked WHERE rn = 1),
dups AS (
  SELECT r.id AS dup_id, s.id AS survivor_id
  FROM ranked r
  JOIN survivors s ON s.media_id = r.media_id AND s.cast_member_id = r.cast_member_id
  WHERE r.rn > 1
)
UPDATE character_votes cv SET cast_id = d.survivor_id
FROM dups d
WHERE cv.cast_id = d.dup_id
  AND NOT EXISTS (
    SELECT 1 FROM character_votes x
    WHERE x.user_id = cv.user_id AND x.episode_id = cv.episode_id AND x.cast_id = d.survivor_id
  );

-- 2) Discard votes that would now violate @@unique([userId, episodeId]) (the
--    survivor already has that user's vote for the episode — kept).
WITH ranked AS (
  SELECT id, media_id, cast_member_id,
         ROW_NUMBER() OVER (
           PARTITION BY media_id, cast_member_id
           ORDER BY (
             SELECT count(*) FROM character_votes cv WHERE cv.cast_id = media_cast.id
           ) DESC, id
         ) AS rn
  FROM media_cast
),
survivors AS (SELECT id, media_id, cast_member_id FROM ranked WHERE rn = 1),
dups AS (
  SELECT r.id AS dup_id, s.id AS survivor_id
  FROM ranked r
  JOIN survivors s ON s.media_id = r.media_id AND s.cast_member_id = r.cast_member_id
  WHERE r.rn > 1
)
DELETE FROM character_votes cv
USING dups d
WHERE cv.cast_id = d.dup_id;

-- 3) Delete the duplicate credit rows (only those with no remaining votes).
WITH ranked AS (
  SELECT id, media_id, cast_member_id,
         ROW_NUMBER() OVER (
           PARTITION BY media_id, cast_member_id
           ORDER BY (
             SELECT count(*) FROM character_votes cv WHERE cv.cast_id = media_cast.id
           ) DESC, id
         ) AS rn
  FROM media_cast
)
DELETE FROM media_cast mc
USING ranked r
WHERE mc.id = r.id AND r.rn > 1
  AND NOT EXISTS (SELECT 1 FROM character_votes cv WHERE cv.cast_id = mc.id);

-- 4) Enforce one credit row per (media, person).
CREATE UNIQUE INDEX "media_cast_media_id_cast_member_id_key"
  ON "media_cast" ("media_id", "cast_member_id");
