ALTER TABLE tracks ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE albums ADD COLUMN IF NOT EXISTS release_key TEXT NOT NULL DEFAULT '';
UPDATE albums SET release_key=CASE WHEN musicbrainz_id IS NOT NULL THEN 'mbid:' || musicbrainz_id
  ELSE 'folder:' || folder_path END WHERE folder_path IS NOT NULL;

-- Retain IDs and user references. Distinct editions may share a title and artist.
ALTER TABLE albums DROP CONSTRAINT IF EXISTS albums_title_artist_id_key;
DROP INDEX IF EXISTS idx_albums_title_artist_lower;
DROP INDEX IF EXISTS idx_albums_title_null_artist_lower;
CREATE UNIQUE INDEX idx_albums_title_artist_lower ON albums(LOWER(title), artist_id, release_key);
CREATE UNIQUE INDEX idx_albums_title_null_artist_lower ON albums(LOWER(title), release_key) WHERE artist_id IS NULL;

-- A release MBID can identify several local editions; do not merge their art.
DROP INDEX IF EXISTS idx_albums_mbid;
CREATE INDEX idx_albums_mbid ON albums(musicbrainz_id) WHERE musicbrainz_id IS NOT NULL;
