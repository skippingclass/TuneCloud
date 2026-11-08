// Browser integration lives outside React so an install prompt survives navigation.
export function createPwaController(win, nav) {
  let prompt = null;
  let registration = null;
  let started = false;
  const listeners = new Set();
  const mode = win.matchMedia?.('(display-mode: standalone)');
  let state = {
    installed: Boolean(mode?.matches || nav.standalone),
    installable: false,
    installing: false,
    supported: Boolean(win.isSecureContext && nav.serviceWorker),
    updateReady: false,
    checking: false,
    error: '',
  };
  const set = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const ready = () => set({ updateReady: Boolean(registration?.waiting) });
  const installPrompt = event => {
    event.preventDefault();
    prompt = event;
    set({ installable: true, error: '' });
  };
  const installed = () => { prompt = null; set({ installed: true, installable: false, installing: false }); };
  const displayMode = () => { if (mode?.matches || nav.standalone) installed(); };
  async function checkUpdate() {
    if (!registration || state.checking) return;
    set({ checking: true, error: '' });
    try { await registration.update(); ready(); }
    catch { set({ error: 'Could not check for updates. Check your connection and try again.' }); }
    finally { set({ checking: false }); }
  }
  async function register() {
    try {
      registration = await nav.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      ready();
      const watchWorker = () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          // waiting can still be null during the installed statechange event.
          if (worker.state === 'installed') set({
            updateReady: Boolean(registration.waiting || (registration.active && registration.active !== worker)),
          });
        });
      };
      registration.addEventListener('updatefound', watchWorker);
      watchWorker();
    } catch { set({ error: 'App updates are unavailable. Reload when your server is reachable.' }); }
  }
  return {
    getSnapshot: () => state,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    start({ registerWorker = false } = {}) {
      if (started) return;
      started = true;
      win.addEventListener('beforeinstallprompt', installPrompt);
      win.addEventListener('appinstalled', installed);
      mode?.addEventListener?.('change', displayMode);
      if (registerWorker && state.supported) {
        register();
        win.addEventListener('online', checkUpdate);
        nav.serviceWorker.addEventListener('controllerchange', ready);
      }
    },
    async install() {
      if (!prompt || state.installing) return;
      const event = prompt;
      prompt = null;
      set({ installing: true, installable: false, error: '' });
      try { await event.prompt(); await event.userChoice; }
      catch { set({ error: 'Installation could not start. Use your browser’s install menu or try again later.' }); }
      finally { set({ installing: false }); }
    },
    checkUpdate,
  };
}

let controller;
export function getPwaController() {
  if (!controller) controller = createPwaController(window, navigator);
  return controller;
}
