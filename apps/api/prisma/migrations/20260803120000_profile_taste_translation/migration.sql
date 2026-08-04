ALTER TABLE "user_profiles"
ADD COLUMN "explore_default_filters" JSONB;

ALTER TABLE "comments"
ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "external_reviews"
ADD COLUMN "language" TEXT,
ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}';
