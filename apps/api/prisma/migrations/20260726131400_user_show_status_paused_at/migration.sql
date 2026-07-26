-- Pause tracking: paused shows are hidden from watch-next/upcoming and receive
-- no episode/watchlist notifications. Nullable (no default write on existing rows).
ALTER TABLE "user_show_status" ADD COLUMN "paused_at" TIMESTAMP(3);
