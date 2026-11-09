import { useLibraryScan } from '../hooks/useLibraryScan.js';
import { Check, ChevronDown, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { LastfmSettings } from '../components/common/LastfmSettings.jsx';
import { PwaSettings } from '../components/common/PwaSettings.jsx';
import { useTheme } from '../context/ThemeContext.jsx';

export function SettingsView({ user, onScanComplete }) {
  const { theme, setTheme, themes } = useTheme();
  const { scanning, progress, connectionLost, startScan } = useLibraryScan(onScanComplete);
  const total = progress?.toProcess || progress?.total || 0;
  const percentage = progress?.phase === 'processing' && total > 0 ? Math.round((progress.processed || 0) / total * 100)
    : progress?.phase === 'covers' && progress.coversTotal > 0 ? Math.round((progress.coversExtracted || 0) / progress.coversTotal * 100) : null;
  return <div className="settings-page animate-fade-in">
    <header className="settings-page-heading"><h1>Settings</h1><p>Playback, appearance and your music library.</p></header>
    <div className="settings-layout">
      <LastfmSettings />
      <div className="settings-side">
        <section className="settings-card" aria-labelledby="appearance-heading">
          <header className="settings-card-header"><div><h2 id="appearance-heading">Appearance</h2><p>Choose your color theme.</p></div><span className="settings-current-theme">{themes.find(item => item.id === theme)?.name}</span></header>
          <div className="settings-themes">{themes.map(item => <button key={item.id} type="button" className={`settings-theme ${theme === item.id ? 'is-selected' : ''}`} aria-pressed={theme === item.id} onClick={() => setTheme(item.id)}>
            <span className="settings-theme-swatch" style={{ background: `linear-gradient(135deg, ${item.primary}, ${item.secondary})` }} />
            <span>{item.name}</span>{theme === item.id && <Check size={14} />}
          </button>)}</div>
        </section>
        <PwaSettings />
        {user?.is_admin && <section className="settings-card" aria-labelledby="library-settings-heading">
          <header className="settings-card-header"><div><h2 id="library-settings-heading">Music library</h2><p>Keep your collection up to date.</p></div><span className="settings-admin-label">Admin</span></header>
          {connectionLost && <p className="settings-message is-warning" role="status">Scan status unavailable. Reconnecting…</p>}
          {scanning && <div className="settings-scan-progress" role="status"><p><Loader2 size={14} className="animate-spin" />{progress?.phase === 'processing' ? `Reading tags: ${progress.processed || 0} / ${total}` : progress?.phase === 'covers' ? `Artwork: ${progress.coversExtracted || 0} / ${progress.coversTotal || 0}` : progress?.phase === 'cleaning' ? 'Updating library records…' : 'Looking for music…'}{percentage !== null && <span>{percentage}%</span>}</p><div><span style={{ width: `${percentage === null ? 100 : Math.min(100, percentage)}%` }} /></div></div>}
          <div className="settings-library-row"><div><h3>Find new music</h3><p>Scan new, moved and removed files.</p></div><button type="button" className="settings-button" disabled={!!scanning} onClick={() => startScan({ full: false })}><RefreshCw size={14} className={scanning === 'incremental' ? 'animate-spin' : ''} />{scanning === 'incremental' ? 'Scanning…' : 'Scan library'}</button></div>
          <details className="settings-advanced"><summary>Advanced<ChevronDown size={12} className="settings-advanced-arrow" /></summary><div className="settings-library-row"><div><h3>Full rescan</h3><p>Re-read every track’s tags and rebuild artwork.</p></div><button type="button" className="settings-button" disabled={!!scanning} onClick={() => startScan({ full: true, reextractCovers: true })}>{scanning === 'full' ? 'Rescanning…' : 'Rescan all'}</button></div></details>
        </section>}
      </div>
    </div>
    <footer className="settings-footer"><span>TuneCloud</span><a href="https://github.com/skippingclass/TuneCloud" target="_blank" rel="noreferrer">Source code<ExternalLink size={12} /></a><a href="https://github.com/skippingclass/TuneCloud/issues" target="_blank" rel="noreferrer">Report an issue<ExternalLink size={12} /></a></footer>
  </div>;
}
