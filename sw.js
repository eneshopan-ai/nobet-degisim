/* Nöbet Değişim — servis çalışanı
 * Uygulama kabuğu çevrimdışı açılsın diye önbelleğe alınır. Aynı kaynaktaki
 * istekler önce ağdan (her zaman güncel), ağ yoksa önbellekten gelir.
 * Veritabanı istekleri (başka alan adı) asla önbelleğe alınmaz. */
var CACHE = 'nobet-degisim-v1';
var SHELL = [
  './', 'index.html', 'styles.css', 'config.js', 'storage.js', 'app.js',
  'manifest.webmanifest', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Web Push: bildirim metnini GitHub Actions gönderir (.github/notify.mjs); biz yalnızca gösteririz.
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { /* metin değilse varsayılan */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Yeni nöbet değişikliği', {
    body: d.body || 'Yeni bir nöbet değişikliği bildirildi.',
    icon: 'icons/icon-192.png',
    badge: 'icons/favicon-32.png',
    tag: d.tag,
    lang: 'tr',
    data: { url: d.url || './#/degisiklikler' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './#/degisiklikler', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) {
        return list[i].focus().then(function (c) { return c.navigate ? c.navigate(url) : c; });
      }
    }
    return self.clients.openWindow(url);
  }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
      });
    })
  );
});
