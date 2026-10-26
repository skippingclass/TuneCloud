-- Add album_artist_credit and parse_error to tracks for tag clearing & metadata calculation
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS album_artist_credit TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS parse_error BOOLEAN NOT NULL DEFAULT false;

-- Indexes for personal play history and track availability queries
CREATE INDEX IF NOT EXISTS idx_play_history_user_played ON play_history(user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_missing_since ON tracks(missing_since) WHERE missing_since IS NOT NULL;
