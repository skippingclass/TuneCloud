CREATE TABLE lastfm_accounts (
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
CREATE TABLE lastfm_auth_attempts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  auth_version INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE lastfm_track_rules (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  overrides JSONB NOT NULL DEFAULT '{}',
  blocked BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, track_id)
);
CREATE TABLE lastfm_artist_blocks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, artist_id)
);
CREATE TABLE lastfm_outbox (
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
CREATE INDEX lastfm_outbox_pending ON lastfm_outbox(next_attempt_at) WHERE status='pending';
CREATE INDEX lastfm_outbox_user ON lastfm_outbox(user_id, id DESC);
