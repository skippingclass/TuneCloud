-- Last.fm web authorization issues its token only after access is granted.
-- Keep existing hashes so attempts from the previous flow remain verifiable.
ALTER TABLE lastfm_auth_attempts ALTER COLUMN token_hash DROP NOT NULL;
