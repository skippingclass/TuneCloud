-- Speed up case-insensitive album folder lookups during batch scan upserts
CREATE INDEX IF NOT EXISTS idx_albums_folder_path_lower ON albums (LOWER(folder_path));

-- Enable index scans for starts_with(file_path, $1) / prefix queries across collations
CREATE INDEX IF NOT EXISTS idx_tracks_file_path_pattern ON tracks (file_path text_pattern_ops);

-- Drop redundant indexes that duplicate UNIQUE(file_path) and PRIMARY KEY(track_id)
DROP INDEX IF EXISTS idx_tracks_file_path;
DROP INDEX IF EXISTS idx_track_lyrics_track_id;
