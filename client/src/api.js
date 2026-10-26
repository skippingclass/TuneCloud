const BASE = '/api';

export const AUTH_EXPIRED_EVENT = 'tunecloud:auth-expired';

const authExpiredListeners = new Set();

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

function readStoredToken() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem('tunecloud-token') : null;
  } catch {
    return null;
  }
}

let token = readStoredToken();

export function setAuthToken(t) {
  token = t || null;
  try {
    if (typeof localStorage !== 'undefined') {
      if (t) localStorage.setItem('tunecloud-token', t);
      else localStorage.removeItem('tunecloud-token');
    }
  } catch {}
}

export function getAuthToken() {
  if (token) return token;
  const stored = readStoredToken();
  if (stored) token = stored;
  return token;
}

export function onAuthExpired(listener) {
  authExpiredListeners.add(listener);
  return () => {
    authExpiredListeners.delete(listener);
  };
}

function emitAuthExpired(detail) {
  setAuthToken(null);
  const eventPayload = { type: AUTH_EXPIRED_EVENT, detail };
  authExpiredListeners.forEach((fn) => {
    try {
      fn(eventPayload);
    } catch {}
  });
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, { detail }));
    } catch {}
  }
}

async function fetchJson(url, opts = {}) {
  const { skipAuthExpire = false, ...fetchOpts } = opts;
  const hasBody = fetchOpts.body !== undefined && fetchOpts.body !== null;
  const headers = { ...fetchOpts.headers };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  const currentToken = getAuthToken();
  if (currentToken) {
    headers['Authorization'] = `Bearer ${currentToken}`;
  }

  const res = await fetch(`${BASE}${url}`, {
    ...fetchOpts,
    headers,
  });
  if (!res.ok) {
    let data = null;
    let msg = res.statusText || `HTTP ${res.status}`;
    try {
      data = await res.json();
      msg = data?.error || data?.message || msg;
    } catch {}

    const isLoginEndpoint = url === '/auth/login' || url.startsWith('/auth/login?');
    const isLogoutEndpoint = url === '/auth/logout' || url.startsWith('/auth/logout?');
    if (res.status === 401 && getAuthToken() === currentToken && !isLoginEndpoint && !isLogoutEndpoint && !skipAuthExpire) {
      emitAuthExpired({ url, status: 401, message: msg });
    }

    throw new ApiError(msg, res.status, data);
  }
  return res.json().catch(() => ({}));
}

export const api = {
  browse: (dir, opts) => fetchJson(`/browse/dirs?dir=${encodeURIComponent(dir || '')}`, opts),
  tree: (opts) => fetchJson('/browse/tree', opts),
  tracks: (params = {}, opts = {}) => {
    const searchParams = new URLSearchParams();
    if (params && typeof params === 'object') {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') {
          searchParams.set(k, String(v));
        }
      });
    }
    const qs = searchParams.toString();
    return fetchJson(`/tracks${qs ? `?${qs}` : ''}`, opts);
  },
  track: (id, opts) => fetchJson(`/tracks/${id}`, opts),
  albums: (params = {}, opts = {}) => {
    const searchParams = new URLSearchParams();
    let fetchOpts = opts;
    if (params && typeof params === 'object') {
      if ('signal' in params || 'headers' in params) {
        fetchOpts = params;
      } else {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined && v !== null && v !== '') {
            searchParams.set(k, String(v));
          }
        });
      }
    }
    const qs = searchParams.toString();
    return fetchJson(`/albums${qs ? `?${qs}` : ''}`, fetchOpts);
  },
  album: (id, opts) => fetchJson(`/albums/${id}`, opts),
  artists: (params = {}, opts = {}) => {
    const searchParams = new URLSearchParams();
    let fetchOpts = opts;
    if (params && typeof params === 'object') {
      if ('signal' in params || 'headers' in params) {
        fetchOpts = params;
      } else {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined && v !== null && v !== '') {
            searchParams.set(k, String(v));
          }
        });
      }
    }
    const qs = searchParams.toString();
    return fetchJson(`/artists${qs ? `?${qs}` : ''}`, fetchOpts);
  },
  artist: (id, opts) => fetchJson(`/artists/${id}`, opts),
  artistByName: (name, opts) => fetchJson(`/artists/by-name?name=${encodeURIComponent(name)}`, opts),
  search: (q, opts = {}) => fetchJson(`/search?q=${encodeURIComponent(q)}`, opts),
  streamUrl: (id) => `${BASE}/stream/${id}`,
  coverUrl: (path) => path ? (path.startsWith('/api/') ? path : `${BASE}${path}`) : null,
  scan: ({ full = false, reextractCovers = false } = {}) =>
    fetchJson('/scan', { method: 'POST', body: JSON.stringify({ full, reextractCovers }) }),
  scanStatus: (opts) => fetchJson('/scan/status', opts),
  tags: (id, opts) => fetchJson(`/tags/${id}`, opts),
  updateTags: (id, data) => fetchJson(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  spotifyArtist: (name, opts) => fetchJson(`/spotify/artist?name=${encodeURIComponent(name)}`, opts),
  login: (username, password) =>
    fetchJson('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      skipAuthExpire: true,
    }),
  logout: () =>
    fetchJson('/auth/logout', {
      method: 'POST',
      skipAuthExpire: true,
    }),
  register: (username, password) => fetchJson('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  me: (opts) => fetchJson('/auth/me', opts),
  adminUsers: (opts) => fetchJson('/auth/users', opts),
  adminChangePassword: (id, password) =>
    fetchJson(`/auth/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) }),
  adminToggleAdmin: (id, is_admin) =>
    fetchJson(`/auth/users/${id}/admin`, { method: 'PATCH', body: JSON.stringify({ is_admin }) }),
  adminDeleteUser: (id) =>
    fetchJson(`/auth/users/${id}`, { method: 'DELETE' }),
  favorites: (params = {}, opts = {}) => {
    const searchParams = new URLSearchParams();
    let fetchOpts = opts;
    if (params && typeof params === 'object') {
      if ('signal' in params || 'headers' in params) {
        fetchOpts = params;
      } else {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined && v !== null && v !== '') {
            searchParams.set(k, String(v));
          }
        });
      }
    }
    const qs = searchParams.toString();
    return fetchJson(`/favorites${qs ? `?${qs}` : ''}`, fetchOpts);
  },
  favoriteIds: (opts) => fetchJson('/favorites/ids', opts),
  toggleFavoriteTrack: (id) => fetchJson(`/favorites/track/${id}`, { method: 'POST' }),
  toggleFavoriteAlbum: (id) => fetchJson(`/favorites/album/${id}`, { method: 'POST' }),
  toggleFavoriteArtist: (id) => fetchJson(`/favorites/artist/${id}`, { method: 'POST' }),
  genres: (opts) => fetchJson('/genres', opts),
  scrobble: (id) => fetchJson(`/scrobble/${id}`, { method: 'POST' }),
  lyrics: (params, opts) => fetchJson(`/lyrics?${new URLSearchParams(params)}`, opts),
  playlists: (opts) => fetchJson('/playlists', opts),
  playlist: (id, opts) => fetchJson(`/playlists/${id}`, opts),
  createPlaylist: (data) => fetchJson('/playlists', { method: 'POST', body: JSON.stringify(data) }),
  updatePlaylist: (id, data) => fetchJson(`/playlists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlaylist: (id) => fetchJson(`/playlists/${id}`, { method: 'DELETE' }),
  addTracksToPlaylist: (id, trackIds) =>
    fetchJson(`/playlists/${id}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ trackIds: Array.isArray(trackIds) ? trackIds : [trackIds] }),
    }),
  removeTrackFromPlaylist: (id, playlistTrackId) =>
    fetchJson(`/playlists/${id}/tracks/${playlistTrackId}`, { method: 'DELETE' }),
  reorderPlaylist: (id, playlistTrackIds) =>
    fetchJson(`/playlists/${id}/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ playlistTrackIds }),
    }),
};
