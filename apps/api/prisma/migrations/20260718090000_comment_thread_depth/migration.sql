-- Reddit-style nested comment threads: store each comment's nesting level and
-- top-level ancestor so depth-limited subtree fetches stay cheap.
ALTER TABLE "comments" ADD COLUMN "depth" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "comments" ADD COLUMN "root_id" TEXT;

-- Exact backfill: before this migration only one reply level was allowed,
-- so every existing reply is depth 1 and its parent is the root.
UPDATE "comments" SET "depth" = 1, "root_id" = "parent_id" WHERE "parent_id" IS NOT NULL;

CREATE INDEX "comments_root_id_idx" ON "comments"("root_id");
