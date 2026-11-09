import { useSyncExternalStore } from 'react';
import { Download, Check, RefreshCw, Smartphone } from 'lucide-react';
import { getPwaController } from '../../pwa.js';

export function PwaSettings() {
  const pwa = getPwaController();
  const state = useSyncExternalStore(pwa.subscribe, pwa.getSnapshot);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return <section className="settings-card" aria-label="TuneCloud app">
    <header className="settings-card-header"><div><h2>TuneCloud app</h2><p>Install TuneCloud in its own app window.</p></div><Smartphone size={20} className="settings-card-icon" /></header>
    {state.installed ? <p className="settings-muted" role="status"><Check size={15} />Running as an installed app</p>
      : state.installable ? <button className="settings-button" onClick={pwa.install} disabled={state.installing}><Download size={15} />{state.installing ? 'Opening installer…' : 'Install TuneCloud'}</button>
      : <p className="settings-hint">{ios ? 'In Safari, open Share and choose “Add to Home Screen”.' : !window.isSecureContext ? 'Open TuneCloud over HTTPS to install it. Localhost is also supported.' : 'Use your browser’s “Install app” or “Add to Home Screen” menu.'}</p>}
    {state.supported && <div className="settings-app-update"><p role="status">{state.updateReady ? 'An update is ready. Close all TuneCloud windows and tabs, then reopen the app.' : 'Updates apply when all TuneCloud windows are closed.'}</p><button className="settings-text-button" disabled={state.checking} onClick={pwa.checkUpdate}><RefreshCw size={13} className={state.checking ? 'animate-spin' : ''} />{state.checking ? 'Checking…' : 'Check for updates'}</button></div>}
    {state.error && <p className="settings-message is-error" role="alert">{state.error}</p>}
  </section>;
}
