# Nöbet Değişim

Bölümde nöbet değiştirenlerin değişikliklerini bildirdiği, telefon öncelikli web uygulaması. Derleme adımı ve bağımlılığı yoktur: düz HTML + CSS + JavaScript.

- **Ana Sayfa** — "Nöbet Değişikliği Bildir" düğmesi. Basınca **Ben / Nöbet değiştirdiğim kişi / Benim nöbetimin tarihi / Karşı tarafın nöbetinin tarihi** formu açılır ve şu mesaj oluşur:
  *"Ben Ayşe Yılmaz, 14 Ekim 2026 Çarşamba tarihli nöbetimle, 20 Ekim 2026 Salı tarihli Mehmet Demir adlı kişinin nöbetini değiştirdim."*
- **Nöbet Değişiklikleri** sekmesi — tüm bildirimler **en yeniden eskiye** sıralanır; günlere göre gruplanır.
- Renkli, koyu mod destekli; 280 px (katlanmış telefon) ile tablet arası boyutlarda denendi; ana ekrana eklenebilir (PWA), internet kesikken açılır.

## Ortak ve kalıcı kayıt: bir veritabanı gerekir

GitHub Pages yalnızca statik dosya sunar, veri **saklayamaz**. Linke giren herkesin aynı listeyi görmesi için bir veritabanı bağlanmalıdır. Uygulama **Firebase Realtime Database**'in REST arayüzünü kullanır (SDK yok, ücretsiz Spark planı yeterli).

`config.js` içindeki `databaseUrl` **boşsa** uygulama *demo modunda* çalışır: kayıtlar yalnızca o telefonun tarayıcısında kalır, başkaları görmez. Ekranda "Demo modu" uyarısı çıkar.

### 1) Firebase (bir kez, yaklaşık 5 dakika)

1. [console.firebase.google.com](https://console.firebase.google.com) → proje oluşturun (Analytics gerekmez).
2. **Build → Realtime Database → Create Database**. Konum seçin, **locked mode** ile başlatın.
3. **Rules** sekmesine [`database.rules.json`](./database.rules.json) dosyasının içeriğini yapıştırıp **Publish** edin.
4. **Data** sekmesindeki adresi kopyalayın (`https://….firebasedatabase.app`).
5. `config.js` içinde `databaseUrl` alanına yapıştırın, commit edin.

Kuralların sağladıkları:

| İstek | Sonuç |
| --- | --- |
| Linke giren **herkes** bildirimleri okuyabilir | evet |
| **Herkes** yeni bildirim ekleyebilir (giriş yok) | evet |
| Eklenen kaydı **silmek** | evet — linke giren herkes silebilir (onay sorulur) |
| Eklenen kaydı **değiştirmek** | hayır |
| Alanlar: ad 2–40 karakter, iki tarih `YYYY-AA-GG` (`tarih`, `karsiTarih`), fazladan alan yok | zorunlu |
| Kayıt saati | sunucu yazar (`ts == now`), istemci sahteleyemez |

Kayıtları listedeki çöp kutusu düğmesiyle linke giren herkes silebilir; giriş olmadığı için biri başkasının bildirimini de silebilir. Gerekirse Firebase konsolundaki **Data** sekmesinden de silebilirsiniz.

### 2) GitHub Pages ile yayın

1. Depoda **Settings → Pages → Build and deployment → Source: GitHub Actions** seçin.
2. `main`'e push edince [`pages.yml`](.github/workflows/pages.yml) siteyi yayınlar.
3. Adres: `https://<kullanıcı>.github.io/<depo>/` (bu depo için `https://eneshopan-ai.github.io/nobet-degisim/`).

> Özel (private) depolarda GitHub Pages için ücretli plan gerekir.

## Telefon bildirimi (Web Push)

Ana sayfadaki **Bildirimleri aç** düğmesi cihazı abone yapar; biri yeni nöbet değişikliği bildirince abonelerin telefonuna bildirim gider (silmede gitmez).

- **Nasıl çalışır:** [`bildirim.yml`](.github/workflows/bildirim.yml) her 5 dakikada yeni kayıt var mı bakar, varsa abonelere Web Push gönderir. Sunucu, kart ya da ücretli plan gerekmez.
- **Gecikme:** GitHub zamanlayıcısı garanti vermez; bildirim yaklaşık 5–15 dakikada gelir. Depo 60 gün hareketsiz kalırsa GitHub zamanlanmış işleri durdurur (Actions sekmesinden yeniden etkinleştirin).
- **Android / bilgisayar:** siteyi açıp "Bildirimleri aç"a basmak yeter.
- **iPhone:** önce Safari'de Paylaş → **Ana Ekrana Ekle**, sonra uygulamayı ana ekrandan açıp düğmeye basın (iOS 16.4+).
- **Kurulum (bir kez):** `config.js` içindeki `vapidPublicKey` ve GitHub'daki `VAPID_PRIVATE_KEY` secret'ı bir çifttir. Çifti yenilerseniz herkesin bildirimi yeniden açması gerekir. `database.rules.json` içindeki `abonelikler` kuralı da Firebase'de yayınlı olmalı.
- **Aboneler:** `abonelikler` düğümünde adres + anahtar tutulur, herkes okuyabilir ama gönderim özel anahtar olmadan yapılamaz. Göndericinin SSRF'e karşı yalnızca bilinen push servislerine (FCM, Mozilla, Apple, Windows) gönderim yapması test edilir.
- Kayıt ekleyen kişinin kendi telefonuna da bildirim gider.

## Gizlilik ve güvenlik notları

- Giriş / parola **yoktur**: linki bilen herkes görür ve ekler. Bu bilinçli bir sadelik tercihidir. Linki yalnızca bölümle paylaşın; sayfa arama motorlarına kapalıdır (`noindex`).
- Ekranda yalnızca **ad-soyad ve nöbet tarihi** tutulur. Hasta bilgisi veya telefon numarası girmeyin.
- Kimlik doğrulama olmadığı için biri başkası adına bildirim ekleyebilir. Gerekirse sonraki adım: Firebase Authentication ile giriş.
- Ücretsiz plan kotası (indirme/ay) bölüm ölçeğinde fazlasıyla yeterlidir; liste sekme açıkken `pollSeconds` aralığıyla yenilenir, sekme arka plandayken durur.

## Yerelde çalıştırma ve test

```bash
npx serve .                      # veya: python3 -m http.server
node test/e2e.mjs                # Playwright + Chromium gerekir
node test/notify.test.mjs        # bildirim mantığı, bağımlılık yok
```

Test, Firebase REST sözleşmesini taklit eden yerel bir sahte sunucu kullanır ve şunları doğrular: iki ayrı telefonun aynı listeyi görmesi, kayıtların sayfa yenilense de kalması, sıralama, doğrulamalar, XSS, 8 cihaz boyutunda taşma olmaması, çevrimdışı açılış. **Gerçek Firebase'e bağlanmaz** ve `database.rules.json` kurallarını çalıştırmaz; kuralları Firebase konsolundaki *Rules Playground* ile deneyin.

## Dosyalar

| Dosya | Görev |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | Arayüz, tasarım, mantık |
| `storage.js` | Veri katmanı: `cloud` (Firebase REST) ve `local` (demo) |
| `config.js` | `databaseUrl` ve ayarlar |
| `database.rules.json` | Firebase güvenlik kuralları |
| `sw.js`, `manifest.webmanifest`, `icons/` | Çevrimdışı açılış, ana ekrana ekleme, bildirimi gösterme |
| `.github/notify.mjs`, `.github/notify-lib.mjs`, `.github/workflows/bildirim.yml` | Yeni kayıtta Web Push gönderen zamanlanmış iş |
| `test/e2e.mjs`, `test/notify.test.mjs` | Uçtan uca test, bildirim mantığı testi |
