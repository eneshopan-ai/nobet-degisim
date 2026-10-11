// Bildirim mantığının birim testi (ağ yok): node test/notify.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allowedEndpoint, validSub, parseConfig, newRecords, dayLabel, messageFor, messages } from '../.github/notify-lib.mjs';

// Abonelik adresi yalnızca bilinen push servislerinde olabilir (veritabanını herkes yazabiliyor).
assert.equal(allowedEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
assert.equal(allowedEndpoint('https://web.push.apple.com/QAbc'), true);
assert.equal(allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
assert.equal(allowedEndpoint('http://fcm.googleapis.com/x'), false, 'http olmaz');
assert.equal(allowedEndpoint('https://fcm.googleapis.com.evil.com/x'), false, 'alan adı sonek hilesi');
assert.equal(allowedEndpoint('https://evilfcm.googleapis.com.x'), false);
assert.equal(allowedEndpoint('https://169.254.169.254/latest'), false);
assert.equal(allowedEndpoint('not a url'), false);
assert.equal(validSub({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } }), true);
assert.equal(validSub({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a' } }), false);
assert.equal(validSub(null), false);

// Depodaki gerçek config.js okunabiliyor.
const cfg = parseConfig(fs.readFileSync(fileURLToPath(new URL('../config.js', import.meta.url)), 'utf8'));
assert.match(cfg.databaseUrl, /^https:\/\/.+firebasedatabase\.app$/);
assert.equal(cfg.path, 'nobetler');
assert.match(cfg.vapidPublicKey, /^[A-Za-z0-9_-]{87}$/, 'VAPID genel anahtarı 65 bayt = 87 base64url karakter');

// Yalnızca imleçten sonraki, geçerli kayıtlar; eskiden yeniye.
const db = {
  a: { olusturan: 'Ayşe Yılmaz', karsi: 'Mehmet Demir', tarih: '2026-10-14', karsiTarih: '2026-10-20', ts: 300 },
  b: { olusturan: 'Can Öztürk', karsi: 'Zeynep Kaya', tarih: '2026-10-15', ts: 200 },       // eski kayıt (tek tarih)
  c: { olusturan: 'Eski', karsi: 'Kayıt', tarih: '2026-10-01', ts: 100 },                    // imleçten önce
  d: { olusturan: 'Bozuk', karsi: 'Kayıt', tarih: 'yarın', ts: 400 },                         // geçersiz tarih
  e: { olusturan: 'Ts yok', karsi: 'Kayıt', tarih: '2026-10-01' }
};
assert.deepEqual(newRecords(db, 150).map((r) => r.id), ['b', 'a']);
assert.deepEqual(newRecords(db, 300).map((r) => r.id), []);
assert.deepEqual(newRecords(null, 0), []);

assert.equal(dayLabel('2026-10-14'), '14 Ekim');
assert.equal(dayLabel('2026-02-05'), '5 Şubat');
assert.equal(dayLabel('x'), '');

const m = messageFor({ id: 'a', ...db.a });
assert.equal(m.body, 'Ayşe Yılmaz ↔ Mehmet Demir · 14 Ekim ↔ 20 Ekim');
assert.equal(messageFor({ id: 'b', ...db.b }).body, 'Can Öztürk ↔ Zeynep Kaya · 15 Ekim', 'eski kayıt tek tarihle');

// Çok kayıt: tek özet bildirim.
const many = Array.from({ length: 6 }, (_, i) => ({ id: 'k' + i, ...db.a, ts: 1000 + i }));
assert.equal(messages(many.slice(0, 5)).length, 5);
assert.deepEqual(messages(many).map((x) => x.body), ['6 yeni bildirim var.']);

console.log('notify.test: tüm kontroller geçti');
