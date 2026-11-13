-- Audit indexes for hot queries and BIGINT playback positions
CREATE INDEX IF NOT EXISTS idx_albums_artist_id ON albums(artist_id);
CREATE INDEX IF NOT EXISTS idx_albums_year ON albums(year);
CREATE INDEX IF NOT EXISTS idx_albums_title_lower ON albums(LOWER(title));

CREATE INDEX IF NOT EXISTS idx_tracks_album_live ON tracks(album_id) WHERE missing_since IS NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_artist_live ON tracks(artist_id) WHERE missing_since IS NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_title_lower_live ON tracks(LOWER(title)) WHERE missing_since IS NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_year_live ON tracks(year) WHERE missing_since IS NULL;

CREATE INDEX IF NOT EXISTS idx_play_history_user_played_at ON play_history(user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track_id ON playlist_tracks(track_id);

ALTER TABLE play_queues ALTER COLUMN position_ms TYPE BIGINT;
ALTER TABLE bookmarks ALTER COLUMN position_ms TYPE BIGINT;
