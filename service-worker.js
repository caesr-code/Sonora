const CACHE = 'sonora-shell-v3.0.0';
const BASE = new URL('./', self.location.href);
const INDEX = new URL('index.html', BASE).href;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/main.js',
  './src/artwork.js',
  './src/audio-engine.js',
  './src/db.js',
  './src/icons.js',
  './src/id3.js',
  './src/library-manager.js',
  './src/settings.js',
  './src/ui.js',
  './src/utils.js',
  './src/virtual-list.js',
  './src/waveform.js',
  './src/zip-reader.js',
  './vendor/jszip.min.js',
  './assets/icons/favicon-32.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png'
].map((path) => new URL(path, BASE).href);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(BASE.href)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(CACHE).then((cache) => cache.put(INDEX, response.clone()));
          return response;
        })
        .catch(() => caches.match(INDEX))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      });
      return cached || network;
    })
  );
});
