-- Merge case-only artist/album duplicates, preserving every track and user link.
-- This migration also runs on populated pre-009 databases. The exact-case
-- constraint must be suspended while artists are reassigned, before album merge.
ALTER TABLE albums DROP CONSTRAINT IF EXISTS albums_title_artist_id_key;

CREATE TEMP TABLE case_artist_merge ON COMMIT DROP AS
  SELECT id AS source_id, MIN(id) OVER (PARTITION BY LOWER(name)) AS target_id
  FROM artists;

UPDATE tracks t SET artist_id = m.target_id
FROM case_artist_merge m WHERE t.artist_id = m.source_id AND m.source_id <> m.target_id;
UPDATE albums a SET artist_id = m.target_id
FROM case_artist_merge m WHERE a.artist_id = m.source_id AND m.source_id <> m.target_id;

INSERT INTO album_credits (album_id, artist_id, role, credited_as)
SELECT c.album_id, m.target_id, c.role, c.credited_as
FROM album_credits c JOIN case_artist_merge m ON c.artist_id = m.source_id
WHERE m.source_id <> m.target_id
ON CONFLICT DO NOTHING;

INSERT INTO track_credits (track_id, artist_id, role, credited_as)
SELECT c.track_id, m.target_id, c.role, c.credited_as
FROM track_credits c JOIN case_artist_merge m ON c.artist_id = m.source_id
WHERE m.source_id <> m.target_id
ON CONFLICT DO NOTHING;

INSERT INTO user_starred_artists (user_id, artist_id, created_at)
SELECT s.user_id, m.target_id, s.created_at
FROM user_starred_artists s JOIN case_artist_merge m ON s.artist_id = m.source_id
WHERE m.source_id <> m.target_id
ON CONFLICT DO NOTHING;

INSERT INTO user_ratings (user_id, entity_type, entity_id, rating, created_at)
SELECT r.user_id, r.entity_type, m.target_id, r.rating, r.created_at
FROM user_ratings r JOIN case_artist_merge m ON r.entity_id = m.source_id
WHERE r.entity_type = 'artist' AND m.source_id <> m.target_id
ON CONFLICT DO NOTHING;
DELETE FROM user_ratings r USING case_artist_merge m
WHERE r.entity_type = 'artist' AND r.entity_id = m.source_id AND m.source_id <> m.target_id;
DELETE FROM artists a USING case_artist_merge m
WHERE a.id = m.source_id AND m.source_id <> m.target_id;

CREATE TEMP TABLE case_album_merge ON COMMIT DROP AS
SELECT id AS source_id,
       FIRST_VALUE(id) OVER (
         PARTITION BY LOWER(title), artist_id
         ORDER BY (SELECT COUNT(*) FROM tracks t WHERE t.album_id = albums.id AND t.missing_since IS NULL) DESC, id
       ) AS target_id
FROM albums;

-- Equal titles or filenames are not proof of equal audio. Keep track IDs and
-- their playlists, history, bookmarks, ratings and lyrics intact.
UPDATE tracks t SET album_id = m.target_id
FROM case_album_merge m WHERE t.album_id = m.source_id AND m.source_id <> m.target_id;

INSERT INTO album_credits (album_id, artist_id, role, credited_as)
SELECT m.target_id, c.artist_id, c.role, c.credited_as
FROM album_credits c JOIN case_album_merge m ON c.album_id = m.source_id
WHERE m.source_id <> m.target_id
ON CONFLICT DO NOTHING;

INSERT INTO user_starred_albums (user_id, album_id, created_at)
SELECT s.user_id, m.target_id, s.created_at
FROM user_starred_albums s JOIN case_album_merge m ON s.album_id = m.source_id
WHERE m.source_id <> m.target_id
ON CONFLICT DO NOTHING;

INSERT INTO user_ratings (user_id, entity_type, entity_id, rating, created_at)
SELECT r.user_id, r.entity_type, m.target_id, r.rating, r.created_at
FROM user_ratings r JOIN case_album_merge m ON r.entity_id = m.source_id
WHERE r.entity_type = 'album' AND m.source_id <> m.target_id
ON CONFLICT DO NOTHING;
DELETE FROM user_ratings r USING case_album_merge m
WHERE r.entity_type = 'album' AND r.entity_id = m.source_id AND m.source_id <> m.target_id;
DELETE FROM albums a USING case_album_merge m
WHERE a.id = m.source_id AND m.source_id <> m.target_id;

ALTER TABLE albums ADD CONSTRAINT albums_title_artist_id_key UNIQUE (title, artist_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_name_lower ON artists(LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_title_artist_lower ON albums(LOWER(title), artist_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_title_null_artist_lower ON albums(LOWER(title)) WHERE artist_id IS NULL;
