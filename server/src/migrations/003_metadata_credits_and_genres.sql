ALTER TABLE artists ADD COLUMN IF NOT EXISTS musicbrainz_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_mbid ON artists(musicbrainz_id) WHERE musicbrainz_id IS NOT NULL;

ALTER TABLE albums ADD COLUMN IF NOT EXISTS folder_path TEXT;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS musicbrainz_id TEXT;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS compilation BOOLEAN DEFAULT false;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS disc_count INTEGER DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_mbid ON albums(musicbrainz_id) WHERE musicbrainz_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_albums_folder_path ON albums(folder_path);

CREATE TABLE IF NOT EXISTS genres (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS track_genres (
  track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
  genre_id INTEGER REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (track_id, genre_id)
);
CREATE INDEX IF NOT EXISTS idx_track_genres_genre_id ON track_genres(genre_id);

CREATE TABLE IF NOT EXISTS album_credits (
  album_id INTEGER REFERENCES albums(id) ON DELETE CASCADE,
  artist_id INTEGER REFERENCES artists(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'albumartist',
  credited_as TEXT,
  PRIMARY KEY (album_id, artist_id, role)
);
CREATE INDEX IF NOT EXISTS idx_album_credits_artist ON album_credits(artist_id, role);

CREATE TABLE IF NOT EXISTS track_credits (
  track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
  artist_id INTEGER REFERENCES artists(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'artist',
  credited_as TEXT,
  PRIMARY KEY (track_id, artist_id, role)
);
CREATE INDEX IF NOT EXISTS idx_track_credits_artist ON track_credits(artist_id, role);

ALTER TABLE tracks ADD COLUMN IF NOT EXISTS composer TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS track_artist_credit TEXT;
