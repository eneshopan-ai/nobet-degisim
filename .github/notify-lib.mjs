// Bildirim mantığı: ağ ve web-push olmadan, yalnızca saf fonksiyonlar (test/notify.test.mjs sınar).

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

// Abonelik adresleri herkesin yazabildiği veritabanından gelir; yalnızca bilinen push servislerine gönderilir.
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function allowedEndpoint(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

export function validSub(s) {
  return !!s && typeof s.endpoint === 'string' && allowedEndpoint(s.endpoint)
    && !!s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
}

// config.js'ten databaseUrl, path ve vapidPublicKey okur (tek doğruluk kaynağı uygulamanın kendi ayarı).
export function parseConfig(text) {
  // Dosyanın başındaki yorumda örnek bir databaseUrl var; yorumları atla.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const pick = (k) => { const m = new RegExp(k + "\\s*:\\s*'([^']*)'").exec(code); return m ? m[1] : ''; };
  return { databaseUrl: pick('databaseUrl'), path: pick('path') || 'nobetler', vapidPublicKey: pick('vapidPublicKey') };
}

// Veritabanından gelen { id: kayıt } nesnesinden, imleçten (ts) sonra eklenenleri eskiden yeniye döndürür.
export function newRecords(obj, cursor) {
  return Object.entries(obj || {})
    .map(([id, v]) => ({ id, ...v }))
    .filter((r) => r && typeof r.ts === 'number' && r.ts > cursor
      && typeof r.olusturan === 'string' && typeof r.karsi === 'string' && ISO.test(r.tarih || ''))
    .sort((a, b) => a.ts - b.ts);
}

export function dayLabel(iso) {
  const m = ISO.exec(iso || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '';
}

export function messageFor(r) {
  const d1 = dayLabel(r.tarih), d2 = dayLabel(r.karsiTarih);
  return {
    title: 'Yeni nöbet değişikliği',
    body: `${r.olusturan} ↔ ${r.karsi} · ${d2 ? `${d1} ↔ ${d2}` : d1}`,
    tag: r.id,
    url: './#/degisiklikler'
  };
}

// Kısa sürede çok kayıt gelirse telefonu bildirime boğmamak için tek özet bildirim.
export function messages(recs, max = 5) {
  if (recs.length <= max) return recs.map(messageFor);
  return [{ title: 'Yeni nöbet değişiklikleri', body: `${recs.length} yeni bildirim var.`, tag: 'ozet', url: './#/degisiklikler' }];
}
