-- Existing JWTs require a fresh sign-in after this migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
-- Missing files retain their identities and all playlist/favorite/history references.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS missing_since TIMESTAMPTZ;
