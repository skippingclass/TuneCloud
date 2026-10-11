-- Migration: 006_track_lyrics
-- Cache for fetched or extracted lyrics to enable instant (0ms) lookup and reduce external API latency

CREATE TABLE IF NOT EXISTS track_lyrics (
  track_id INT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  synced BOOLEAN NOT NULL DEFAULT FALSE,
  type TEXT NOT NULL DEFAULT 'plain',
  lyrics TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_track_lyrics_track_id ON track_lyrics(track_id);
