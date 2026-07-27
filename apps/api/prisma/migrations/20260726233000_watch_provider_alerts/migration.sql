-- Watch-provider availability alerts + regional provider catalog.
ALTER TYPE "NotificationCategory" ADD VALUE 'PROVIDER_ALERT';

CREATE TYPE "ProviderOfferType" AS ENUM ('STREAM', 'RENT', 'BUY');

CREATE TABLE "watch_provider_alerts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "offer_type" "ProviderOfferType" NOT NULL,
    "country" TEXT NOT NULL,
    "provider_ids" INTEGER[] NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "watch_provider_alerts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "watch_provider_catalog" (
    "id" TEXT NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "country" TEXT NOT NULL,
    "display_priority" INTEGER NOT NULL,

    CONSTRAINT "watch_provider_catalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "watch_provider_alerts_user_id_media_id_offer_type_key" ON "watch_provider_alerts"("user_id", "media_id", "offer_type");
CREATE INDEX "watch_provider_alerts_active_idx" ON "watch_provider_alerts"("active");
CREATE UNIQUE INDEX "watch_provider_catalog_tmdb_id_country_key" ON "watch_provider_catalog"("tmdb_id", "country");
CREATE INDEX "watch_provider_catalog_country_idx" ON "watch_provider_catalog"("country");

ALTER TABLE "watch_provider_alerts" ADD CONSTRAINT "watch_provider_alerts_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "watch_provider_alerts" ADD CONSTRAINT "watch_provider_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
