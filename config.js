// Tek yapılandırma noktası.
//
// Buradan önce OTP_URL beş ayrı dosyada aynı iki satırla yeniden
// tanımlanıyordu, TTL'ler ve timeout'lar bulundukları yere gömülü sihirli
// sayılardı, İZELMAN adresi servisin içindeydi. Hiçbiri tek başına hata
// değildi; sorun, birini değiştirmek gerektiğinde diğerlerinin sessizce
// eski kalmasıydı.
//
// Ortam değişkeni kabul eden değerler açıkça process.env okur; gerisi sabit.

const PORT = 3000; // start.sh'ın hazırlık yoklaması da bu portu bekler
const OTP_PORT = Number(process.env.OTP_PORT) || 8080;

module.exports = {
  PORT,
  OTP_PORT,

  // OTP'nin GraphQL ucu. Aynı konteynerde yaşadıkları için localhost.
  OTP_URL: `http://localhost:${OTP_PORT}/otp/gtfs/v1`,

  // Dış veri kaynakları
  //
  // Otopark verisi İKİ ayrı kaynaktan gelir ve ikisi de gereklidir:
  //   ENVANTER (CKAN)  → 82 otopark, kapasite + konum + çalışma saati, doluluk YOK
  //   DOLULUK (İZELMAN) → 14 otopark, anlık boş/dolu, envanterin üstüne binlenir
  // Tek başına İZELMAN kullanıldığında otopark sayısı 14 ile sınırlıydı;
  // sensörü olmayan 68 otopark hiç görünmüyordu.
  IZELMAN_PARK_URL: "https://openapi.izmir.bel.tr/api/ibb/izum/otoparklar",
  CKAN_DATASTORE_URL: "https://acikveri.bizizmir.com/api/3/action/datastore_search",

  // İzmir Açık Veri portalındaki İZELMAN otopark envanteri. Abonelik
  // otoparkları (MKSB bariyerli, 17 kayıt) kasten dışarıda: halka açık
  // değiller, P+R önerisi olarak gösterilmeleri yanlış olur.
  CKAN_OTOPARK_KAYNAKLARI: [
    { resourceId: "a982c5d9-931d-4a75-a61d-23127d8ddad2", tip: "OnStreet"  }, // Yol kenarı, 48
    { resourceId: "6ad4ad67-5923-49ec-8725-3f44f6f72aec", tip: "OffStreet" }, // Kapalı alan, 23
    { resourceId: "959c08c4-3e62-4e20-9e45-c334b0df31b1", tip: "OffStreet" }, // Yol dışı açık alan, 11
  ],

  // Raylı sistem + vapur istasyonları. P+R sınıflandırması artık İZELMAN'ın
  // `poi` bayraklarına değil, bu 91 istasyona olan GERÇEK mesafeye bakıyor —
  // `poi` yalnız İZELMAN feed'indeki 14 kayıtta var, envanterin kalanında yok.
  // Hepsi yarım saniyede yanıtlıyor; yavaş olan yalnız otoparklar ucudur.
  ISTASYON_URLS: {
    metro:  "https://openapi.izmir.bel.tr/api/metro/istasyonlar",
    izban:  "https://openapi.izmir.bel.tr/api/izban/istasyonlar",
    tren:   "https://openapi.izmir.bel.tr/api/ibb/cbs/trengarlari",
    iskele: "https://openapi.izmir.bel.tr/api/izdeniz/iskeleler",
  },
  PHOTON_URL:       "https://photon.komoot.io/api/",
  NOMINATIM_URL:    "https://nominatim.openstreetmap.org/search",

  // Nominatim kullanım şartları tanımlayıcı bir User-Agent ister.
  USER_AGENT: "IzmirUlasimBackend/1.0",

  // ─── Süreler (ms) ────────────────────────────────────────────────────
  TTL: {
    // İZELMAN doluluk verisi anlıktır, ama ucu ~50 saniyede yanıtlıyor.
    // Bu yüzden yenileme İSTEK YOLUNDA DEĞİL, arka planda yapılır; buradaki
    // süre o arka plan turunun sıklığıdır (bkz. ParkingService.baslatYenileme).
    PARKING: 5 * 60 * 1000,
    // Envanter ve istasyon KONUMLARI nadiren değişir — doluluk değil, konum.
    PARK_ENVANTER: 24 * 60 * 60 * 1000,
    ISTASYON: 24 * 60 * 60 * 1000,
    // İstasyon/otopark KONUMLARI nadiren değişir — doluluk değil, konum.
    OVERPASS: 24 * 60 * 60 * 1000,
    // Aynı harfleri yazan kullanıcılar aynı sorguyu tekrarlar.
    GEOCODE: 5 * 60 * 1000,
  },

  // Tüm Overpass mirror'ları düştüğünde her istekte üçünü birden denemek,
  // her isteğe timeout kadar gecikme ekler. Bu süre boyunca stale cache verilir.
  OVERPASS_BACKOFF: 6 * 60 * 60 * 1000,

  TIMEOUT: {
    // İZELMAN otopark ucu ölçülen üç denemede 48.8 / 57.0 / 58.3 saniyede
    // yanıtladı — soğuk başlangıç değil, kalıcı olarak bu kadar yavaş.
    // Eski 8000 değeri her turda dolup veriyi hiç alınamaz kılıyordu; bu
    // süre artık yalnız arka plan turunda beklenir, istek yolunu bloklamaz.
    IZELMAN:  90000,
    CKAN:     15000,
    // İZBAN ucu ölçümde 0.4 sn ile 8.6 sn arasında değişti; dar bir pencere
    // o türü sessizce düşürüyordu.
    ISTASYON: 20000,
    OVERPASS: 8000,
    // way + `out center` sorgusu düğüm sorgusundan belirgin yavaş.
    OVERPASS_AGIR: 15000,
    GEOCODE:  6000,
    // OTP plan sorgusu en uzun süren çağrı; istemci tarafı 25 sn bekler.
    OTP_PLAN: 15000,
    OTP_SORGU: 10000,
    // Sağlık ucu yavaş olursa izleme aracı zaman aşımını "servis öldü" diye
    // raporlar — bu yüzden kısa.
    OTP_SAGLIK: 3000,
  },

  // NOT — bisikletin "işe yarıyor" sayılma eşikleri buradan KALDIRILDI.
  //
  // Burada BISIKLET_ANLAMLI_MIN_M ve BISIKLET_ANLAMLI_PAY vardı; ikisi de
  // "bisikletsiz yedek sorgusu atayım mı" kararını besliyordu. O yedek
  // kaldırıldı (bkz. services/OtpService.js): bir bisiklet modu artık
  // bisikletsiz güzergâh döndürmüyor.
  //
  // Eşikler tek yerde yaşıyor: izmir_ulasim/utils/routeScoring.js
  //   BIKE_LEG_MIN         — bisiklet bacağı en az kaç metre olmalı
  //   BISIKLET_ASGARI_PAY  — yolculuk süresinin en az yüzde kaçı olmalı
  // İki kopya tutulduğunda ayrışıyorlardı; karar gösterim katmanına ait.
  //
  // Kaybolmaması gereken ölçüm (Konak → Bornova, Pzt 08:00): BICYCLE_PARKING
  // erişimiyle 50.3 dk ve bisiklet bacağı 282 m; yalnız yürüyüşle 44.1 dk.
  // Yani 282 metrelik sürüş yolculuğu 6.2 DAKİKA UZATIYORDU. Sebep,
  // genelleştirilmiş maliyette yürüyüşün 2 kat cezalı, bisikletin cezasız
  // olması: duvar saatinde kaybettiren rota maliyet tablosunda kazanıyor.

  // Bir otoparkın "Park + Devam" sayılması için raylı sistem/vapur
  // istasyonuna azami yürüme mesafesi (m).
  //
  // 82 otoparkın tamamı için en yakın istasyon mesafesi ölçüldü:
  //   400 m → 50 otopark, 11.448 araç kapasitesi
  //   600 m → 68 otopark, 12.121
  //   800 m → 81 otopark, 12.631  ← 82'nin 81'i geçiyor, kural anlamsızlaşıyor
  // 400 m seçildi: yürünebilir bir aktarma mesafesi ve ayırt edici.
  PR_YARICAP_M: 400,
};
