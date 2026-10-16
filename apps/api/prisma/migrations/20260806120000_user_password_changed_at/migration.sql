-- Track the last password change/reset so tokens issued earlier can be rejected.
-- Nullable with no default: existing rows stay NULL ("never changed"), so sessions
-- predating this migration remain valid until the user next changes their password.
ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMP(3);
