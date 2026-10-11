/**
 * Uçtan uca test (Chromium). Çalıştırma:  node test/e2e.mjs
 *
 * - Uygulamayı yerel bir statik sunucudan açar.
 * - Firebase Realtime Database REST sözleşmesini taklit eden küçük bir sahte
 *   sunucu başlatır (POST ile ekleme, orderBy/limitToLast ile okuma, ".sv" saat).
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
  const ctl = { failPost: false, posts: 0 };
  let counter = 0;
  const pushId = () => '-N' + Date.now().toString(36).padStart(9, '0') + String(counter++).padStart(4, '0');
  const cors = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type', 'Cache-Control': 'no-cache'
  };
  const valid = (v) => v && typeof v === 'object'
    && Object.keys(v).sort().join() === 'karsi,olusturan,tarih,ts'
    && [v.olusturan, v.karsi].every((s) => typeof s === 'string' && s.length >= 2 && s.length <= 40)
    && /^\d{4}-\d{2}-\d{2}$/.test(v.tarih) && typeof v.ts === 'number';

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
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
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}`, store, ctl, seed })));
}

/* ----------------------------------------------------------- yardımcılar */
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const trLong = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${DAYS[d.getDay()]}`;
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const sentence = (a, b, d) => `Ben ${a}, ${b} ile ${trLong(d)} tarihli olan nöbetimi değiştirdim.`;

let passed = 0;
const step = (name) => console.log(`  ✓ ${name}`) || passed++;

function track(page, errors) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
}

// Depodaki config.js gerçek veritabanı adresini taşır; testler hermetik kalsın diye her zaman üzerine yazılır.
// dbUrl yoksa demo modu (databaseUrl: '') zorlanır.
const forceConfig = (ctx, dbUrl) => ctx.route('**/config.js', (route) => route.fulfill({
  contentType: 'text/javascript',
  body: `window.NOBET_CONFIG = { databaseUrl: ${JSON.stringify(dbUrl || '')}, path: 'nobetler', limit: 500, pollSeconds: 5 };`
}));

async function newPhone(browser, appUrl, dbUrl, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    colorScheme: opts.colorScheme || 'light', locale: 'tr-TR', serviceWorkers: 'block'
  });
  await forceConfig(ctx, dbUrl);
  const page = await ctx.newPage();
  const errors = [];
  track(page, errors);
  return { ctx, page, errors, appUrl };
}

async function report(page, a, b, date) {
  await page.locator('#cta:visible, #btn-add:visible').first().click(); // sekmeye göre hangisi görünürse
  await page.waitForSelector('#sheet-root:not([hidden])');
  await page.fill('#f-name', a);
  await page.fill('#f-other', b);
  await page.fill('#f-date', iso(date));
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

  await A.page.goto(APP + '/');
  await A.page.waitForFunction(() => document.getElementById('sync').dataset.state === 'live');
  assert.equal((await A.page.textContent('#cta')).trim(), 'Nöbet Değişikliği Bildir');
  assert.equal(await A.page.isHidden('#demo-note'), true, 'bulut modunda demo uyarısı olmamalı');
  step('Ana sayfada "Nöbet Değişikliği Bildir" düğmesi var, durum "Canlı", demo uyarısı yok');
  await A.page.screenshot({ path: `${OUT}/01-home-empty.png` });

  await A.page.click('#cta');
  await A.page.waitForSelector('#sheet-root:not([hidden])');
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
  assert.equal(db.ctl.posts, 0, 'geçersiz formda sunucuya istek gitmemeli');
  step('Boş / aynı kişi / aralık dışı tarih doğrulaması çalışıyor, sunucuya istek gitmiyor');

  const d1 = plus(2);
  await A.page.fill('#f-date', iso(d1));
  assert.equal(await A.page.textContent('#preview'), sentence('Ayşe Yılmaz', 'Mehmet Demir', d1));
  await A.page.screenshot({ path: `${OUT}/02-form-filled.png` });
  await A.page.click('#btn-submit');
  await A.page.waitForSelector('#sheet-root', { state: 'hidden' });
  assert.match(A.page.url(), /#\/degisiklikler$/);
  assert.deepEqual(await cardTexts(A.page), [sentence('Ayşe Yılmaz', 'Mehmet Demir', d1)]);
  step('Önizleme istenen cümleyi üretiyor; gönderince "Nöbet Değişiklikleri" sekmesinde aynı cümle görünüyor');
  await A.page.screenshot({ path: `${OUT}/03-list-one.png` });

  await B.page.goto(APP + '/#/degisiklikler');
  await B.page.waitForSelector('#feed .swap');
  assert.deepEqual(await cardTexts(B.page), [sentence('Ayşe Yılmaz', 'Mehmet Demir', d1)]);
  step('Hiç girmemiş başka bir telefon (B) linke tıklayınca A\'nın bildirimini görüyor');

  const d2 = plus(5);
  await report(B.page, 'Can Öztürk', 'Zeynep Kaya', d2);
  await B.page.waitForSelector('#sheet-root', { state: 'hidden' });
  await A.page.reload();
  await A.page.waitForSelector('#feed .swap');
  assert.deepEqual(await cardTexts(A.page), [
    sentence('Can Öztürk', 'Zeynep Kaya', d2),
    sentence('Ayşe Yılmaz', 'Mehmet Demir', d1)
  ]);
  step('A sayfayı yenileyince B\'nin kaydı da var; sıralama en yeniden eskiye; kayıtlar kalıcı');

  const d3 = plus(9);
  await report(B.page, 'Elif Şahin', 'Burak Arslan', d3);
  await B.page.waitForSelector('#sheet-root', { state: 'hidden' });
  await A.page.waitForFunction(() => document.querySelectorAll('#feed .swap').length === 3, null, { timeout: 12000 });
  assert.equal((await cardTexts(A.page))[0], sentence('Elif Şahin', 'Burak Arslan', d3));
  step('A, sayfayı yenilemeden (otomatik yoklama ile) B\'nin yeni kaydını görüyor');

  db.ctl.failPost = true;
  await report(A.page, 'Ayşe Yılmaz', 'Hakan Çelik', plus(1));
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
  await report(A.page, xss, 'Zeynep Kaya', plus(3));
  await A.page.waitForSelector('#sheet-root', { state: 'hidden' });
  assert.equal(await A.page.evaluate(() => window.__xss), undefined);
  assert.ok((await cardTexts(A.page))[0].includes(xss));
  step('HTML içeren isim metin olarak gösteriliyor (XSS yok)');

  await A.ctx.close(); await B.ctx.close();

  console.log('\n[2] Demo modu (veritabanı adresi yok)');
  const L1 = await newPhone(browser, APP, null);
  const L2 = await newPhone(browser, APP, null);
  allErrors.push(L1.errors, L2.errors);
  await L1.page.goto(APP + '/');
  await L1.page.waitForFunction(() => document.getElementById('sync').dataset.state === 'local');
  assert.equal(await L1.page.isVisible('#demo-note'), true);
  await report(L1.page, 'Ayşe Yılmaz', 'Mehmet Demir', plus(1));
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

  console.log('\n[3] Cihaz boyutları, koyu mod, ekran görüntüleri');
  // Sahte veritabanını farklı günlere yayılmış örnek kayıtlarla doldur.
  const now = Date.now();
  const sample = [
    ['Ayşe Yılmaz', 'Mehmet Demir', 2, 5 * 60e3], ['Can Öztürk', 'Zeynep Kaya', 5, 52 * 60e3],
    ['Elif Şahin', 'Burak Arslan', 9, 3 * 3600e3], ['Selin Aydın', 'Murat Koç', 1, 26 * 3600e3],
    ['Dr. Hakan Çelik Uzunisimli', 'Prof. Dr. Gülşen Karaküçükoğlu', 14, 3 * 86400e3]
  ];
  for (const [a, b, dd, ago] of sample) db.seed({ olusturan: a, karsi: b, tarih: iso(plus(dd)), ts: now - ago });

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
