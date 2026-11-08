import { useSyncExternalStore } from 'react';
import { Download, Check, RefreshCw, Smartphone } from 'lucide-react';
import { getPwaController } from '../../pwa.js';

export function PwaSettings() {
  const pwa = getPwaController();
  const state = useSyncExternalStore(pwa.subscribe, pwa.getSnapshot);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return <section className="glass-panel p-6 sm:p-7 rounded-3xl border border-white/[0.08] space-y-4" aria-label="TuneCloud app">
    <div className="flex items-center gap-2.5"><Smartphone className="w-5 h-5 text-accent"/><div>
      <h2 className="text-base font-bold text-white">TuneCloud App</h2>
      <p className="text-xs text-surface-400">Your own window, an app icon, and the same music collection.</p>
    </div></div>
    {state.installed ? <p className="flex items-center gap-2 text-xs text-surface-300" role="status"><Check size={15}/>Running as an installed app</p>
      : state.installable ? <button className="btn-primary px-4 py-2.5 text-xs" onClick={pwa.install} disabled={state.installing}><Download size={15}/>{state.installing ? 'Opening installer…' : 'Install TuneCloud'}</button>
      : <p className="text-xs text-surface-400">{ios ? 'In Safari, open Share and choose “Add to Home Screen”.' : !window.isSecureContext ? 'Open TuneCloud over HTTPS to install it. Localhost is also supported.' : 'Use your browser’s “Install app” or “Add to Home Screen” menu when available.'}</p>}
    {state.supported && <div className="space-y-3 border-t border-white/[0.06] pt-4">
      <p className="text-xs text-surface-400" role="status">{state.updateReady ? 'An update is ready. Close all TuneCloud windows and tabs, then reopen the app to apply it.' : 'Updates are downloaded in the background and applied after all TuneCloud windows close.'}</p>
      <button className="btn-glass px-3 py-2 text-xs" disabled={state.checking} onClick={pwa.checkUpdate}><RefreshCw size={13} className={state.checking ? 'animate-spin' : ''}/>{state.checking ? 'Checking…' : 'Check for updates'}</button>
    </div>}
    {state.error && <p className="text-xs text-rose-300" role="alert">{state.error}</p>}
  </section>;
}
