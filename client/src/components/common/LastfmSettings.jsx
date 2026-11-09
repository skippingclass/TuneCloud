import { useEffect, useId, useRef, useState } from 'react';
import { Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Loader2, Music2, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react';
import { api } from '../../api.js';
import { lastfmChanged } from '../../utils/lastfm.js';

const defaults = { enabled: true, now_playing: false, first_artist: true, percent: 50, seconds: 240, min_duration: 30 };
const sliderMax = { min_duration: 60, percent: 95, seconds: 360 };
const clock = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
const switches = [
  ['enabled', 'Enable scrobbling', 'Add the music you play here to your Last.fm history.'],
  ['now_playing', 'Show Now Playing', 'Show your current track before it scrobbles.'],
  ['first_artist', 'First credited artist only', 'Use the main artist for tracks with multiple performers.'],
];

function ScrobbleSlider({ id, label, value, min, max, step = 1, unit, defaultValue, onChange, disabled }) {
  const formatted = unit === '%' ? `${value}%` : clock(value);
  return <div className="settings-slider-field">
    <label htmlFor={id}>{label}</label>
    <div className="settings-slider-row">
      <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        aria-label={label} aria-valuetext={formatted} onChange={event => onChange(Number(event.target.value))}
        className="settings-slider" style={{ '--slider-progress': `${(value - min) / (max - min) * 100}%` }} />
      <output htmlFor={id}>{formatted}</output>
      <button type="button" className="settings-icon-button" aria-label={`Reset ${label}`} title={`Reset to ${unit === '%' ? `${defaultValue}%` : clock(defaultValue)}`}
        disabled={disabled || value === defaultValue} onClick={() => onChange(defaultValue)}><RotateCcw size={15} /></button>
    </div>
  </div>;
}

export function LastfmSettings() {
  const formId = useId();
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState(null);
  const [items, setItems] = useState([]);
  const [rules, setRules] = useState({ tracks: [], artists: [] });
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  async function load(page = offset, syncDraft = true) {
    const [next, queue, nextRules] = await Promise.all([api.lastfm(), api.lastfmQueue(page), api.lastfmRules()]);
    const boundedSettings = { ...next.settings };
    for (const [key, max] of Object.entries(sliderMax)) boundedSettings[key] = Math.min(boundedSettings[key], max);
    setStatus(next); setDraft(previous => syncDraft || !previous ? boundedSettings : previous);
    setItems(queue.items); setRules(nextRules); setOffset(page);
  }
  async function action(fn, { page = offset, syncDraft = false, message = '' } = {}) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); lastfmChanged(); await load(page, syncDraft); setNotice(message); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const state = params.get('lastfm_state'), token = params.get('token');
    if (state) {
      const url = new URL(window.location.href);
      url.searchParams.delete('lastfm_state'); url.searchParams.delete('token');
      window.history.replaceState(window.history.state, '', url.pathname + url.search);
      action(async () => {
        if (!token) throw new Error('Authorization was cancelled. Connect again.');
        await api.lastfmComplete({ state, token });
      }, { syncDraft: true });
    } else load(0).catch(e => setError(e.message));
  }, []);
  const dirty = draft && status && Object.keys(defaults).some(key => draft[key] !== status.settings[key]);
  const change = (key, value) => { setDraft(previous => ({ ...previous, [key]: value })); setNotice(''); };
  const ruleCount = rules.tracks.length + rules.artists.length;
  return <section className="settings-card lastfm-card" aria-labelledby={`${formId}-heading`}>
    <header className="settings-card-header">
      <div><h2 id={`${formId}-heading`}>Last.fm</h2><p>Scrobble plays from the web player.</p></div>
      <Music2 size={20} className="settings-card-icon" aria-hidden="true" />
    </header>
    {error && <p role="alert" className="settings-message is-error"><TriangleAlert size={15} />{error}</p>}
    {!status ? <p className="settings-muted" role="status"><Loader2 size={15} className="animate-spin" />Loading Last.fm…</p> : <>
      {!status.configured && <p className="settings-message">Last.fm is not configured on this server. Ask your administrator to enable it.</p>}
      <div className="lastfm-account">
        <div className="lastfm-avatar" aria-hidden="true">{status.connected ? status.username.slice(0, 1).toUpperCase() : <Music2 size={20} />}</div>
        <div className="lastfm-account-copy">
          {status.connected ? <><a href={`https://www.last.fm/user/${encodeURIComponent(status.username)}`} target="_blank" rel="noreferrer">{status.username}<ExternalLink size={12} /></a>
            <span><i className={`settings-status-dot ${status.needsReauth ? 'is-warning' : 'is-success'}`} />{status.needsReauth ? 'Reconnect to continue' : 'Connected'}</span></>
            : <><strong>Connect your account</strong><span>Keep your Last.fm history up to date.</span></>}
        </div>
        {status.connected ? <details className="lastfm-account-menu"><summary>Account<ChevronDown size={13} /></summary><div>
          <button type="button" disabled={busy || !status.configured} onClick={() => action(async () => { const result = await api.lastfmConnect(); window.location.assign(result.url); })}>Reconnect Last.fm</button>
          <button type="button" disabled={busy} onClick={() => action(() => api.lastfmDisconnect(), { syncDraft: true })}>Disconnect and clear queue</button>
          <p>Reconnecting or disconnecting clears pending scrobbles.</p>
        </div></details> : <button type="button" className="settings-button is-primary" disabled={busy || !status.configured} onClick={() => action(async () => { const result = await api.lastfmConnect(); window.location.assign(result.url); })}>Connect Last.fm</button>}
      </div>
      {status.needsReauth && <p className="settings-message is-warning">Your session has expired. Reconnect your account to resume scrobbling.</p>}
      {status.connected && draft && <form onSubmit={event => { event.preventDefault(); action(() => api.lastfmSettings(draft), { syncDraft: true, message: 'Settings saved' }); }}>
        <div className="lastfm-switches">{switches.map(([key, title, description]) => <label key={key} className="settings-option">
          <span><span className="settings-option-title" id={`${formId}-${key}-title`}>{title}</span><span className="settings-option-description" id={`${formId}-${key}-description`}>{description}</span></span>
          <span className="settings-switch"><input type="checkbox" role="switch" checked={draft[key]} disabled={busy} aria-checked={draft[key]}
            aria-labelledby={`${formId}-${key}-title`} aria-describedby={`${formId}-${key}-description`} onChange={event => change(key, event.target.checked)} /><span /></span>
        </label>)}</div>
        <div className="lastfm-thresholds">
          <ScrobbleSlider id={`${formId}-min-duration`} label="Scrobble tracks longer than" value={draft.min_duration} min={30} max={sliderMax.min_duration} defaultValue={defaults.min_duration} onChange={value => change('min_duration', value)} disabled={busy} />
          <div className="lastfm-delay-heading"><h3>Scrobble delay</h3><span>Whichever comes first</span></div>
          <ScrobbleSlider id={`${formId}-percent`} label="Percent" value={draft.percent} min={50} max={sliderMax.percent} unit="%" defaultValue={defaults.percent} onChange={value => change('percent', value)} disabled={busy} />
          <ScrobbleSlider id={`${formId}-seconds`} label="Minutes" value={draft.seconds} min={240} max={sliderMax.seconds} defaultValue={defaults.seconds} onChange={value => change('seconds', value)} disabled={busy} />
          <p className="settings-hint">Only listening time counts. Pauses and seeking are excluded.</p>
        </div>
        <div className="lastfm-save-row"><button className="settings-button is-primary" disabled={busy || !dirty}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}Save settings</button>
          <span role="status">{notice || (dirty ? 'Unsaved changes' : 'All changes saved')}</span></div>
      </form>}
      {status.connected && <div className="lastfm-delivery">
        <div className="settings-section-heading"><h3>Scrobble history</h3><button type="button" className="settings-icon-button" aria-label="Refresh scrobble history" title="Refresh" disabled={busy} onClick={() => action(() => Promise.resolve())}><RefreshCw size={15} className={busy ? 'animate-spin' : ''} /></button></div>
        <dl className="lastfm-counts">{[['sent', 'Sent'], ['pending', 'Pending'], ['ignored', 'Ignored'], ['failed', 'Failed']].map(([key, label]) => <div key={key}><dt>{label}</dt><dd className={key === 'failed' && status.counts[key] ? 'is-error' : ''}>{status.counts[key] || 0}</dd></div>)}</dl>
        {items.length ? <ul className="lastfm-history">{(expanded ? items : items.slice(0, 5)).map(item => <li key={item.id}>
          <span className={`lastfm-history-icon ${item.status === 'sent' ? 'is-success' : item.last_error ? 'is-warning' : ''}`}>{item.status === 'sent' ? <CheckCheck size={16} /> : item.last_error ? <TriangleAlert size={16} /> : <Music2 size={16} />}</span>
          <div className="lastfm-history-copy"><p title={`${item.payload.artist} — ${item.payload.track}`}>{item.payload.track}</p><span>{item.payload.artist}</span>{item.last_error && <span className="is-warning">{item.last_error}</span>}</div>
          <div className="lastfm-history-meta"><time dateTime={new Date(Number(item.payload.timestamp) * 1000).toISOString()}>{new Date(Number(item.payload.timestamp) * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><span>{item.status} · {item.attempts} {item.attempts === 1 ? 'attempt' : 'attempts'}</span></div>
        </li>)}</ul> : <div className="lastfm-empty"><Music2 size={21} /><p>Your next listen starts here.</p><span>Completed plays from the web player will appear here.</span></div>}
        <div className="lastfm-history-actions">
          {items.length > 5 && <button type="button" className="settings-text-button" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show all ${items.length}`}</button>}
          {status.counts.pending > 0 && <button type="button" className="settings-text-button" disabled={busy} onClick={() => action(() => api.lastfmRetry())}>Retry pending errors</button>}
          {(offset > 0 || items.length === 25) && <nav aria-label="Scrobble history pages"><button type="button" className="settings-icon-button" aria-label="Previous scrobbles" disabled={busy || offset === 0} onClick={() => action(() => Promise.resolve(), { page: Math.max(0, offset - 25) })}><ChevronLeft size={16} /></button><button type="button" className="settings-icon-button" aria-label="Next scrobbles" disabled={busy || items.length < 25} onClick={() => action(() => Promise.resolve(), { page: offset + 25 })}><ChevronRight size={16} /></button></nav>}
        </div>
      </div>}
      {ruleCount > 0 && <details className="lastfm-rules"><summary>Corrections & exclusions<span>{ruleCount}<ChevronDown size={14} /></span></summary><div>
        {rules.tracks.map(rule => <div key={rule.track_id} className="lastfm-rule"><span>{rule.title || 'Untitled'}<small>{rule.blocked ? 'Track excluded' : 'Personal correction'}</small></span><button className="settings-text-button" disabled={busy} onClick={() => action(() => api.lastfmResetTrack(rule.track_id))}>Reset</button></div>)}
        {rules.artists.map(rule => <div key={rule.artist_id} className="lastfm-rule"><span>{rule.name}<small>Artist excluded</small></span><button className="settings-text-button" disabled={busy} onClick={() => action(() => api.lastfmBlockArtist(rule.artist_id, false))}>Unblock</button></div>)}
      </div></details>}
    </>}
  </section>;
}
