// ══════════════════════════════════════════════
// BestPriceTank Service Worker v3.1
// Offline-Fähigkeit + schnelles Laden
// ══════════════════════════════════════════════
const CACHE_NAME = 'bestpricetank-v3';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

// Installation – Dateien cachen
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('✅ BPT Cache geöffnet');
      return cache.addAll(CACHE_URLS).catch(err => {
        console.log('Cache teilweise fehlgeschlagen (ok):', err);
      });
    })
  );
  self.skipWaiting();
});

// Aktivierung – alten Cache löschen
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch – Cache first für statische Dateien
//         Network first für API Calls
self.addEventListener('fetch', event => {

  // ✅ FIX: chrome-extension:// und andere non-http URLs sofort überspringen
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  // API Calls immer frisch vom Netzwerk
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/.netlify/functions/') ||
    url.hostname.includes('tankerkoenig') ||
    url.hostname.includes('exchangerate-api') ||
    url.hostname.includes('openai') ||
    url.hostname.includes('openchargemap')
  ) {
    return; // Browser Standard – kein Cache
  }

  // Alles andere: Cache first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Nur gültige Responses cachen
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseClone);
        });
        return response;
      }).catch(() => {
        // Offline Fallback
        return caches.match('/index.html');
      });
    })
  );
});
