-- Per-country watch offers (JustWatch-sourced via TMDB watch/providers), normalized as
-- { "US": { link, stream: [{name,logoUrl}], rent: [...], buy: [...] } }.
ALTER TABLE "media_items" ADD COLUMN "watch_providers_data" JSONB;
