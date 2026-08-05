-- Scheduled hydration jobs become durable, ranked Explore rail snapshots.
-- Existing jobs remain non-snapshots; the first successful scheduled refresh
-- after deployment activates each rail without guessing historical item order.
ALTER TABLE "hydration_jobs"
ADD COLUMN "rail_snapshot" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "hydration_job_items"
ADD COLUMN "rank" INTEGER;

CREATE INDEX "hydration_jobs_type_rail_snapshot_status_completed_at_idx"
ON "hydration_jobs"("type", "rail_snapshot", "status", "completed_at");

CREATE INDEX "hydration_job_items_job_id_status_rank_idx"
ON "hydration_job_items"("job_id", "status", "rank");
