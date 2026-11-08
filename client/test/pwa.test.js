import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPwaController } from '../src/pwa.js';

function emitter(extra = {}) {
  const handlers = new Map();
  return { ...extra, addEventListener(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
    emit(name, event = {}) { handlers.get(name)?.forEach(handler => handler(event)); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('install prompt is shown only when available, cancelled prompts can return, and installed state is detected', async () => {
  const win = emitter({ isSecureContext: true, matchMedia: () => emitter({ matches: false }) });
  const pwa = createPwaController(win, {});
  pwa.start();
  assert.equal(pwa.getSnapshot().installable, false);
  let prompted = 0, prevented = 0;
  const offer = outcome => win.emit('beforeinstallprompt', {
    preventDefault() { prevented++; }, prompt: async () => { prompted++; }, userChoice: Promise.resolve({ outcome }),
  });
  offer('dismissed');
  assert.equal(pwa.getSnapshot().installable, true);
  await pwa.install();
  assert.equal(prompted, 1);
  assert.equal(prevented, 1);
  assert.equal(pwa.getSnapshot().installable, false);
  assert.equal(pwa.getSnapshot().installed, false);
  await pwa.install();
  assert.equal(prompted, 1, 'an install event is consumed only once');
  offer('accepted');
  await pwa.install();
  win.emit('appinstalled');
  assert.equal(pwa.getSnapshot().installed, true);
  assert.equal(pwa.getSnapshot().installable, false);
  assert.equal(createPwaController({ matchMedia: () => ({ matches: true }) }, {}).getSnapshot().installed, true);
});

test('production updates wait for windows to close and never reload or force activation', async () => {
  const win = emitter({ isSecureContext: true, matchMedia: () => emitter({ matches: false }), location: { reload() { assert.fail('must not reload a playing app'); } } });
  const worker = emitter({ state: 'installing', postMessage() { assert.fail('must not force an update'); } });
  const registration = emitter({ waiting: null, active: {}, installing: worker, update: async () => {} });
  let registrations = 0;
  const serviceWorker = emitter({ controller: {}, register: async (url, options) => {
    registrations++; assert.equal(url, '/sw.js'); assert.equal(options.updateViaCache, 'none'); return registration;
  } });
  const pwa = createPwaController(win, { serviceWorker });
  pwa.start({ registerWorker: true });
  pwa.start({ registerWorker: true });
  await settle();
  assert.equal(registrations, 1);
  registration.emit('updatefound');
  worker.state = 'installed'; worker.emit('statechange');
  assert.equal(pwa.getSnapshot().updateReady, true, 'installed notification can precede registration.waiting');
  registration.waiting = worker;
  assert.equal(pwa.getSnapshot().updateReady, true);
  registration.update = async () => { throw new Error('Offline'); };
  await pwa.checkUpdate();
  assert.equal(pwa.getSnapshot().checking, false);
  assert.ok(pwa.getSnapshot().error.includes('connection'));
  assert.equal(pwa.getSnapshot().updateReady, true, 'network failure does not discard a downloaded update');
});

test('dev and insecure contexts do not register a service worker', async () => {
  let registrations = 0;
  const serviceWorker = { register: () => registrations++ };
  createPwaController(emitter({ isSecureContext: true }), { serviceWorker }).start();
  createPwaController(emitter({ isSecureContext: false }), { serviceWorker }).start({ registerWorker: true });
  await settle();
  assert.equal(registrations, 0);
});

test('worker excludes private APIs, audio, ranges and external origins; offline fallback is public and cache cleanup is scoped', async () => {
  const template = await readFile(new URL('../scripts/service-worker.js', import.meta.url), 'utf8');
  const source = template.replace('__VERSION__', '"test"').replace('__ASSETS__', '["/offline.html","/assets/app.js"]');
  const events = new Map();
  const deleted = [];
  let claimed = false;
  const context = {
    URL, Request, Response,
    self: { location: { origin: 'https://music.test' }, clients: { claim: async () => { claimed = true; } },
      addEventListener: (name, handler) => events.set(name, handler), skipWaiting: () => assert.fail('updates must wait') },
    caches: { keys: async () => ['tunecloud-shell-old', 'tunecloud-shell-test', 'other-app'], delete: async key => deleted.push(key),
      open: async () => ({ match: async url => url === '/offline.html' ? new Response('Reconnect to TuneCloud') : undefined,
        addAll: async requests => assert.ok(requests.every(request => request.credentials === 'omit' && !/\/(api|rest)\//.test(request.url))) }) },
    fetch: async () => { throw new Error('Offline'); },
  };
  vm.runInNewContext(source, context);
  const bypass = request => events.get('fetch')({ request, respondWith() { assert.fail(`must bypass ${request.url}`); } });
  for (const url of ['/api/auth/me', '/api/stream/1', '/api/cover/album/1', '/api/tracks', '/rest/stream.view?id=1']) {
    bypass(new Request('https://music.test' + url));
  }
  bypass(new Request('https://music.test/api/auth/login', { method: 'POST', body: 'private' }));
  bypass(new Request('https://music.test/assets/app.js', { headers: { Range: 'bytes=0-10' } }));
  bypass(new Request('https://other.test/assets/app.js'));
  bypass({ method: 'GET', url: 'https://music.test/track.mp3', headers: new Headers(), destination: 'audio' });
  let response;
  events.get('fetch')({ request: { method: 'GET', url: 'https://music.test/album/7', mode: 'navigate', headers: new Headers() }, respondWith(value) { response = value; } });
  assert.equal(await (await response).text(), 'Reconnect to TuneCloud');
  let activation;
  events.get('activate')({ waitUntil(value) { activation = value; } });
  await activation;
  assert.deepEqual(deleted, ['tunecloud-shell-old']);
  assert.equal(claimed, true);
});
