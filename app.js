/*
 * Nöbet Değişim — arayüz mantığı
 *
 * Sayfalar (hash yönlendirme): #/ana · #/degisiklikler
 * Kullanıcı verisi DOM'a asla innerHTML ile yazılmaz; yalnızca textContent.
 * Geniş cihaz desteği için bilinçli olarak ES5 sözdizimi kullanılır.
 */
(function () {
  'use strict';

  var cfg = window.NOBET_CONFIG || {};
  var Store = window.NobetStore;
  var store = Store.create(cfg);
  var clean = Store.clean;

  var PAGE_SIZE = 40;
  var LIMIT = Number(cfg.limit) || 500;
  var POLL_MS = Math.max(5, Number(cfg.pollSeconds) || 20) * 1000;
  var NAME_KEY = 'nobet.v1.ad';
  var DAY_MS = 86400000;

  var MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  var MONTHS_SHORT = ['OCA', 'ŞUB', 'MAR', 'NİS', 'MAY', 'HAZ', 'TEM', 'AĞU', 'EYL', 'EKİ', 'KAS', 'ARA'];
  var DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  var DAYS_SHORT = ['PZR', 'PZT', 'SAL', 'ÇAR', 'PER', 'CUM', 'CMT'];

  // Nöbet tarihi kutusunun rengi haftanın gününe göre değişir (Pazar … Cumartesi).
  var DATE_GRADS = [
    ['#f43f5e', '#fb923c'], ['#6366f1', '#8b5cf6'], ['#0ea5e9', '#6366f1'], ['#10b981', '#06b6d4'],
    ['#f59e0b', '#f97316'], ['#ec4899', '#a855f7'], ['#8b5cf6', '#ec4899']
  ];
  // Avatar renkleri isme göre sabit seçilir.
  var AVATAR_GRADS = [
    ['#6366f1', '#8b5cf6'], ['#ec4899', '#f43f5e'], ['#f59e0b', '#f97316'], ['#10b981', '#14b8a6'],
    ['#0ea5e9', '#6366f1'], ['#a855f7', '#ec4899'], ['#22c55e', '#84cc16'], ['#06b6d4', '#3b82f6']
  ];

  var STATUS_TEXT = { loading: 'Bağlanıyor…', live: 'Canlı', local: 'Demo modu', offline: 'Bağlantı yok' };

  /* ------------------------------------------------------------- yardımcılar */

  function $(id) { return document.getElementById(id); }

  function upper(s) { try { return s.toLocaleUpperCase('tr-TR'); } catch (e) { return s.toUpperCase(); } }
  function lower(s) { try { return s.toLocaleLowerCase('tr-TR'); } catch (e) { return s.toLowerCase(); } }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function startOfDay(ts) { var d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

  // 'YYYY-AA-GG' -> yerel Date (saat dilimi kayması olmaz); geçersizse null.
  function parseISO(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    var y = +m[1], mo = +m[2] - 1, da = +m[3];
    var d = new Date(y, mo, da);
    if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== da) return null;
    return d;
  }

  function longDate(d) { return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ' ' + DAYS[d.getDay()]; }

  function dayLabel(ts) {
    var diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
    if (diff === 0) return 'Bugün';
    if (diff === 1) return 'Dün';
    return longDate(new Date(ts));
  }

  function clock(ts) { var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function timeLabel(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return 'az önce';
    var dayDiff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
    if (dayDiff === 0) {
      var min = Math.floor(diff / 60000);
      return min < 60 ? min + ' dk önce' : Math.floor(min / 60) + ' sa önce';
    }
    if (dayDiff === 1) return 'Dün ' + clock(ts);
    var d = new Date(ts);
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + clock(ts);
  }

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function initials(name) {
    var parts = clean(name).split(' ');
    var first = parts[0].charAt(0);
    var second = parts.length > 1 ? parts[parts.length - 1].charAt(0) : parts[0].charAt(1);
    return upper(first + second) || '?';
  }

  function icon(name) {
    return '<svg class="ico" aria-hidden="true"><use href="#i-' + name + '" xlink:href="#i-' + name + '"/></svg>';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ----------------------------------------------------------------- durum */

  var state = {
    records: [],
    status: 'loading',   // loading | ready | error
    error: '',
    shown: PAGE_SIZE,
    seq: 0,
    loading: false,
    sending: false,
    highlight: null,
    seen: {},
    sig: '',
    names: ''
  };

  var els = {
    main: $('main'), viewHome: $('view-home'), viewList: $('view-list'),
    tabHome: $('tab-home'), tabList: $('tab-list'),
    sync: $('sync'), syncText: $('sync-text'), demo: $('demo-note'),
    recent: $('recent'), feed: $('feed'), more: $('btn-more'), sub: $('list-sub'),
    statToday: $('stat-today'), statWeek: $('stat-week'), statTotal: $('stat-total'),
    btnRefresh: $('btn-refresh'), fab: $('fab-wrap'), toast: $('toast'), names: $('names'),
    sheetRoot: $('sheet-root'), sheet: $('sheet')
  };

  var f = {
    form: $('swap-form'), name: $('f-name'), other: $('f-other'), date: $('f-date'), date2: $('f-date2'),
    preview: $('preview'), eName: $('e-name'), eOther: $('e-other'), eDate: $('e-date'), eDate2: $('e-date2'), eForm: $('e-form'),
    submit: $('btn-submit'), submitText: $('btn-submit-text')
  };

  /* --------------------------------------------------------------- mesaj */

  function part(cls, text, placeholder) {
    if (text) return el('b', cls, text);
    return el('span', 'ph', placeholder);
  }

  // "Ben X, 15 Ekim 2026 Perşembe tarihli nöbetimle, 20 Ekim 2026 Salı tarihli Y adlı kişinin nöbetini değiştirdim."
  // legacy: ikinci tarih alanından önce kaydedilmiş eski kayıtlar için eski cümle.
  function fillMessage(node, a, b, d, d2, legacy) {
    function text(s) { node.appendChild(document.createTextNode(s)); }
    node.textContent = '';
    text('Ben ');
    node.appendChild(part('n', a, 'adınız'));
    if (legacy) {
      text(', ');
      node.appendChild(part('n', b, 'değiştirdiğiniz kişi'));
      text(' ile ');
      node.appendChild(part('d', d ? longDate(d) : '', 'tarih'));
      text(' tarihli olan nöbetimi değiştirdim.');
      return;
    }
    text(', ');
    node.appendChild(part('d', d ? longDate(d) : '', 'tarih'));
    text(' tarihli nöbetimle, ');
    node.appendChild(part('d', d2 ? longDate(d2) : '', 'tarih'));
    text(' tarihli ');
    node.appendChild(part('n', b, 'değiştirdiğiniz kişi'));
    text(' adlı kişinin nöbetini değiştirdim.');
  }

  /* ------------------------------------------------------------ çizim */

  function avatar(name) {
    var g = AVATAR_GRADS[hash(lower(name)) % AVATAR_GRADS.length];
    var a = el('span', 'avatar', initials(name));
    a.style.setProperty('--a1', g[0]);
    a.style.setProperty('--a2', g[1]);
    a.setAttribute('title', name);
    return a;
  }

  function buildCard(r, deletable) {
    var d = parseISO(r.tarih);
    var li = el('li', 'swap');
    li.setAttribute('data-id', r.id);
    if (!state.seen[r.id]) li.className += ' enter';
    if (r.id === state.highlight) li.className += ' is-new';

    var g = DATE_GRADS[d.getDay()];
    li.style.setProperty('--g1', g[0]);
    li.style.setProperty('--g2', g[1]);

    var tile = el('div', 'swap-date');
    tile.setAttribute('aria-hidden', 'true');
    tile.appendChild(el('span', 'dow', DAYS_SHORT[d.getDay()]));
    tile.appendChild(el('span', 'day', String(d.getDate())));
    tile.appendChild(el('span', 'mon', MONTHS_SHORT[d.getMonth()]));
    li.appendChild(tile);

    var main = el('div', 'swap-main');
    var text = el('p', 'swap-text');
    fillMessage(text, r.olusturan, r.karsi, d, parseISO(r.karsiTarih), !r.karsiTarih);
    main.appendChild(text);

    var meta = el('div', 'swap-meta');
    var pair = el('span', 'avatars');
    pair.appendChild(avatar(r.olusturan));
    var arrows = el('span');
    arrows.innerHTML = icon('swap');
    pair.appendChild(arrows.firstChild);
    pair.appendChild(avatar(r.karsi));
    meta.appendChild(pair);

    var t = el('time', null, timeLabel(r.ts));
    t.setAttribute('datetime', new Date(r.ts).toISOString());
    t.setAttribute('data-ts', String(r.ts));
    t.setAttribute('title', longDate(new Date(r.ts)) + ' ' + clock(r.ts));
    meta.appendChild(t);

    if (deletable) {
      var del = el('button', 'swap-del');
      del.type = 'button';
      del.innerHTML = icon('trash');
      del.setAttribute('aria-label', 'Bu bildirimi sil');
      del.setAttribute('title', 'Sil');
      del.addEventListener('click', function () { onDelete(r, del); });
      meta.appendChild(del);
    }

    main.appendChild(meta);
    li.appendChild(main);
    return li;
  }

  // Linke giren herkes silebilir; onay istenir, silinen kayıt herkesin listesinden kalkar.
  function onDelete(r, btn) {
    if (!window.confirm('Bu bildirim silinsin mi?\n\nHerkesin listesinden kalkar, geri alınamaz.')) return;
    btn.disabled = true;
    store.remove(r.id).then(function () {
      state.records = state.records.filter(function (x) { return x.id !== r.id; });
      render();
      toast('Bildirim silindi.');
      refresh(); // sunucudaki gerçek listeyle eşitle
    }, function (err) {
      btn.disabled = false;
      toast(err && err.message ? err.message : 'Bildirim silinemedi. Lütfen tekrar deneyin.', true);
    });
  }

  /* ------------------------------------------------- bildirim (Web Push) */

  // Yeni kayıtta bildirimi GitHub Actions gönderir (.github/workflows/bildirim.yml); burada yalnızca abonelik alınır.
  var push = { box: $('push-box'), text: $('push-text'), btn: $('push-btn') };

  function pushKey() {
    var s = cfg.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(s + '===='.slice(0, (4 - s.length % 4) % 4));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  var PUSH_UI = {
    off: ['Yeni nöbet değişikliği olunca telefonuna bildirim gelsin.', 'Bildirimleri aç'],
    on: ['Bildirimler açık: yeni nöbet değişikliklerinde bu cihaza bildirim gelir.', 'Kapat'],
    denied: ['Bildirim izni engellenmiş. Telefonun veya tarayıcının ayarlarından bu site için izin verin.', ''],
    ios: ['iPhone\'da bildirim için önce Paylaş düğmesinden “Ana Ekrana Ekle”yi seçin, sonra uygulamayı ana ekrandan açın.', '']
  };

  function pushShow(kind, busy) {
    push.box.hidden = false;
    push.box.setAttribute('data-state', kind);
    push.text.textContent = PUSH_UI[kind][0];
    push.btn.hidden = !PUSH_UI[kind][1];
    push.btn.textContent = PUSH_UI[kind][1];
    push.btn.disabled = !!busy;
  }

  function pushEnable() {
    pushShow('off', true);
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { pushShow(perm === 'denied' ? 'denied' : 'off'); return; }
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription().then(function (sub) {
          return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKey() });
        });
      }).then(function (sub) {
        return store.subscribe(sub.toJSON()).then(function () {
          pushShow('on');
          toast('Bildirimler açıldı.');
        }, function (err) {
          // Veritabanına yazılamadıysa aboneliği geri al: yoksa "açık" görünür ama bildirim hiç gelmez.
          var undo = function () { throw err; };
          return sub.unsubscribe().then(undo, undo);
        });
      });
    }).catch(function (err) {
      pushShow(Notification.permission === 'denied' ? 'denied' : 'off');
      toast(err && err.message ? err.message : 'Bildirimler açılamadı.', true);
    });
  }

  function pushDisable() {
    pushShow('on', true);
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) { return sub && sub.unsubscribe(); })
      .then(function () { pushShow('off'); toast('Bildirimler kapatıldı.'); },
        function () { pushShow('on'); toast('Bildirimler kapatılamadı.', true); });
  }

  function initPush() {
    if (!store.canPush) return;   // demo modu ya da vapidPublicKey yok
    var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!supported) {
      // iPhone'da bildirim yalnızca ana ekrana eklenmiş uygulamada çalışır.
      var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      var installed = window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
      if (ios && !installed) pushShow('ios');
      return;
    }
    push.btn.addEventListener('click', function () {
      if (push.box.getAttribute('data-state') === 'on') pushDisable(); else pushEnable();
    });
    if (Notification.permission === 'denied') { pushShow('denied'); return; }
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      pushShow(sub && Notification.permission === 'granted' ? 'on' : 'off');
    }, function () { /* servis çalışanı yok: kutu gizli kalır */ });
  }

  function stateCard(kind) {
    var box = el('div', 'state' + (kind === 'error' ? ' is-error' : ''));
    var art = el('div', 'state-art');
    art.setAttribute('aria-hidden', 'true');
    art.innerHTML = icon(kind === 'error' ? 'alert' : 'calendar');
    box.appendChild(art);

    if (kind === 'error') {
      box.appendChild(el('h3', null, 'Bildirimler yüklenemedi'));
      box.appendChild(el('p', null, state.error || 'Bir sorun oluştu.'));
      var retry = el('button', 'btn btn-primary', 'Tekrar dene');
      retry.type = 'button';
      retry.addEventListener('click', function () { refresh(true); });
      box.appendChild(retry);
    } else {
      box.appendChild(el('h3', null, 'Henüz nöbet değişikliği bildirilmedi'));
      box.appendChild(el('p', null, 'Nöbetinizi değiştirdiğinizde buradan bildirin; liste en yeniden eskiye sıralanır.'));
      var add = el('button', 'btn btn-primary', 'İlk bildirimi yap');
      add.type = 'button';
      add.addEventListener('click', function () { openSheet(add); });
      box.appendChild(add);
    }
    return box;
  }

  function skeletons(n) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < n; i++) frag.appendChild(el('div', 'skeleton'));
    return frag;
  }

  function renderHome() {
    var ready = state.status === 'ready';
    var now = Date.now();
    var today = startOfDay(now);
    var weekStart = today - 6 * DAY_MS;
    var nToday = 0, nWeek = 0;
    state.records.forEach(function (r) {
      if (r.ts >= today) nToday++;
      if (r.ts >= weekStart) nWeek++;
    });
    els.statToday.textContent = ready ? String(nToday) : '–';
    els.statWeek.textContent = ready ? String(nWeek) : '–';
    els.statTotal.textContent = ready ? (state.records.length >= LIMIT ? LIMIT + '+' : String(state.records.length)) : '–';

    var box = els.recent;
    box.textContent = '';
    if (state.status === 'loading') { box.appendChild(skeletons(2)); return; }
    if (state.status === 'error') { box.appendChild(stateCard('error')); return; }
    if (!state.records.length) { box.appendChild(stateCard('empty')); return; }
    var ul = el('ul', 'swaps');
    state.records.slice(0, 3).forEach(function (r) { ul.appendChild(buildCard(r)); });
    box.appendChild(ul);
  }

  function renderFeed() {
    var box = els.feed;
    box.textContent = '';
    els.more.hidden = true;

    if (state.status === 'loading') { els.sub.textContent = 'Yükleniyor…'; box.appendChild(skeletons(4)); return; }
    if (state.status === 'error') { els.sub.textContent = 'En yeniden eskiye'; box.appendChild(stateCard('error')); return; }

    var total = state.records.length;
    els.sub.textContent = total ? total + (total >= LIMIT ? '+' : '') + ' bildirim · en yeniden eskiye' : 'En yeniden eskiye';
    if (!total) { box.appendChild(stateCard('empty')); return; }

    var visible = state.records.slice(0, state.shown);
    var group = null, ul = null, lastKey = '';
    visible.forEach(function (r) {
      var key = String(startOfDay(r.ts));
      if (key !== lastKey) {
        lastKey = key;
        group = el('section', 'day-group');
        group.appendChild(el('h3', 'day-label', dayLabel(r.ts)));
        ul = el('ul', 'swaps');
        group.appendChild(ul);
        box.appendChild(group);
      }
      ul.appendChild(buildCard(r, true));
    });
    els.more.hidden = total <= state.shown;
  }

  function renderNames() {
    var seen = {}, out = [];
    state.records.forEach(function (r) {
      [r.olusturan, r.karsi].forEach(function (n) {
        var k = lower(n);
        if (!seen[k]) { seen[k] = true; out.push(n); }
      });
    });
    out.sort(function (a, b) { return a.localeCompare(b, 'tr'); });
    out = out.slice(0, 300);
    var key = out.join('|');
    if (key === state.names) return;
    state.names = key;
    els.names.textContent = '';
    out.forEach(function (n) { var o = document.createElement('option'); o.value = n; els.names.appendChild(o); });
  }

  function render() {
    // Liste değişmediyse (yoklama) DOM'u yeniden kurma: kaydırma ve animasyon bozulmasın.
    var sig = state.status + '|' + state.shown + '|' + state.highlight + '|' + state.records.map(function (r) { return r.id + ':' + r.ts; }).join(',');
    if (sig !== state.sig) {
      state.sig = sig;
      renderHome();
      renderFeed();
      renderNames();
      state.records.forEach(function (r) { state.seen[r.id] = true; });
    }
    refreshTimes();
  }

  function refreshTimes() {
    var nodes = document.querySelectorAll('time[data-ts]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = timeLabel(Number(nodes[i].getAttribute('data-ts')));
  }

  function setStatus(s) {
    els.sync.setAttribute('data-state', s);
    els.syncText.textContent = STATUS_TEXT[s];
  }

  var toastTimer = 0;
  function toast(message, isError) {
    clearTimeout(toastTimer);
    els.toast.className = 'toast' + (isError ? ' is-error' : '');
    els.toast.innerHTML = icon(isError ? 'alert' : 'check');
    els.toast.appendChild(el('span', null, message));
    els.toast.hidden = false;
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, isError ? 5000 : 3200);
  }

  /* --------------------------------------------------------------- veri */

  function usable(r) { return !!parseISO(r.tarih); }

  function refresh(manual) {
    var mySeq = ++state.seq;
    state.loading = true;
    els.btnRefresh.classList.add('is-spinning');
    if (state.status === 'loading') setStatus('loading');

    function done() {
      if (mySeq !== state.seq) return;
      state.loading = false;
      els.btnRefresh.classList.remove('is-spinning');
    }

    return store.list().then(function (list) {
      if (mySeq !== state.seq) return; // daha yeni bir istek bu sonucu geçersiz kıldı
      state.records = list.filter(usable);
      state.status = 'ready';
      state.error = '';
      setStatus(store.mode === 'local' ? 'local' : 'live');
      render();
    }, function (err) {
      if (mySeq !== state.seq) return;
      state.error = err && err.message ? err.message : 'Bilinmeyen bir hata oluştu.';
      if (state.status !== 'ready') state.status = 'error'; // eldeki liste varsa göstermeye devam
      setStatus('offline');
      if (manual) toast(state.error, true);
      render();
    }).then(done, done);
  }

  function startBackgroundSync() {
    if (store.mode === 'local') {
      window.addEventListener('storage', function () { refresh(); }); // başka sekmede eklenenler
      return;
    }
    setInterval(function () { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(); });
    window.addEventListener('online', function () { refresh(); });
    window.addEventListener('offline', function () { setStatus('offline'); });
  }

  /* ------------------------------------------------------ yönlendirme */

  var currentView = '';
  function route(userInitiated) {
    var view = /degisiklikler/.test(location.hash) ? 'list' : 'home';
    els.viewHome.hidden = view !== 'home';
    els.viewList.hidden = view !== 'list';
    els.fab.hidden = view !== 'list';
    setCurrent(els.tabHome, view === 'home');
    setCurrent(els.tabList, view === 'list');
    document.title = view === 'list' ? 'Nöbet Değişiklikleri · Nöbet Değişim' : 'Nöbet Değişim';
    if (view !== currentView) {
      currentView = view;
      window.scrollTo(0, 0);
      if (userInitiated) { try { els.main.focus({ preventScroll: true }); } catch (e) { els.main.focus(); } }
    }
  }
  function setCurrent(node, on) { if (on) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); }

  /* --------------------------------------------------------- form sayfası */

  var lastFocus = null;

  // Ad artık hatırlanmıyor: eski sürümün telefona yazdığı ad bir kez silinir.
  try { window.localStorage.removeItem(NAME_KEY); } catch (e) { /* önemsiz */ }

  function renderPreview() {
    fillMessage(f.preview, clean(f.name.value), clean(f.other.value), parseISO(f.date.value), parseISO(f.date2.value));
  }

  function clearErrors() {
    [[f.name, f.eName], [f.other, f.eOther], [f.date, f.eDate], [f.date2, f.eDate2]].forEach(function (p) {
      p[0].removeAttribute('aria-invalid');
      p[1].textContent = '';
    });
    f.eForm.textContent = '';
  }

  function validate() {
    var errs = {};
    var a = clean(f.name.value), b = clean(f.other.value), d = parseISO(f.date.value);

    if (!a) errs.name = 'Lütfen adınızı ve soyadınızı yazın.';
    else if (a.length < 2) errs.name = 'Ad en az 2 karakter olmalı.';

    if (!b) errs.other = 'Lütfen nöbet değiştirdiğiniz kişiyi yazın.';
    else if (b.length < 2) errs.other = 'Ad en az 2 karakter olmalı.';
    else if (a && lower(a) === lower(b)) errs.other = 'Kendinizle nöbet değiştiremezsiniz; farklı bir kişi yazın.';

    var today = new Date();
    var lo = addDays(today, -365).setHours(0, 0, 0, 0);
    var hi = addDays(today, 365).setHours(0, 0, 0, 0);
    function checkDate(key, input, parsed, missing) {
      if (!input.value) errs[key] = missing;
      else if (!parsed || parsed.getTime() < lo || parsed.getTime() > hi) errs[key] = 'Geçerli bir tarih seçin (en fazla 1 yıl önce veya sonra).';
    }
    checkDate('date', f.date, d, 'Lütfen kendi nöbetinizin tarihini seçin.');
    checkDate('date2', f.date2, parseISO(f.date2.value), 'Lütfen karşı tarafın nöbet tarihini seçin.');
    return errs;
  }

  function showErrors(errs) {
    clearErrors();
    var first = null;
    [['name', f.name, f.eName], ['other', f.other, f.eOther], ['date', f.date, f.eDate], ['date2', f.date2, f.eDate2]].forEach(function (p) {
      if (errs[p[0]]) {
        p[1].setAttribute('aria-invalid', 'true');
        p[2].textContent = errs[p[0]];
        if (!first) first = p[1];
      }
    });
    if (first) first.focus();
  }

  function fitSheet() {
    var vv = window.visualViewport;
    if (!vv || els.sheetRoot.hidden) return;
    // iOS klavyesi sayfayı küçültmez; görünür alan kadar yukarı kaydırıp yüksekliği sınırla.
    var covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    els.sheetRoot.style.bottom = covered + 'px';
    els.sheet.style.maxHeight = Math.max(240, vv.height - 12) + 'px';
  }

  function openSheet(trigger) {
    if (!els.sheetRoot.hidden) return;
    lastFocus = trigger || document.activeElement;
    clearErrors();
    var today = new Date();
    f.date.min = toISO(addDays(today, -365));
    f.date.max = toISO(addDays(today, 365));
    f.date2.min = f.date.min;
    f.date2.max = f.date.max;
    if (!f.date.value) f.date.value = toISO(today);
    renderPreview();
    els.sheetRoot.hidden = false;
    document.documentElement.className += ' sheet-open';
    fitSheet();
    setTimeout(function () {
      var target = !clean(f.name.value) ? f.name : (!clean(f.other.value) ? f.other : (!f.date2.value ? f.date2 : f.date));
      try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    }, 60);
  }

  function closeSheet() {
    if (els.sheetRoot.hidden) return;
    els.sheetRoot.hidden = true;
    els.sheetRoot.style.bottom = '';
    els.sheet.style.maxHeight = '';
    document.documentElement.className = document.documentElement.className.replace(/\s*sheet-open/g, '');
    if (lastFocus && document.body.contains(lastFocus)) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* önemsiz */ } }
  }

  function setSending(on) {
    state.sending = on;
    f.submit.disabled = on;
    f.submitText.textContent = on ? 'Gönderiliyor…' : 'Bildir';
  }

  function onSubmit(e) {
    e.preventDefault();
    if (state.sending) return;
    var errs = validate();
    if (errs.name || errs.other || errs.date || errs.date2) { showErrors(errs); return; }
    clearErrors();

    var data = { olusturan: clean(f.name.value), karsi: clean(f.other.value), tarih: f.date.value, karsiTarih: f.date2.value };
    setSending(true);
    store.add(data).then(function (rec) {
      state.records = [rec].concat(state.records.filter(function (r) { return r.id !== rec.id; }))
        .sort(function (a, b) { return b.ts - a.ts; });
      state.status = 'ready';
      state.highlight = rec.id;
      f.name.value = '';
      f.other.value = '';
      f.date.value = '';
      f.date2.value = '';
      closeSheet();
      render();
      setStatus(store.mode === 'local' ? 'local' : 'live');
      toast(store.mode === 'local'
        ? 'Demo modu: yalnızca bu cihaza kaydedildi, diğerleri görmez.'
        : 'Nöbet değişikliği bildirildi.');
      var wasList = /degisiklikler/.test(location.hash);
      if (!wasList) location.hash = '#/degisiklikler'; else route(false);
      window.scrollTo(0, 0);
      setTimeout(function () {
        state.highlight = null;
        var n = document.querySelectorAll('.swap.is-new');
        for (var i = 0; i < n.length; i++) n[i].className = n[i].className.replace(/\s*is-new/g, '');
      }, 2600);
      refresh(); // sunucu saatiyle eşitle
    }, function (err) {
      f.eForm.textContent = err && err.message ? err.message : 'Kayıt gönderilemedi. Lütfen tekrar deneyin.';
    }).then(function () { setSending(false); }, function () { setSending(false); });
  }

  function onKeydown(e) {
    if (els.sheetRoot.hidden) return;
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    var all = els.sheet.querySelectorAll('button, input, a[href]');
    var nodes = [];
    for (var i = 0; i < all.length; i++) if (!all[i].disabled && all[i].offsetParent !== null) nodes.push(all[i]);
    if (!nodes.length) return;
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ------------------------------------------------------------ başlangıç */

  function init() {
    if (store.mode === 'local') els.demo.hidden = false;

    $('cta').addEventListener('click', function () { openSheet(this); });
    $('btn-add').addEventListener('click', function () { openSheet(this); });
    els.btnRefresh.addEventListener('click', function () { refresh(true); });
    els.more.addEventListener('click', function () { state.shown += PAGE_SIZE; state.sig = ''; render(); });

    els.sheetRoot.addEventListener('click', function (e) {
      var n = e.target;
      while (n && n !== els.sheetRoot) {
        if (n.hasAttribute && n.hasAttribute('data-close')) { closeSheet(); return; }
        n = n.parentNode;
      }
    });
    f.form.addEventListener('submit', onSubmit);
    ['input', 'change'].forEach(function (ev) {
      [f.name, f.other, f.date, f.date2].forEach(function (inp) { inp.addEventListener(ev, renderPreview); });
    });
    [f.name, f.other, f.date, f.date2].forEach(function (inp) {
      inp.addEventListener('input', function () {
        if (inp.getAttribute('aria-invalid')) { inp.removeAttribute('aria-invalid'); }
        f.eForm.textContent = '';
      });
    });
    document.addEventListener('keydown', onKeydown);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitSheet);
      window.visualViewport.addEventListener('scroll', fitSheet);
    }

    window.addEventListener('hashchange', function () { route(true); });
    route(false);

    render();
    setStatus('loading');
    refresh();
    startBackgroundSync();
    setInterval(refreshTimes, 30000);
    initPush();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* çevrimdışı önbellek isteğe bağlı */ }); });
    }
  }

  init();
})();
