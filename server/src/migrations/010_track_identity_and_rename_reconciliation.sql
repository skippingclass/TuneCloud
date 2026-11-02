-- Add durable file identity and audio/content fingerprint columns for safe rename reconciliation.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS dev BIGINT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS ino BIGINT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS birthtime_ms BIGINT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS audio_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_tracks_dev_ino ON tracks(dev, ino) WHERE dev IS NOT NULL AND ino IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_content_hash ON tracks(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_audio_hash ON tracks(audio_hash) WHERE audio_hash IS NOT NULL;
