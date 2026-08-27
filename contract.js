// ─── Uygulama ile backend arasındaki sözleşme ──────────────────────────
//
// Bu iki depo `stations`, `spots`, `results`, `itineraries`, `lat`/`lon`
// gibi alan adları üzerinden anlaşıyor. Bu isimler bir süre ne şemada, ne
// tip dosyasında, ne dokümanda tanımlıydı — yalnızca iki tarafın koduna
// gömülüydüler. Backend bir alanı yeniden adlandırsa hiçbir yerde hata
// çıkmaz, uygulama sessizce boş liste gösterirdi.
//
// Burası o isimlerin tek tanımı. __tests__/contract.test.js her ucun
// gerçekten bu şemaya uyduğunu doğrular; isim değiştiren biri testte
// yakalanır, kullanıcıda değil.
//
// KURALLAR
//   • Koordinat her yerde lat / lon. (İZELMAN "lng" der, ParkingService
//     çeviriyi kendi içinde yapar; dışarı lon çıkar. Tek istisna OTP'nin
//     dayattığı ParkAPI gövdesidir: orada coords.lng — bkz. OTP_PARKAPI.)
//   • Bilinmeyen sayısal değer null'dır, 0 değil. 0 "gerçekten sıfır"
//     demektir: kapasitesi bilinmeyen istasyon ile boş istasyon aynı şey
//     değildir.
//   • Liste dönen her uç, listeyi bir zarf içinde verir ({stations: [...]}).
//     Çıplak dizi dönmek, ileride yanına updatedAt gibi bir alan eklemeyi
//     kırıcı değişiklik hâline getirirdi.

// Uygulamanın TÜKETTİĞİ uçlar. `zarf` yanıtın kök alanı, `alanlar` o
// dizideki her elemanın taşıması gereken anahtarlar.
const UCLAR = {
  "GET /bisim/stations": {
    zarf: "stations",
    alanlar: ["id", "name", "active", "capacity", "bikes", "lat", "lon", "ref"],
    ek: ["updatedAt"],
    not: "bikes her zaman null — BİSİM'in anlık doluluğu 2025-07-23'ten beri yayınlanmıyor.",
  },
  "GET /parking/stations": {
    zarf: "stations",
    alanlar: ["id", "name", "lat", "lon", "type", "capacity", "free", "occupied",
              "status", "isPaid", "nearMetro", "nearTrain", "nearTram", "provider"],
    ek: ["updatedAt"],
  },
  "GET /parking/otp-lots": {
    zarf: "stations",
    alanlar: ["id", "name", "lat", "lon", "tags", "state", "bicyclePlaces", "carPlaces",
              "otpCarSpaces", "otpBicycleSpaces", "otpFreeCar", "free", "occupied", "capacity"],
    ek: ["updatedAt"],
    not: "?vehicle=bicycle|car ve ?tag= ile süzülür. OSM kaynaklı kayıtlarda doluluk null'dır.",
  },
  "GET /parking/osm": {
    zarf: "spots",
    alanlar: ["id", "name", "lat", "lon", "type", "fee", "capacity"],
    ek: ["updatedAt"],
  },
  "GET /parking/bike-racks": {
    zarf: "stations",
    alanlar: ["id", "lat", "lon", "capacity", "covered"],
    ek: ["updatedAt"],
  },
  "GET /geocode": {
    zarf: "results",
    alanlar: ["place_id", "lat", "lon", "display_name"],
    not: "lat/lon burada METİNDİR (Nominatim biçimi); uygulama parseFloat eder.",
  },
  "POST /get-route": {
    zarf: "itineraries",
    alanlar: ["legs"],
    ek: ["routingErrors", "profile"],
    not: "Sıralama YAPILMAZ; puanlama ve eleme uygulamanın işi (utils/routeScoring.js).",
  },
};

// OTP'nin dayattığı gövdeler — bunlar bizim tercihimiz değil, OTP'nin
// updater'ları tam olarak bu adları arar. Bir alan adı yanlış yazıldığında
// OTP hata vermeden sıfır kayıt yükler; bu bir kez yaşandı.
const OTP_PARKAPI = {
  yol: "GET /parking/feed",
  zarf: "lots",
  alanlar: ["id", "name", "coords", "state", "total", "free"],
  koordinat: ["lat", "lng"], // DİKKAT: burada lng, çünkü ParkAPI öyle ister
  not: "state zorunludur: OTP null kontrolü yapmadan okur, eksikse updater düşer.",
};

const GBFS = {
  yollar: ["GET /bisim/gbfs", "GET /bisim/gbfs/system_information",
           "GET /bisim/gbfs/station_information", "GET /bisim/gbfs/station_status"],
  istasyonAlanlari: ["station_id", "name", "lat", "lon"],
  not: "capacity İSTEĞE BAĞLIDIR ve bilinmiyorsa hiç gönderilmez — uydurma sayı yazılmaz.",
};

// Sağlık uçları izleme aracının sözleşmesidir; alan adları değişirse
// panolar sessizce boş kalır.
const SAGLIK = {
  "GET /health": { alanlar: ["status", "uptimeSec", "checkedAt"] },
  "GET /health/ready": { alanlar: ["status", "issues", "uptimeSec", "checks", "checkedAt"] },
  durumlar: ["ok", "degraded", "down"],
};

module.exports = { UCLAR, OTP_PARKAPI, GBFS, SAGLIK };
