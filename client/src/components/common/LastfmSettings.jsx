import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { lastfmChanged } from '../../utils/lastfm.js';

const button = 'px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 disabled:opacity-40 text-xs';
const input = 'w-24 rounded-lg bg-surface-900 border border-white/10 px-3 py-2 text-sm';
export function LastfmSettings() {
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState(null);
  const [items, setItems] = useState([]);
  const [rules, setRules] = useState({ tracks: [], artists: [] });
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  async function load(page = offset) {
    const [next, queue, nextRules] = await Promise.all([api.lastfm(), api.lastfmQueue(page), api.lastfmRules()]);
    setStatus(next); setDraft(next.settings); setItems(queue.items); setRules(nextRules); setOffset(page);
  }
  async function action(fn, page = offset) {
    setBusy(true); setError('');
    try { await fn(); lastfmChanged(); await load(page); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const state = params.get('lastfm_state'), token = params.get('token');
    if (state) {
      // Remove transient credentials before any subsequent navigation or rendering.
      const url = new URL(window.location.href);
      url.searchParams.delete('lastfm_state'); url.searchParams.delete('token');
      window.history.replaceState(window.history.state, '', url.pathname + url.search);
      action(async () => {
        if (!token) throw new Error('Authorization was cancelled. Connect again.');
        await api.lastfmComplete({ state, token });
      });
    } else load(0).catch(e => setError(e.message));
  }, []);
  return <section className="glass-panel p-6 sm:p-7 rounded-3xl border border-white/[0.08] space-y-5">
    <div><h2 className="text-base font-bold text-white">Last.fm</h2><p className="text-xs text-surface-400 mt-1">Scrobble music played in TuneCloud’s web player and installed app.</p></div>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    {!status ? <p className="text-sm text-surface-400">Loading Last.fm…</p> : <>
      {!status.configured && <p className="text-sm text-surface-400">Last.fm is not configured. Ask your server administrator to configure the integration.</p>}
      <p className="text-sm">{status.connected ? <>Connected as <a className="text-accent" href={`https://www.last.fm/user/${encodeURIComponent(status.username)}`} target="_blank" rel="noreferrer">{status.username}</a></> : 'No account connected'}</p>
      {status.needsReauth && <p role="status" className="text-sm text-amber-300">Your Last.fm session needs to be reconnected. Pending scrobbles are paused. Reconnecting starts a new connection and clears the old queue.</p>}
      <div className="flex gap-3">
        <button className={button} disabled={busy || !status.configured} onClick={() => action(async () => { const result = await api.lastfmConnect(); window.location.assign(result.url); })}>{status.connected ? 'Reconnect Last.fm' : 'Connect Last.fm'}</button>
        {status.connected && <button className={button} disabled={busy} onClick={() => action(() => api.lastfmDisconnect())}>Disconnect and clear queue</button>}
      </div>
      {status.connected && draft && <form className="space-y-4" onSubmit={e => { e.preventDefault(); action(() => api.lastfmSettings(draft)); }}>
        {[['enabled', 'Enable scrobbling'], ['now_playing', 'Show Now Playing on Last.fm'], ['first_artist', 'Scrobble the first credited artist only']].map(([key, label]) => <label key={key} className="flex gap-3 items-center text-sm"><input type="checkbox" checked={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.checked })} />{label}</label>)}
        <div className="flex flex-wrap gap-5">
          {[['percent', 'Track played (%)', 50, 100], ['seconds', 'Or seconds played', 240, 600], ['min_duration', 'Exclude tracks up to (seconds)', 30, 3600]].map(([key, label, min, max]) => <label key={key} className="flex flex-col gap-2 text-xs text-surface-300">{label}<input className={input} type="number" min={min} max={max} step="1" required value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value === '' ? '' : Number(e.target.value) })} /></label>)}
        </div>
        <p className="text-xs text-surface-400">A play qualifies at the earlier of the percentage and seconds thresholds. Pauses and seeks do not count. Local listening history uses its own threshold.</p>
        <button className={button} disabled={busy}>Save settings</button>
      </form>}
      <div className="border-t border-white/10 pt-4 space-y-3">
        <h3 className="text-sm font-semibold">Delivery</h3>
        <p className="text-xs text-surface-400">Pending: {status.counts.pending || 0} · Sent: {status.counts.sent || 0} · Ignored: {status.counts.ignored || 0} · Failed: {status.counts.failed || 0}</p>
        <div className="flex gap-3"><button className={button} disabled={busy} onClick={() => action(() => Promise.resolve())}>Refresh</button><button className={button} disabled={busy || !status.connected} onClick={() => action(() => api.lastfmRetry())}>Retry pending errors</button></div>
        <ul className="space-y-3">{items.map(item => <li key={item.id} className="text-xs border-b border-white/5 pb-2"><p>{item.payload.artist} — {item.payload.track}</p><p className="text-surface-400">{item.status} · {item.attempts} attempts · {new Date(Number(item.payload.timestamp) * 1000).toLocaleString()}</p>{item.last_error && <p className="text-amber-300">{item.last_error}</p>}</li>)}</ul>
        <div className="flex gap-3"><button className={button} disabled={busy || offset === 0} onClick={() => action(() => Promise.resolve(), Math.max(0, offset - 25))}>Previous</button><button className={button} disabled={busy || items.length < 25} onClick={() => action(() => Promise.resolve(), offset + 25)}>Next</button></div>
      </div>
      {(rules.tracks.length > 0 || rules.artists.length > 0) && <div className="space-y-2 border-t border-white/10 pt-4"><h3 className="text-sm font-semibold">Corrections and exclusions</h3>
        {rules.tracks.map(rule => <div key={rule.track_id} className="flex justify-between items-center gap-3 text-xs"><span>{rule.title || 'Untitled'} {rule.blocked ? '· blocked' : '· corrected'}</span><button className={button} disabled={busy} onClick={() => action(() => api.lastfmResetTrack(rule.track_id))}>Reset rule</button></div>)}
        {rules.artists.map(rule => <div key={rule.artist_id} className="flex justify-between items-center gap-3 text-xs"><span>{rule.name} · blocked</span><button className={button} disabled={busy} onClick={() => action(() => api.lastfmBlockArtist(rule.artist_id, false))}>Unblock artist</button></div>)}
      </div>}
    </>}
  </section>;
}
