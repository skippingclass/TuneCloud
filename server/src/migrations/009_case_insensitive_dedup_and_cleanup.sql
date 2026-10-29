-- Merge duplicate artists and albums that differ only in case,
-- and add case-insensitive unique indexes.

DO $$
DECLARE
  dup RECORD;
  target_id INT;
  source_id INT;
  t_src RECORD;
  t_tgt INT;
BEGIN
  -- 1. Merge duplicate artists by LOWER(name)
  FOR dup IN
    SELECT LOWER(name) as l_name, array_agg(id ORDER BY id ASC) as ids
    FROM artists
    GROUP BY LOWER(name)
    HAVING COUNT(*) > 1
  LOOP
    target_id := dup.ids[1];
    FOR i IN 2..array_length(dup.ids, 1) LOOP
      source_id := dup.ids[i];

      UPDATE tracks SET artist_id = target_id WHERE artist_id = source_id;
      UPDATE albums SET artist_id = target_id WHERE artist_id = source_id;

      UPDATE album_credits SET artist_id = target_id WHERE artist_id = source_id
        AND NOT EXISTS (SELECT 1 FROM album_credits WHERE album_id = album_credits.album_id AND role = album_credits.role AND artist_id = target_id);
      DELETE FROM album_credits WHERE artist_id = source_id;

      UPDATE track_credits SET artist_id = target_id WHERE artist_id = source_id
        AND NOT EXISTS (SELECT 1 FROM track_credits WHERE track_id = track_credits.track_id AND role = track_credits.role AND artist_id = target_id);
      DELETE FROM track_credits WHERE artist_id = source_id;

      UPDATE user_starred_artists SET artist_id = target_id WHERE artist_id = source_id
        AND NOT EXISTS (SELECT 1 FROM user_starred_artists WHERE user_id = user_starred_artists.user_id AND artist_id = target_id);
      DELETE FROM user_starred_artists WHERE artist_id = source_id;

      UPDATE user_ratings SET entity_id = target_id WHERE entity_type = 'artist' AND entity_id = source_id
        AND NOT EXISTS (SELECT 1 FROM user_ratings WHERE user_id = user_ratings.user_id AND entity_type = 'artist' AND entity_id = target_id);
      DELETE FROM user_ratings WHERE entity_type = 'artist' AND entity_id = source_id;

      DELETE FROM artists WHERE id = source_id;
    END LOOP;
  END LOOP;

  -- 2. Merge duplicate albums by LOWER(title) and artist_id
  FOR dup IN
    SELECT LOWER(title) as l_title, artist_id, array_agg(id ORDER BY (
      SELECT COUNT(*) FROM tracks WHERE album_id = albums.id AND missing_since IS NULL
    ) DESC, id ASC) as ids
    FROM albums
    GROUP BY LOWER(title), artist_id
    HAVING COUNT(*) > 1
  LOOP
    target_id := dup.ids[1];
    FOR i IN 2..array_length(dup.ids, 1) LOOP
      source_id := dup.ids[i];

      -- For each track in source album, check if corresponding track exists in target album
      FOR t_src IN SELECT id, file_name, title FROM tracks WHERE album_id = source_id LOOP
        SELECT id INTO t_tgt FROM tracks WHERE album_id = target_id AND (
          LOWER(file_name) = LOWER(t_src.file_name) OR (title IS NOT NULL AND LOWER(title) = LOWER(t_src.title))
        ) LIMIT 1;

        IF t_tgt IS NOT NULL THEN
          -- Transfer user data from t_src to t_tgt
          UPDATE user_starred_tracks SET track_id = t_tgt WHERE track_id = t_src.id
            AND NOT EXISTS (SELECT 1 FROM user_starred_tracks WHERE user_id = user_starred_tracks.user_id AND track_id = t_tgt);
          DELETE FROM user_starred_tracks WHERE track_id = t_src.id;

          UPDATE play_history SET track_id = t_tgt WHERE track_id = t_src.id;
          UPDATE playlist_tracks SET track_id = t_tgt WHERE track_id = t_src.id;

          UPDATE user_ratings SET entity_id = t_tgt WHERE entity_type = 'track' AND entity_id = t_src.id
            AND NOT EXISTS (SELECT 1 FROM user_ratings WHERE user_id = user_ratings.user_id AND entity_type = 'track' AND entity_id = t_tgt);
          DELETE FROM user_ratings WHERE entity_type = 'track' AND entity_id = t_src.id;

          DELETE FROM tracks WHERE id = t_src.id;
        END IF;
      END LOOP;

      -- Move any remaining tracks to target
      UPDATE tracks SET album_id = target_id WHERE album_id = source_id;

      -- Reassign album stars and ratings
      UPDATE user_starred_albums SET album_id = target_id WHERE album_id = source_id
        AND NOT EXISTS (SELECT 1 FROM user_starred_albums WHERE user_id = user_starred_albums.user_id AND album_id = target_id);
      DELETE FROM user_starred_albums WHERE album_id = source_id;

      UPDATE user_ratings SET entity_id = target_id WHERE entity_type = 'album' AND entity_id = source_id
        AND NOT EXISTS (SELECT 1 FROM user_ratings WHERE user_id = user_ratings.user_id AND entity_type = 'album' AND entity_id = target_id);
      DELETE FROM user_ratings WHERE entity_type = 'album' AND entity_id = source_id;

      DELETE FROM album_credits WHERE album_id = source_id;
      DELETE FROM albums WHERE id = source_id;
    END LOOP;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_name_lower ON artists(LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_title_artist_lower ON albums(LOWER(title), artist_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_title_null_artist_lower ON albums(LOWER(title)) WHERE artist_id IS NULL;
