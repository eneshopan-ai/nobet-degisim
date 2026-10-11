/*
 * Nöbet Değişim — yapılandırma
 *
 * databaseUrl boş bırakılırsa uygulama "demo modunda" çalışır: bildirimler
 * yalnızca o telefonun tarayıcısında saklanır. Bölümdeki herkesin aynı listeyi
 * görmesi için bir Firebase Realtime Database adresi yazın (README.md → Kurulum).
 *
 * Örnek:
 *   databaseUrl: 'https://nobet-xxxxx-default-rtdb.europe-west1.firebasedatabase.app'
 */
window.NOBET_CONFIG = {
  databaseUrl: 'https://nobet-degisim-default-rtdb.europe-west1.firebasedatabase.app',
  path: 'nobetler',   // veritabanındaki düğüm adı (güvenlik kurallarıyla aynı olmalı)
  limit: 500,         // listede tutulan en yeni kayıt sayısı
  pollSeconds: 30     // liste kaç saniyede bir yenilensin
};
