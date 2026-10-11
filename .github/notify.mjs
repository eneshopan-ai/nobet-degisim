// Yeni nöbet bildirimlerini abonelere Web Push ile gönderir. GitHub Actions zamanlayıcısı çalıştırır
// (.github/workflows/bildirim.yml). Ortam: VAPID_PRIVATE_KEY (secret).
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { parseConfig, validSub, newRecords, messages } from './notify-lib.mjs';

const SUBJECT = 'https://eneshopan-ai.github.io/nobet-degisim/';
const CURSOR = '.cursor/son.txt';   // son bildirilen kaydın ts değeri (iş akışı bunu önbellekte tutar)

const cfg = parseConfig(fs.readFileSync('config.js', 'utf8'));
if (!cfg.databaseUrl || !cfg.vapidPublicKey) throw new Error('config.js içinde databaseUrl ve vapidPublicKey gerekli.');
const base = cfg.databaseUrl.replace(/\/+$/, '');

const out = (k, v) => process.env.GITHUB_OUTPUT && fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
async function get(p) {
  const r = await fetch(`${base}/${p}`);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}

let cursor = fs.existsSync(CURSOR) ? Number(fs.readFileSync(CURSOR, 'utf8')) : NaN;
// İmleç yoksa (ilk çalışma ya da önbellek silindi): geçmişi yağdırma, yalnızca son 10 dakikayı bildir.
if (!Number.isFinite(cursor)) cursor = Date.now() - 10 * 60e3;

const recs = newRecords(await get(`${cfg.path}.json?orderBy=%22%24key%22&limitToLast=50`), cursor);
if (!recs.length) { console.log('Yeni kayıt yok.'); out('changed', 'false'); process.exit(0); }

const subs = Object.values((await get('abonelikler.json?orderBy=%22%24key%22&limitToLast=1000')) || {}).filter(validSub)
  .map((s) => ({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }));
console.log(`${recs.length} yeni kayıt, ${subs.length} abone.`);

webpush.setVapidDetails(SUBJECT, cfg.vapidPublicKey, process.env.VAPID_PRIVATE_KEY);
let ok = 0, gone = 0, failed = 0;
for (const m of messages(recs)) {
  for (const s of subs) {
    try { await webpush.sendNotification(s, JSON.stringify(m), { TTL: 86400, urgency: 'high' }); ok++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) gone++;   // abonelik iptal edilmiş
      else { failed++; console.error('gönderilemedi:', e.statusCode, String(e.body || e.message).slice(0, 120)); }
    }
  }
}
console.log(`gönderildi: ${ok}, iptal edilmiş: ${gone}, hata: ${failed}`);

// En fazla bir kez gönderim: kimse hata verse de imleç ilerler (aynı bildirim tekrar tekrar gitmesin).
fs.mkdirSync(path.dirname(CURSOR), { recursive: true });
fs.writeFileSync(CURSOR, String(recs[recs.length - 1].ts));
out('changed', 'true');
if (subs.length && ok === 0 && failed > 0) process.exitCode = 1;   // hiçbiri gitmediyse işi kırmızı yap
