-- 1. Favorites / Star tables
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

-- 2. Playlists
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

-- 3. Scrobble & Play count
CREATE TABLE IF NOT EXISTS play_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_play_history_user_track ON play_history(user_id, track_id);

ALTER TABLE tracks ADD COLUMN IF NOT EXISTS play_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS last_played_at TIMESTAMPTZ;

-- 4. Ratings
CREATE TABLE IF NOT EXISTS user_ratings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

-- 5. Merge existing duplicate albums sharing the same title and folder_path
DO $$
DECLARE
  dup RECORD;
  main_id INT;
BEGIN
  FOR dup IN
    SELECT title, folder_path
    FROM albums
    WHERE folder_path IS NOT NULL AND TRIM(folder_path) != ''
    GROUP BY title, folder_path
    HAVING COUNT(*) > 1
  LOOP
    -- Find the album with the most tracks (or smallest id)
    SELECT al.id INTO main_id
    FROM albums al
    LEFT JOIN tracks t ON t.album_id = al.id
    WHERE al.title = dup.title AND al.folder_path = dup.folder_path
    GROUP BY al.id
    ORDER BY COUNT(t.id) DESC, al.id ASC
    LIMIT 1;

    IF main_id IS NOT NULL THEN
      -- Reassign tracks from all duplicate albums to the main album
      UPDATE tracks
      SET album_id = main_id
      WHERE album_id IN (
        SELECT id FROM albums
        WHERE title = dup.title AND folder_path = dup.folder_path AND id != main_id
      );

      -- Delete the empty redundant albums
      DELETE FROM albums
      WHERE title = dup.title AND folder_path = dup.folder_path AND id != main_id;
    END IF;
  END LOOP;
END $$;
