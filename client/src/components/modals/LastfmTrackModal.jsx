import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';
import { useDialog } from '../../hooks/useDialog.js';
import { lastfmChanged } from '../../utils/lastfm.js';

const labels = { artist: 'Artist', track: 'Track title', album: 'Album', albumArtist: 'Album artist' };
export function LastfmTrackModal({ track, onClose }) {
  const ref = useDialog(true, onClose);
  const [data, setData] = useState(null);
  const [values, setValues] = useState({});
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; api.lastfmTrack(track.id).then(result => { if (active) { setData(result); setValues(result.preview); setBlocked(result.blocked); } }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [track.id]);
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const overrides = Object.fromEntries(Object.keys(labels).filter(key => values[key] !== data.original[key]).map(key => [key, values[key].trim()]));
      await api.lastfmSaveTrack(track.id, { overrides, blocked }); lastfmChanged(); onClose();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return createPortal(<div className="fixed inset-0 z-[250] bg-black/70 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="lastfm-track-heading" tabIndex={-1} className="glass-panel rounded-3xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto space-y-4">
      <h2 id="lastfm-track-heading" className="text-lg font-bold">Correct for Last.fm</h2>
      <p className="text-xs text-surface-400">Personal corrections for future scrobbles. Music files and library tags stay unchanged.</p>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {data && <form onSubmit={save} className="space-y-4">
        {Object.entries(labels).map(([key, label]) => <label key={key} className="block text-xs space-y-1"><span>{label}</span><input maxLength={1000} required={key === 'artist' || key === 'track'} className="w-full rounded-xl bg-surface-900 border border-white/10 px-3 py-2 text-sm" value={values[key] || ''} onChange={e => setValues({ ...values, [key]: e.target.value })} /></label>)}
        <p className="text-xs text-surface-400">Preview: {values.artist} — {values.track}{values.album ? ` · ${values.album}` : ''}</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={blocked} onChange={e => setBlocked(e.target.checked)} />Do not scrobble this track</label>
        {data.artistBlocked && <p className="text-xs text-amber-300">This artist is blocked. Unblock the artist in Last.fm settings to scrobble this track.</p>}
        <div className="flex gap-3"><button disabled={busy} className="px-4 py-2 bg-accent/20 rounded-xl text-sm">Save</button><button type="button" onClick={() => setValues(data.original)} className="px-3 py-2 bg-white/10 rounded-xl text-sm">Reset corrections</button></div>
      </form>}
      <button disabled={busy} onClick={onClose} className="text-sm text-surface-400">Close</button>
    </div>
  </div>, document.body);
}
