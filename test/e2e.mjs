/**
 * Uçtan uca test (Chromium). Çalıştırma:  node test/e2e.mjs
 *
 * - Uygulamayı yerel bir statik sunucudan açar.
 * - Firebase Realtime Database REST sözleşmesini taklit eden küçük bir sahte
 *   sunucu başlatır (POST ile ekleme, DELETE ile silme, orderBy/limitToLast ile okuma, ".sv" saat).
 *   GERÇEK Firebase'e bağlanmaz; kuralları (database.rules.json) sınamaz.
 * - İki bağımsız tarayıcı bağlamı = iki ayrı telefon: A ekler, B görür.
 *
 * Ortam: OUT (ekran görüntüsü klasörü), CHROMIUM_PATH (isteğe bağlı).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT || path.join(os.tmpdir(), 'nobet-shots');
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json'
};

/* ------------------------------------------------------------ statik sunucu */
function startStatic() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('yok'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

/* ---------------------------------------------------- sahte Firebase RTDB */
function startMockDb() {
  const store = new Map();          // pushId -> kayıt
  const ctl = { failPost: false, failDelete: false, denySubs: false, posts: 0, deletes: 0 };
  const subs = new Map();           // abonelik kimliği -> kayıt
  let counter = 0;
  const pushId = () => '-N' + Date.now().toString(36).padStart(9, '0') + String(counter++).padStart(4, '0');
  const cors = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type', 'Cache-Control': 'no-cache'
  };
  // database.rules.json ile aynı: dört alan zorunlu, karsiTarih isteğe bağlı (eski kayıtlar), başka alan yok.
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const valid = (v) => v && typeof v === 'object'
    && ['karsi', 'olusturan', 'tarih', 'ts'].every((k) => k in v)
    && Object.keys(v).every((k) => ['karsi', 'karsiTarih', 'olusturan', 'tarih', 'ts'].includes(k))
    && [v.olusturan, v.karsi].every((s) => typeof s === 'string' && s.length >= 2 && s.length <= 40)
    && ISO.test(v.tarih) && (v.karsiTarih === undefined || ISO.test(v.karsiTarih)) && typeof v.ts === 'number';

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    // database.rules.json "abonelikler": herkes okur, yalnızca ilk yazıma izin (var olan 401), adres https olmalı.
    const sub = /^\/abonelikler\/([^/]+)\.json$/.exec(u.pathname);
    if (sub) {
      const id = decodeURIComponent(sub[1]);
      if (req.method === 'GET') {
        if (ctl.denySubs) { res.writeHead(401, cors); return res.end('{"error":"Permission denied"}'); }   // kurallar yayınlanmamış: okuma da kapalı
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(subs.get(id) ?? null));
      }
      if (req.method === 'PUT') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const v = JSON.parse(raw);
          if (v && v.ts && v.ts['.sv'] === 'timestamp') v.ts = Date.now();
          const ok = !ctl.denySubs && !subs.has(id) && typeof v.endpoint === 'string' && v.endpoint.startsWith('https://')
            && v.keys && typeof v.keys.p256dh === 'string' && typeof v.keys.auth === 'string' && typeof v.ts === 'number'
            && Object.keys(v).sort().join() === 'endpoint,keys,ts';
          if (!ok) { res.writeHead(401, cors); return res.end('{"error":"Permission denied"}'); }
          subs.set(id, v);
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(v));
        });
        return;
      }
    }
    const del = /^\/nobetler\/([^/]+)\.json$/.exec(u.pathname);
    if (del && req.method === 'DELETE') {
      ctl.deletes++;
      if (ctl.failDelete) { res.writeHead(500, cors); return res.end('{"error":"mock failure"}'); }
      store.delete(decodeURIComponent(del[1]));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end('null');
    }
    if (u.pathname !== '/nobetler.json') { res.writeHead(404, cors); return res.end('null'); }

    if (req.method === 'GET') {
      assert.equal(u.searchParams.get('orderBy'), '"$key"', 'orderBy="$key" bekleniyordu');
      const limit = Number(u.searchParams.get('limitToLast'));
      assert.ok(limit > 0, 'limitToLast bekleniyordu');
      const keys = [...store.keys()].sort().slice(-limit);
      const body = keys.length ? Object.fromEntries(keys.map((k) => [k, store.get(k)])) : null;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(body));
    }

    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        ctl.posts++;
        if (ctl.failPost) { res.writeHead(500, cors); return res.end('{"error":"mock failure"}'); }
        let v;
        try { v = JSON.parse(raw); } catch { res.writeHead(400, cors); return res.end('{"error":"bad json"}'); }
        if (v && v.ts && v.ts['.sv'] === 'timestamp') v.ts = Date.now();
        if (!valid(v)) { res.writeHead(401, cors); return res.end('{"error":"Permission denied"}'); }
        const id = pushId();
        store.set(id, v);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: id }));
      });
      return;
    }
    res.writeHead(405, cors); res.end();
  });
  const seed = (rec) => { const id = pushId(); store.set(id, rec); return id; };
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}`, store, subs, ctl, seed })));
}

/* ----------------------------------------------------------- yardımcılar */
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const trLong = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${DAYS[d.getDay()]}`;
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const sentence = (a, b, d, d2) => `Ben ${a}, ${trLong(d)} tarihli nöbetimle, ${trLong(d2)} tarihli ${b} adlı kişinin nöbetini değiştirdim.`;
// İkinci tarih alanından önce kaydedilmiş eski kayıtlar eski cümleyle gösterilir.
const legacySentence = (a, b, d) => `Ben ${a}, ${b} ile ${trLong(d)} tarihli olan nöbetimi değiştirdim.`;

let passed = 0;
const step = (name) => console.log(`  ✓ ${name}`) || passed++;

function track(page, errors) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
}

// Depodaki config.js gerçek veritabanı adresini taşır; testler hermetik kalsın diye her zaman üzerine yazılır.
// dbUrl yoksa demo modu (databaseUrl: '') zorlanır.
const forceConfig = (ctx, dbUrl, vapid) => ctx.route('**/config.js', (route) => route.fulfill({
  contentType: 'text/javascript',
  body: `window.NOBET_CONFIG = { databaseUrl: ${JSON.stringify(dbUrl || '')}, path: 'nobetler', limit: 500, pollSeconds: 5${vapid ? `, vapidPublicKey: ${JSON.stringify(vapid)}` : ''} };`
}));

// Gerçek push servisine bağlanmadan Web Push API'sini taklit eder: izin, abonelik, abonelikten çıkma.
function pushStub({ permission, noPushManager }) {
  // Gerçek tarayıcıda izin ve abonelik sayfa yenilense de kalır; taklidi de sessionStorage ile kalıcı tutarız.
  const ss = window.sessionStorage;
  const st = { perm: ss.getItem('__perm') || permission, sub: null, opts: null };
  window.__push = st;
  if (noPushManager) { delete window.PushManager; window.PushManager = undefined; delete window.PushManager; return; }
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-test-endpoint',
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BPe2eP256dhKey', auth: 'e2eAuthSecret' } }; },
    unsubscribe: async () => { st.sub = null; ss.removeItem('__sub'); return true; }
  };
  if (ss.getItem('__sub')) st.sub = sub;
  const reg = { pushManager: { getSubscription: async () => st.sub, subscribe: async (o) => { st.opts = o; st.sub = sub; ss.setItem('__sub', '1'); return sub; } } };
  Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg) });
  Object.defineProperty(Notification, 'permission', { get: () => st.perm, configurable: true });
  Notification.requestPermission = async () => { if (st.perm === 'default') { st.perm = 'granted'; ss.setItem('__perm', 'granted'); } return st.perm; };
}

async function newPhone(browser, appUrl, dbUrl, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    colorScheme: opts.colorScheme || 'light', locale: 'tr-TR', serviceWorkers: 'block',
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {})
  });
  await forceConfig(ctx, dbUrl, opts.vapid);
  if (opts.pushStub) await ctx.addInitScript(pushStub, opts.pushStub);
  const page = await ctx.newPage();
  const errors = [];
  track(page, errors);
  return { ctx, page, errors, appUrl };
}

async function report(page, a, b, date, date2) {
  await page.locator('#cta:visible, #btn-add:visible').first().click(); // sekmeye göre hangisi görünürse
  await page.waitForSelector('#sheet-root:not([hidden])');
  await page.fill('#f-name', a);
  await page.fill('#f-other', b);
  await page.fill('#f-date', iso(date));
  await page.fill('#f-date2', iso(date2));
  await page.click('#btn-submit');
}

const cardTexts = (page) => page.$$eval('#feed .swap .swap-text', (n) => n.map((x) => x.textContent));
// Mobil emülasyonda taşan içerik görünüm alanını genişletebilir; bu yüzden scrollWidth yerine
// her görünür elementin kenarını cihazın gerçek genişliğiyle karşılaştırıyoruz.
const overflowing = (page, width) => page.evaluate((w) => {
  const bad = [];
  document.querySelectorAll('body *').forEach((n) => {
    if (n.closest('[hidden]')) return;
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    if (r.right > w + 1 || r.left < -1) {
      const cls = typeof n.className === 'string' ? n.className : '';
      bad.push(`${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}.${cls.split(' ')[0]} (sağ kenar ${Math.round(r.right)} > ${w})`);
    }
  });
  return bad.slice(0, 5);
}, width);
const settle = (page) => page.waitForTimeout(550); // giriş animasyonları bitsin

/* ------------------------------------------------------------------ testler */
const { server: staticSrv, url: APP } = await startStatic();
const db = await startMockDb();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const allErrors = [];

try {
  console.log('\n[1] Ortak ve kalıcı kayıt (iki ayrı telefon)');
  const A = await newPhone(browser, APP, db.url);
  const B = await newPhone(browser, APP, db.url);
  allErrors.push(A.errors, B.errors);
  // Eski sürümün telefona kaydettiği ad (ör. test adı) formu kendiliğinden doldurmamalı.
  await A.ctx.addInitScript(() => { try { localStorage.setItem('nobet.v1.ad', 'Eski Ad'); } catch (e) { /* önemsiz */ } });

  await A.page.goto(APP + '/');
  await A.page.waitForFunction(() => document.getElementById('sync').dataset.state === 'live');
  assert.equal((await A.page.textContent('#cta')).trim(), 'Nöbet Değişikliği Bildir');
  assert.equal(await A.page.isHidden('#demo-note'), true, 'bulut modunda demo uyarısı olmamalı');
  step('Ana sayfada "Nöbet Değişikliği Bildir" düğmesi var, durum "Canlı", demo uyarısı yok');
  await A.page.screenshot({ path: `${OUT}/01-home-empty.png` });

  await A.page.click('#cta');
  await A.page.waitForSelector('#sheet-root:not([hidden])');
  assert.equal(await A.page.inputValue('#f-name'), '', 'ad alanı kendiliğinden dolmamalı');
  assert.equal(await A.page.evaluate(() => localStorage.getItem('nobet.v1.ad')), null, 'eski kayıtlı ad silinmeli');
  await A.page.click('#btn-submit');
  assert.ok((await A.page.textContent('#e-name')).length > 0 && (await A.page.textContent('#e-other')).length > 0);
  await A.page.fill('#f-name', 'Ayşe Yılmaz');
  await A.page.fill('#f-other', 'ayşe yılmaz');
  await A.page.click('#btn-submit');
  assert.match(await A.page.textContent('#e-other'), /Kendinizle/);
  await A.page.fill('#f-date', '2999-01-01');
  await A.page.fill('#f-other', 'Mehmet Demir');
  await A.page.click('#btn-submit');
  assert.match(await A.page.textContent('#e-date'), /Geçerli bir tarih/);
  assert.match(await A.page.textContent('#e-date2'), /karşı tarafın nöbet tarihini/);
  assert.equal(db.ctl.posts, 0, 'geçersiz formda sunucuya istek gitmemeli');
  step('Boş / aynı kişi / aralık dışı tarih / eksik ikinci tarih doğrulaması çalışıyor, sunucuya istek gitmiyor');

  const d1 = plus(2), e1 = plus(6);
  await A.page.fill('#f-date', iso(d1));
  await A.page.fill('#f-date2', iso(e1));
  assert.equal(await A.page.textContent('#preview'), sentence('Ayşe Yılmaz', 'Mehmet Demir', d1, e1));
  await A.page.screenshot({ path: `${OUT}/02-form-filled.png` });
  await A.page.click('#btn-submit');
  await A.page.waitForSelector('#sheet-root', { state: 'hidden' });
  assert.match(A.page.url(), /#\/degisiklikler$/);
  assert.deepEqual(await cardTexts(A.page), [sentence('Ayşe Yılmaz', 'Mehmet Demir', d1, e1)]);
  assert.equal(JSON.stringify(Object.keys([...db.store.values()][0]).sort()), JSON.stringify(['karsi', 'karsiTarih', 'olusturan', 'tarih', 'ts']));
  await A.page.locator('#btn-add:visible').click();
  await A.page.waitForSelector('#sheet-root:not([hidden])');
  assert.equal(await A.page.inputValue('#f-name'), '', 'gönderdikten sonra ad hatırlanmamalı');
  await A.page.keyboard.press('Escape');
  await A.page.waitForSelector('#sheet-root', { state: 'hidden' });
  step('Önizleme istenen cümleyi (iki tarihli) üretiyor; gönderince "Nöbet Değişiklikleri" sekmesinde aynı cümle görünüyor');
  await A.page.screenshot({ path: `${OUT}/03-list-one.png` });

  await B.page.goto(APP + '/#/degisiklikler');
  await B.page.waitForSelector('#feed .swap');
  assert.deepEqual(await cardTexts(B.page), [sentence('Ayşe Yılmaz', 'Mehmet Demir', d1, e1)]);
  step('Hiç girmemiş başka bir telefon (B) linke tıklayınca A\'nın bildirimini görüyor');

  const d2 = plus(5), e2 = plus(8);
  await report(B.page, 'Can Öztürk', 'Zeynep Kaya', d2, e2);
  await B.page.waitForSelector('#sheet-root', { state: 'hidden' });
  await A.page.reload();
  await A.page.waitForSelector('#feed .swap');
  assert.deepEqual(await cardTexts(A.page), [
    sentence('Can Öztürk', 'Zeynep Kaya', d2, e2),
    sentence('Ayşe Yılmaz', 'Mehmet Demir', d1, e1)
  ]);
  step('A sayfayı yenileyince B\'nin kaydı da var; sıralama en yeniden eskiye; kayıtlar kalıcı');

  const d3 = plus(9), e3 = plus(12);
  await report(B.page, 'Elif Şahin', 'Burak Arslan', d3, e3);
  await B.page.waitForSelector('#sheet-root', { state: 'hidden' });
  await A.page.waitForFunction(() => document.querySelectorAll('#feed .swap').length === 3, null, { timeout: 12000 });
  assert.equal((await cardTexts(A.page))[0], sentence('Elif Şahin', 'Burak Arslan', d3, e3));
  step('A, sayfayı yenilemeden (otomatik yoklama ile) B\'nin yeni kaydını görüyor');

  db.ctl.failPost = true;
  await report(A.page, 'Ayşe Yılmaz', 'Hakan Çelik', plus(1), plus(4));
  await A.page.waitForFunction(() => document.getElementById('e-form').textContent.length > 0);
  assert.equal(await A.page.isVisible('#sheet-root'), true, 'hata olunca form açık kalmalı');
  assert.equal((await cardTexts(A.page)).length, 3);
  db.ctl.failPost = false;
  // Tarayıcı, bilerek verdirdiğimiz 500 yanıtını konsola yazar: bu tek kaydı beklenen say.
  const expected500 = A.errors.findIndex((m) => /status of 500/.test(m));
  assert.ok(expected500 >= 0, 'sahte 500 hatası konsola düşmedi');
  A.errors.splice(expected500, 1);
  await A.page.click('#btn-submit');
  await A.page.waitForSelector('#sheet-root', { state: 'hidden' });
  assert.equal((await cardTexts(A.page)).length, 4);
  step('Sunucu hatasında form açık kalıyor, veri kaybolmuyor; düzelince tekrar gönderilebiliyor');

  const xss = '<img src=x onerror="window.__xss=1">';
  await report(A.page, xss, 'Zeynep Kaya', plus(3), plus(5));
  await A.page.waitForSelector('#sheet-root', { state: 'hidden' });
  assert.equal(await A.page.evaluate(() => window.__xss), undefined);
  assert.ok((await cardTexts(A.page))[0].includes(xss));
  step('HTML içeren isim metin olarak gösteriliyor (XSS yok)');

  // Silme: linke giren herkes (burada B) başkasının bildirimini silebilir.
  const count = (P) => P.page.$$eval('#feed .swap', (n) => n.length);
  await B.page.waitForFunction(() => document.querySelectorAll('#feed .swap').length === 5, null, { timeout: 12000 });
  B.page.once('dialog', (d) => d.dismiss());
  await B.page.locator('#feed .swap .swap-del').first().click();
  assert.equal(await count(B), 5);
  assert.equal(db.ctl.deletes, 0, 'onay verilmeyince sunucuya istek gitmemeli');
  step('Silme düğmesi onay soruyor; vazgeçilince hiçbir şey silinmiyor');

  B.page.once('dialog', (d) => d.accept());
  await B.page.locator('#feed .swap', { hasText: 'Elif Şahin' }).locator('.swap-del').click();
  await B.page.waitForFunction(() => document.querySelectorAll('#feed .swap').length === 4);
  assert.match(await B.page.textContent('#toast'), /silindi/);
  assert.equal(db.store.size, 4);
  await A.page.waitForFunction(() => document.querySelectorAll('#feed .swap').length === 4, null, { timeout: 12000 });
  assert.ok(!(await cardTexts(A.page)).some((t) => t.includes('Elif Şahin')));
  step('Onaylayınca bildirim silinir; veritabanından kalkar, A de yenilemeden kaybolduğunu görür');

  db.ctl.failDelete = true;
  B.page.once('dialog', (d) => d.accept());
  await B.page.locator('#feed .swap', { hasText: 'Can Öztürk' }).locator('.swap-del').click();
  await B.page.waitForFunction(() => document.getElementById('toast').classList.contains('is-error'));
  assert.equal(await count(B), 4);
  assert.equal(await B.page.locator('#feed .swap', { hasText: 'Can Öztürk' }).locator('.swap-del').isEnabled(), true);
  db.ctl.failDelete = false;
  const expectedDel500 = B.errors.findIndex((m) => /status of 500/.test(m));
  assert.ok(expectedDel500 >= 0, 'sahte 500 hatası konsola düşmedi');
  B.errors.splice(expectedDel500, 1);
  step('Silme sunucuda başarısız olursa hata gösterilir, kayıt listede kalır, düğme yeniden kullanılabilir');

  await A.ctx.close(); await B.ctx.close();

  console.log('\n[2] Demo modu (veritabanı adresi yok)');
  const L1 = await newPhone(browser, APP, null);
  const L2 = await newPhone(browser, APP, null);
  allErrors.push(L1.errors, L2.errors);
  await L1.page.goto(APP + '/');
  await L1.page.waitForFunction(() => document.getElementById('sync').dataset.state === 'local');
  assert.equal(await L1.page.isVisible('#demo-note'), true);
  await report(L1.page, 'Ayşe Yılmaz', 'Mehmet Demir', plus(1), plus(2));
  await L1.page.waitForSelector('#sheet-root', { state: 'hidden' });
  assert.match(await L1.page.textContent('#toast'), /yalnızca bu cihaza/);
  await L1.page.reload();
  await L1.page.goto(APP + '/#/degisiklikler');
  await L1.page.waitForSelector('#feed .swap');
  assert.equal((await cardTexts(L1.page)).length, 1);
  await L2.page.goto(APP + '/#/degisiklikler');
  await L2.page.waitForSelector('#feed .state');
  assert.equal((await cardTexts(L2.page)).length, 0);
  step('Demo modu uyarıyor; kayıt yalnızca o cihazda kalıyor (ortak liste için veritabanı gerekir)');
  await L1.ctx.close(); await L2.ctx.close();

  console.log('\n[2b] Bildirim aboneliği (Web Push taklit edilir)');
  const vapid = Buffer.alloc(65, 4).toString('base64url');   // 65 bayt = 87 karakter, gerçek anahtar biçimi
  const N = await newPhone(browser, APP, db.url, { vapid, pushStub: { permission: 'default' } });
  allErrors.push(N.errors);
  await N.page.goto(APP + '/');
  await N.page.waitForSelector('#push-box:not([hidden])');
  assert.equal(await N.page.getAttribute('#push-box', 'data-state'), 'off');
  assert.equal((await N.page.textContent('#push-btn')).trim(), 'Bildirimleri aç');
  await N.page.screenshot({ path: `${OUT}/05-push-off.png` });
  await N.page.click('#push-btn');
  await N.page.waitForFunction(() => document.getElementById('push-box').dataset.state === 'on');
  assert.equal(db.subs.size, 1);
  const rec = [...db.subs.values()][0];
  assert.deepEqual(Object.keys(rec).sort(), ['endpoint', 'keys', 'ts']);
  assert.equal(rec.endpoint, 'https://fcm.googleapis.com/fcm/send/e2e-test-endpoint');
  const used = await N.page.evaluate(() => ({ uvo: window.__push.opts.userVisibleOnly, len: window.__push.opts.applicationServerKey.length }));
  assert.deepEqual(used, { uvo: true, len: 65 });
  await N.page.screenshot({ path: `${OUT}/06-push-on.png` });
  step('"Bildirimleri aç": izin istenir, abonelik alınır ve (adres + anahtarlar) veritabanına yazılır');

  await N.page.click('#push-btn');      // kapat
  await N.page.waitForFunction(() => document.getElementById('push-box').dataset.state === 'off');
  assert.equal(await N.page.evaluate(() => window.__push.sub), null);
  await N.page.click('#push-btn');      // yeniden aç: kayıt zaten var (401) ama sorun değil
  await N.page.waitForFunction(() => document.getElementById('push-box').dataset.state === 'on');
  assert.equal(db.subs.size, 1, 'aynı cihaz iki kayıt oluşturmamalı');
  const exists401 = N.errors.findIndex((m) => /status of 401/.test(m));   // kayıt zaten var: kurallar 401 döner, uygulama bunu kabul eder
  assert.ok(exists401 >= 0, 'var olan aboneliğe yazma 401 vermeliydi');
  N.errors.splice(exists401, 1);
  step('Kapatıp yeniden açınca aynı cihaz ikinci kayıt oluşturmuyor');

  await N.page.reload();
  await N.page.waitForSelector('#push-box:not([hidden])');
  assert.equal(await N.page.getAttribute('#push-box', 'data-state'), 'on', 'sayfa yenilenince açık durumu korunmalı');
  step('Sayfa yenilenince "Bildirimler açık" durumu korunuyor');
  await N.ctx.close();

  const D = await newPhone(browser, APP, db.url, { vapid, pushStub: { permission: 'default' } });
  allErrors.push(D.errors);
  db.ctl.denySubs = true;       // kurallar yayınlanmamış gibi
  await D.page.goto(APP + '/');
  await D.page.waitForSelector('#push-box:not([hidden])');
  await D.page.click('#push-btn');
  await D.page.waitForFunction(() => document.getElementById('toast').classList.contains('is-error'));
  assert.match(await D.page.textContent('#toast'), /kuralları güncel değil/);
  assert.equal(await D.page.getAttribute('#push-box', 'data-state'), 'off');
  assert.equal(await D.page.evaluate(() => window.__push.sub), null, 'kayıt yazılamadıysa abonelik geri alınmalı');
  db.ctl.denySubs = false;
  for (let i = D.errors.findIndex((m) => /status of 401/.test(m)); i >= 0; i = D.errors.findIndex((m) => /status of 401/.test(m))) D.errors.splice(i, 1);   // bilerek verdirdiğimiz 401'ler konsola düşer
  step('Veritabanı kaydı reddederse hata gösterilir, abonelik geri alınır, "açık" görünmez');
  await D.ctx.close();

  const X = await newPhone(browser, APP, db.url, { vapid, pushStub: { permission: 'denied' } });
  allErrors.push(X.errors);
  await X.page.goto(APP + '/');
  await X.page.waitForSelector('#push-box:not([hidden])');
  assert.equal(await X.page.getAttribute('#push-box', 'data-state'), 'denied');
  assert.equal(await X.page.isHidden('#push-btn'), true);
  await X.ctx.close();

  const IOS = await newPhone(browser, APP, db.url, {
    vapid, pushStub: { noPushManager: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  allErrors.push(IOS.errors);
  await IOS.page.goto(APP + '/');
  await IOS.page.waitForSelector('#push-box:not([hidden])');
  assert.equal(await IOS.page.getAttribute('#push-box', 'data-state'), 'ios');
  assert.match(await IOS.page.textContent('#push-text'), /Ana Ekrana Ekle/);
  await IOS.ctx.close();

  const DM = await newPhone(browser, APP, null, { vapid, pushStub: { permission: 'default' } });
  allErrors.push(DM.errors);
  await DM.page.goto(APP + '/');
  await DM.page.waitForFunction(() => document.getElementById('sync').dataset.state === 'local');
  assert.equal(await DM.page.isHidden('#push-box'), true, 'demo modunda bildirim kutusu görünmemeli');
  await DM.ctx.close();
  step('İzin engelliyse yönerge, iPhone\'da (ana ekrana eklenmemiş) "Ana Ekrana Ekle" yönergesi var; demo modunda kutu gizli');

  console.log('\n[3] Cihaz boyutları, koyu mod, ekran görüntüleri');
  // Sahte veritabanını farklı günlere yayılmış örnek kayıtlarla doldur.
  const now = Date.now();
  const sample = [
    ['Ayşe Yılmaz', 'Mehmet Demir', 2, 5 * 60e3], ['Can Öztürk', 'Zeynep Kaya', 5, 52 * 60e3],
    ['Elif Şahin', 'Burak Arslan', 9, 3 * 3600e3], ['Selin Aydın', 'Murat Koç', 1, 26 * 3600e3],
    ['Dr. Hakan Çelik Uzunisimli', 'Prof. Dr. Gülşen Karaküçükoğlu', 14, 3 * 86400e3]
  ];
  sample.forEach(([a, b, dd, ago], i) => db.seed({ olusturan: a, karsi: b, tarih: iso(plus(dd)), ...(i === 3 ? {} : { karsiTarih: iso(plus(dd + 3)) }), ts: now - ago }));

  const devices = [
    ['galaxy-fold-280', { width: 280, height: 653 }], ['iphone-se1-320', { width: 320, height: 568 }],
    ['iphone-se-375', { width: 375, height: 667 }], ['iphone-14-390', { width: 390, height: 844 }],
    ['pixel-7-412', { width: 412, height: 915 }], ['iphone-pro-max-430', { width: 430, height: 932 }],
    ['phone-landscape-667', { width: 667, height: 375 }], ['tablet-768', { width: 768, height: 1024 }]
  ];
  for (const [name, viewport] of devices) {
    const P = await newPhone(browser, APP, db.url, { viewport });
    allErrors.push(P.errors);
    await P.page.goto(APP + '/');
    await P.page.waitForSelector('#recent .swap');
    await settle(P.page);
    assert.deepEqual(await overflowing(P.page, viewport.width), [], `${name}: ana sayfada taşma`);
    const ctaH = await P.page.$eval('#cta', (n) => n.getBoundingClientRect().height);
    assert.ok(ctaH >= 44, `${name}: düğme çok küçük`);
    await P.page.screenshot({ path: `${OUT}/home-${name}.png` });

    await P.page.click('#tab-list');
    await P.page.waitForSelector('#feed .swap');
    await settle(P.page);
    assert.deepEqual(await overflowing(P.page, viewport.width), [], `${name}: listede taşma`);
    const tabH = await P.page.$$eval('.tab', (n) => n.map((x) => x.getBoundingClientRect().height));
    assert.ok(tabH.every((h) => h >= 44), `${name}: sekme yüksekliği yetersiz`);
    await P.page.screenshot({ path: `${OUT}/list-${name}.png` });
    assert.ok((await cardTexts(P.page)).includes(legacySentence('Selin Aydın', 'Murat Koç', plus(1))), `${name}: eski (tek tarihli) kayıt eski cümleyle gösterilmeli`);
    const delSizes = await P.page.$$eval('.swap-del', (n) => n.map((x) => { const r = x.getBoundingClientRect(); return Math.min(r.width, r.height); }));
    assert.ok(delSizes.length > 0 && delSizes.every((s) => s >= 44), `${name}: silme düğmesi çok küçük`);

    await P.page.click('#btn-add');
    await P.page.waitForSelector('#sheet-root:not([hidden])');
    await settle(P.page);
    assert.deepEqual(await overflowing(P.page, viewport.width), [], `${name}: formda taşma`);
    const sheetOk = await P.page.$eval('#sheet', (n) => { const r = n.getBoundingClientRect(); return r.top >= -1 && r.bottom <= innerHeight + 1; });
    assert.ok(sheetOk, `${name}: form ekran dışına taşıyor`);
    const reachable = await P.page.$eval('#btn-submit', (n) => { n.scrollIntoView(); const r = n.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0; });
    assert.ok(reachable, `${name}: "Bildir" düğmesine ulaşılamıyor`);
    await P.page.screenshot({ path: `${OUT}/form-${name}.png` });
    await P.ctx.close();
  }
  step(`${devices.length} cihaz boyutunda taşma yok, dokunma hedefleri ≥44px, form ve düğmeye ulaşılıyor`);

  const dark = await newPhone(browser, APP, db.url, { colorScheme: 'dark' });
  allErrors.push(dark.errors);
  await dark.page.goto(APP + '/');
  await dark.page.waitForSelector('#recent .swap');
  await settle(dark.page);
  await dark.page.screenshot({ path: `${OUT}/dark-home.png` });
  await dark.page.click('#tab-list');
  await dark.page.waitForSelector('#feed .swap');
  await settle(dark.page);
  await dark.page.screenshot({ path: `${OUT}/dark-list.png` });
  await dark.ctx.close();
  step('Koyu modda sayfalar açılıyor');

  console.log('\n[4] Çevrimdışı açılış (servis çalışanı)');
  const swCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'tr-TR' });
  await forceConfig(swCtx, null);
  const swPage = await swCtx.newPage();
  const swErrors = [];
  track(swPage, swErrors);
  await swPage.goto(APP + '/');
  await swPage.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await swPage.reload(); // sayfa artık servis çalışanı tarafından denetleniyor
  await swPage.waitForFunction(() => !!navigator.serviceWorker.controller);
  await swCtx.setOffline(true);
  await swPage.reload();
  assert.equal((await swPage.textContent('#cta')).trim(), 'Nöbet Değişikliği Bildir');
  assert.equal(await swPage.isVisible('.tabbar'), true);
  await swCtx.setOffline(false);
  await swCtx.close();
  step('İnternet kesikken uygulama kabuğu önbellekten açılıyor');
  assert.deepEqual(swErrors.filter((m) => !/Failed to load resource|net::ERR/.test(m)), []);

  const flat = allErrors.flat();
  assert.deepEqual(flat, [], 'konsol / sayfa hataları: ' + flat.join(' | '));
  step('Hiçbir testte konsol veya sayfa hatası yok');
  console.log(`\n${passed} adım başarılı. Ekran görüntüleri: ${OUT}\n`);
} catch (e) {
  console.error('\n✗ BAŞARISIZ:', e.message);
  console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  staticSrv.close(); db.server.close();
}
