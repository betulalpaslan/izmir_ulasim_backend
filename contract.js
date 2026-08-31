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
    zarf: "bolgeler",
    alanlar: ["id", "ad", "ilce", "lat", "lon", "yaricapM", "guven"],
    ek: ["model", "updatedAt"],
    not: "BİSİM 2025-08'de sabit istasyonları kaldırdı; bu uç artık BÖLGE döndürür, istasyon değil. Bisiklet hizmet alanı içinde her yere bırakılabilir, bu bölgelerde bırakınca bonus verilir. 'yaricapM' bölgenin yaklaşık yarıçapı, 'guven' konumun ne kadar doğrulandığıdır (yuksek/orta/dusuk).",
  },
  "GET /parking/stations": {
    zarf: "stations",
    alanlar: ["id", "name", "lat", "lon", "type", "capacity", "free", "occupied",
              "status", "isPaid", "nearMetro", "nearTrain", "nearTram", "nearFerry",
              "railDistanceM", "railName", "source", "provider"],
    ek: ["updatedAt"],
    not: "Envanter (CKAN, 82 otopark) ile doluluk (İZELMAN, 14 otopark) birleşir. Sensörü olmayan otoparkta free/occupied NULL'dır — sıfır değil; 'source' hangi kaynaklardan geldiğini söyler (ckan | izelman | ckan+izelman). railDistanceM en yakın raylı/vapur istasyonuna ölçülen mesafedir, P+R kararı buna dayanır.",
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
  alanlar: ["id", "name", "coords", "state", "total"],
  kosullu: ["free"],
  koordinat: ["lat", "lng"], // DİKKAT: burada lng, çünkü ParkAPI öyle ister
  not: "state zorunludur: OTP null kontrolü yapmadan okur, eksikse updater düşer. 'free' KOŞULLUDUR: yalnız doluluk gerçekten biliniyorsa gönderilir. Bilinmeyeni 0 yazmak OTP'ye 'bu otopark dolu' demektir ve otoparkı rotalamadan düşürür — kapasitesi bilinen ama sensörü olmayan 68 otopark böyle kaybolurdu.",
};

// Aynı ParkAPI gövdesi, farklı updater: OTP bunu BİSİKLET yeri olarak
// kaydeder (sourceType: BICYCLE_PARK_API). `free` burada HİÇ gönderilmez —
// doluluk araba yerlerinindir; taşınırsa dolu bir otopark bisiklete de
// kapalı sayılır.
const OTP_BIKE_PARKAPI = {
  yol: "GET /parking/bike-feed",
  zarf: "lots",
  alanlar: ["id", "name", "coords", "state", "total"],
  kosullu: [],
  koordinat: ["lat", "lng"],
  not: "İçerik: raylı sefer YAPILAN duraklar (OTP'nin kendi durak listesinden, 150 m kümelemeyle) + P+R otoparkları. Kaynak olarak İZULAŞ istasyon API'si KULLANILMAZ: o liste raylı seferi olmayan noktaları da istasyon sayıyor ve bisikletin metronun beriside park edilmesine yol açıyordu.",
};

const GBFS = {
  yollar: ["GET /bisim/gbfs", "GET /bisim/gbfs/system_information",
           "GET /bisim/gbfs/station_information", "GET /bisim/gbfs/station_status",
           "GET /bisim/gbfs/vehicle_types", "GET /bisim/gbfs/free_bike_status",
           "GET /bisim/gbfs/geofencing_zones"],
  istasyonAlanlari: ["station_id", "name", "lat", "lon", "capacity"],
  serbestBisikletAlanlari: ["bike_id", "lat", "lon", "is_reserved", "is_disabled", "vehicle_type_id"],
  aracTuruAlanlari: ["vehicle_type_id", "form_factor", "propulsion_type", "name", "return_constraint"],
  bolgeGeometrisi: "MultiPolygon",
  notlar: [
    "geofencing_zones OTP'ye BIRAKMA kuralını verir: kuralında hiçbir yasak olmayan bölge OTP'nin iç modelinde 'işletme alanı'dır — dışına bırakılamaz, içinde her yere bırakılabilir.",
    "Geometri MultiPolygon OLMALI. Polygon gönderilirse OTP ayrıştıramaz ve hata TÜM feed yüklemesini iptal eder; istasyon listesi de sessizce eski halinde kalır (ölçüldü).",
    "properties.rules boş bırakılamaz: OTP 2.8.1 kuralları koşulsuz okur, null gelirse NullPointerException atar ve istasyon sayısı 0'a iner (ölçüldü).",
    "station_information'daki capacity bölgede yuva olduğu anlamına gelmez; OTP alanı olmayan istasyonu kullanılamaz saydığı için gönderilen nominal bir değerdir. Kullanıcıya dönük /bisim/stations bu alanı içermez.",
    "ttl OTP tarafından birebir uygulanır — uzun verilirse bölge değişikliği o süre boyunca alınmaz.",
    "free_bike_status BİSİM'in dockless modelini taşır: serbest araç, geofencing bölgesinin İÇİNDE her yere bırakılabilir. Bu uç olmadan OTP ağı istasyonlu sanıyor ve kiralamayı ancak bir istasyonda bitirebiliyordu — ölçüldü, Konak → Alsancak'ta bisiklet istasyona bırakılıp kalan 1294 m yürünüyordu.",
    "free_bike_status'teki koordinatlar tek tek bisikletlerin GERÇEK yeri değildir; canlı konum yayınlanmıyor. Gerçek bisiklet yolu geometrisi üzerinde 400 m'de bir örneklenmiş alma noktalarıdır ve bu yüzden kullanıcıya dönük uçlarda GÖSTERİLMEZLER.",
  ],
  otpUpdater: { geofencingZones: true, not: "Bu bayrak olmadan OTP geofencing_zones.json'u hiç okumaz." },
};

// Sağlık uçları izleme aracının sözleşmesidir; alan adları değişirse
// panolar sessizce boş kalır.
const SAGLIK = {
  "GET /health": { alanlar: ["status", "uptimeSec", "checkedAt"] },
  "GET /health/ready": { alanlar: ["status", "issues", "uptimeSec", "checks", "checkedAt"] },
  durumlar: ["ok", "degraded", "down"],
};

module.exports = { UCLAR, OTP_PARKAPI, OTP_BIKE_PARKAPI, GBFS, SAGLIK };
