-- Retries of one playback must not create duplicate listening events.
ALTER TABLE play_history ADD COLUMN event_id UUID;
CREATE UNIQUE INDEX play_history_user_event ON play_history(user_id, event_id);

-- Cached lyrics belong to a particular metadata/file revision, including in-flight lookups.
ALTER TABLE track_lyrics ADD COLUMN metadata_key TEXT;
