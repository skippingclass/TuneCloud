CREATE TABLE IF NOT EXISTS artists (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  musicbrainz_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_mbid ON artists(musicbrainz_id) WHERE musicbrainz_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_name_lower ON artists(LOWER(name));

CREATE TABLE IF NOT EXISTS albums (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  artist_id INTEGER REFERENCES artists(id) ON DELETE CASCADE,
  year INTEGER,
  genre TEXT,
  cover_path TEXT,
  folder_path TEXT,
  musicbrainz_id TEXT,
  compilation BOOLEAN DEFAULT false,
  disc_count INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  release_key TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_albums_mbid ON albums(musicbrainz_id) WHERE musicbrainz_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_title_artist_lower ON albums(LOWER(title), artist_id, release_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_title_null_artist_lower ON albums(LOWER(title), release_key) WHERE artist_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_albums_folder_path ON albums(folder_path);

CREATE TABLE IF NOT EXISTS tracks (
  id SERIAL PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  file_size BIGINT DEFAULT 0,
  duration REAL DEFAULT 0,
  title TEXT,
  artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
  track_number INTEGER,
  disc_number INTEGER DEFAULT 1,
  genre TEXT,
  year INTEGER,
  bitrate INTEGER,
  sample_rate INTEGER,
  format TEXT,
  cover_path TEXT,
  composer TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  track_artist_credit TEXT,
  album_artist_credit TEXT,
  parse_error BOOLEAN NOT NULL DEFAULT false,
  missing_since TIMESTAMPTZ,
  mtime TIMESTAMPTZ,
  dev BIGINT,
  ino BIGINT,
  birthtime_ms BIGINT,
  content_hash TEXT,
  audio_hash TEXT,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played_at TIMESTAMPTZ,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracks_artist_id ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_file_path ON tracks(file_path);
CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
CREATE INDEX IF NOT EXISTS idx_tracks_mtime ON tracks(mtime);
CREATE INDEX IF NOT EXISTS idx_tracks_missing_since ON tracks(missing_since) WHERE missing_since IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_dev_ino ON tracks(dev, ino) WHERE dev IS NOT NULL AND ino IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_content_hash ON tracks(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_audio_hash ON tracks(audio_hash) WHERE audio_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN DEFAULT false,
  subsonic_secret TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

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

-- Star / Favorites
CREATE TABLE IF NOT EXISTS user_starred_tracks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS idx_user_starred_tracks_user ON user_starred_tracks(user_id);

CREATE TABLE IF NOT EXISTS user_starred_albums (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, album_id)
);
CREATE INDEX IF NOT EXISTS idx_user_starred_albums_user ON user_starred_albums(user_id);

CREATE TABLE IF NOT EXISTS user_starred_artists (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, artist_id)
);
CREATE INDEX IF NOT EXISTS idx_user_starred_artists_user ON user_starred_artists(user_id);

-- Playlists
CREATE TABLE IF NOT EXISTS playlists (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  comment TEXT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists(owner_id);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  id SERIAL PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  track_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, track_order);

-- Play history
CREATE TABLE IF NOT EXISTS play_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_play_history_user_track ON play_history(user_id, track_id);

-- User ratings
CREATE TABLE IF NOT EXISTS user_ratings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

-- Last.fm personal connections and durable delivery.
CREATE TABLE IF NOT EXISTS lastfm_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL UNIQUE,
  username TEXT NOT NULL,
  session_secret TEXT NOT NULL,
  needs_reauth BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  now_playing BOOLEAN NOT NULL DEFAULT true,
  percent INTEGER NOT NULL DEFAULT 50 CHECK (percent BETWEEN 50 AND 100),
  seconds INTEGER NOT NULL DEFAULT 240 CHECK (seconds BETWEEN 240 AND 600),
  min_duration INTEGER NOT NULL DEFAULT 30 CHECK (min_duration BETWEEN 30 AND 3600),
  first_artist BOOLEAN NOT NULL DEFAULT false,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lastfm_auth_attempts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  auth_version INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS lastfm_track_rules (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  overrides JSONB NOT NULL DEFAULT '{}',
  blocked BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, track_id)
);
CREATE TABLE IF NOT EXISTS lastfm_artist_blocks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, artist_id)
);
CREATE TABLE IF NOT EXISTS lastfm_outbox (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES lastfm_accounts(user_id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES lastfm_accounts(connection_id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','ignored','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, connection_id, event_id)
);
CREATE INDEX IF NOT EXISTS lastfm_outbox_pending ON lastfm_outbox(next_attempt_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS lastfm_outbox_user ON lastfm_outbox(user_id, id DESC);
