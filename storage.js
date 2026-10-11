/*
 * Nöbet Değişim — veri katmanı
 *
 * İki sürücü, aynı arayüz:
 *   list() -> Promise<Kayıt[]>   en yeniden eskiye sıralı
 *   add({olusturan, karsi, tarih, karsiTarih}) -> Promise<Kayıt>
 *   remove(id) -> Promise<void>   linke giren herkes silebilir (kurallar da buna izin verir)
 *
 *   cloud : Firebase Realtime Database REST API (herkes ortak listeyi görür)
 *   local : localStorage (demo; kayıtlar yalnızca bu cihazda)
 *
 * Kayıt = { id, olusturan, karsi, tarih: 'YYYY-AA-GG', karsiTarih: 'YYYY-AA-GG' | '', ts: epoch ms }
 *   tarih = olusturanın nöbeti, karsiTarih = karşı tarafın nöbeti ('' = eski kayıt, tek tarihliydi)
 */
(function (global) {
  'use strict';

  var LS_KEY = 'nobet.v1.kayitlar';
  var NAME_MAX = 40;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sortNewestFirst(list) {
    return list.slice().sort(function (a, b) {
      if (b.ts !== a.ts) return b.ts - a.ts;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
  }

  // Veritabanından gelen her kaydı doğrula: kimse listeyi bozuk veriyle kirletemesin.
  function normalize(id, v) {
    if (!v || typeof v !== 'object') return null;
    var a = clean(v.olusturan);
    var b = clean(v.karsi);
    var t = typeof v.tarih === 'string' ? v.tarih : '';
    var ts = Number(v.ts);
    if (!a || !b || !ISO_RE.test(t) || !isFinite(ts)) return null;
    var t2 = typeof v.karsiTarih === 'string' && ISO_RE.test(v.karsiTarih) ? v.karsiTarih : '';
    return { id: String(id), olusturan: a.slice(0, NAME_MAX), karsi: b.slice(0, NAME_MAX), tarih: t, karsiTarih: t2, ts: ts };
  }

  function fail(message, cause) {
    var e = new Error(message);
    e.cause = cause;
    return e;
  }

  /* ---------------------------------------------------------------- local */

  function createLocal(cfg) {
    var limit = Number(cfg.limit) || 500;
    var memory = [];

    function read() {
      try {
        var raw = global.localStorage.getItem(LS_KEY);
        var arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (e) {
        return memory;
      }
    }

    function write(arr) {
      memory = arr;
      try {
        global.localStorage.setItem(LS_KEY, JSON.stringify(arr));
      } catch (e) { /* gizli sekme / kota: bellekte tutmaya devam */ }
    }

    return {
      mode: 'local',
      list: function () {
        var out = [];
        read().forEach(function (v) {
          var n = normalize(v && v.id, v);
          if (n) out.push(n);
        });
        return Promise.resolve(sortNewestFirst(out).slice(0, limit));
      },
      add: function (data) {
        var rec = {
          id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          olusturan: clean(data.olusturan),
          karsi: clean(data.karsi),
          tarih: data.tarih,
          karsiTarih: data.karsiTarih || '',
          ts: Date.now()
        };
        var arr = sortNewestFirst(read().concat([rec])).slice(0, limit);
        write(arr);
        return Promise.resolve(rec);
      },
      remove: function (id) {
        write(read().filter(function (v) { return !v || String(v.id) !== String(id); }));
        return Promise.resolve();
      }
    };
  }

  /* ---------------------------------------------------------------- cloud */

  function createCloud(cfg) {
    var base = String(cfg.databaseUrl).replace(/\/+$/, '');
    var node = String(cfg.path || 'nobetler').replace(/^\/+|\/+$/g, '');
    var limit = Number(cfg.limit) || 500;
    var endpoint = base + '/' + node + '.json';

    // fetch + zaman aşımı (AbortController yoksa yalnızca yarışır)
    function request(url, init) {
      var timeoutMs = 12000;
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var opts = init || {};
      if (ctrl) opts.signal = ctrl.signal;
      var timer;
      var timeout = new Promise(function (_, reject) {
        timer = setTimeout(function () {
          if (ctrl) ctrl.abort();
          reject(fail('Sunucu yanıt vermedi. Bağlantınızı kontrol edip tekrar deneyin.'));
        }, timeoutMs);
      });
      return Promise.race([
        fetch(url, opts).catch(function (e) {
          throw fail('Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.', e);
        }),
        timeout
      ]).then(function (res) {
        clearTimeout(timer);
        return res;
      }, function (err) {
        clearTimeout(timer);
        throw err;
      });
    }

    return {
      mode: 'cloud',
      list: function () {
        var url = endpoint + '?orderBy=%22%24key%22&limitToLast=' + limit;
        return request(url, { method: 'GET', cache: 'no-store' }).then(function (res) {
          if (!res.ok) {
            throw fail(res.status === 401 || res.status === 403
              ? 'Listeyi okuma izni yok. Veritabanı kurallarını kontrol edin.'
              : 'Liste alınamadı (HTTP ' + res.status + ').');
          }
          return res.json();
        }).then(function (obj) {
          var out = [];
          if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach(function (id) {
              var n = normalize(id, obj[id]);
              if (n) out.push(n);
            });
          }
          return sortNewestFirst(out);
        });
      },
      add: function (data) {
        var body = {
          olusturan: clean(data.olusturan),
          karsi: clean(data.karsi),
          tarih: data.tarih,
          karsiTarih: data.karsiTarih,
          ts: { '.sv': 'timestamp' }   // saati sunucu yazar, istemci değil
        };
        // Content-Type göndermiyoruz: "basit istek" kalır, CORS ön kontrolü gerekmez.
        return request(endpoint, { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
          if (!res.ok) {
            throw fail(res.status === 401 || res.status === 403
              ? 'Kayıt reddedildi. Veritabanı kuralları yazmaya izin vermiyor.'
              : 'Kayıt gönderilemedi (HTTP ' + res.status + ').');
          }
          return res.json();
        }).then(function (out) {
          if (!out || !out.name) throw fail('Sunucudan beklenmeyen yanıt geldi.');
          return {
            id: String(out.name),
            olusturan: body.olusturan,
            karsi: body.karsi,
            tarih: body.tarih,
            karsiTarih: body.karsiTarih,
            ts: Date.now() // bir sonraki yenilemede sunucu saati ile değişir
          };
        });
      },
      remove: function (id) {
        var url = base + '/' + node + '/' + encodeURIComponent(id) + '.json';
        return request(url, { method: 'DELETE' }).then(function (res) {
          if (!res.ok) {
            throw fail(res.status === 401 || res.status === 403
              ? 'Silme reddedildi. Veritabanı kuralları silmeye izin vermiyor.'
              : 'Bildirim silinemedi (HTTP ' + res.status + ').');
          }
        });
      }
    };
  }

  global.NobetStore = {
    clean: clean,
    NAME_MAX: NAME_MAX,
    create: function (cfg) {
      cfg = cfg || {};
      return cfg.databaseUrl ? createCloud(cfg) : createLocal(cfg);
    }
  };
})(window);
