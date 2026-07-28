-- Quick-setup onboarding: per-user onboarding state (versioned), source of truth
-- across devices. Existing users default to NOT_STARTED; clients decide whether to
-- show onboarding based on status/version.
CREATE TYPE "OnboardingStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED');

ALTER TABLE "users" ADD COLUMN "onboarding_status" "OnboardingStatus" NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN "onboarding_version" INTEGER,
ADD COLUMN "onboarding_completed_at" TIMESTAMP(3);

-- Existing users predate the onboarding flow: don't force them through it.
-- Rows created after this migration keep the NOT_STARTED default and see it once.
UPDATE "users" SET "onboarding_status" = 'SKIPPED', "onboarding_version" = 1;
