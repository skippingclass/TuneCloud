-- Match the recommended listening preferences for new Last.fm connections.
-- Existing personal settings are preserved.
ALTER TABLE lastfm_accounts ALTER COLUMN now_playing SET DEFAULT false;
ALTER TABLE lastfm_accounts ALTER COLUMN first_artist SET DEFAULT true;
