jest.mock("axios");
const request = require("supertest");
const { UCLAR, OTP_PARKAPI, OTP_BIKE_PARKAPI, GBFS, SAGLIK } = require("../contract");

// axios modül seviyesinde TUTULMAZ: her testten önce jest.resetModules()
// çalışıyor (servislerin modül içi cache'leri temiz başlasın diye) ve
// router'lar o sırada YENİ bir axios örneği alıyor. Modül seviyesindeki
// referans mock'lanınca router'ların gördüğü örnek mock'suz kalıyordu.
let axios;

// Sözleşme testleri: uçlar contract.js'te yazılı alan adlarını gerçekten
// üretiyor mu? Bir alan yeniden adlandırıldığında hata BURADA çıksın —
// uygulamanın sessizce boş liste göstermesiyle değil.
//
// Dış çağrılar mock'lu: bu testler ağa çıkmaz, yalnız gövde biçimini ölçer.

const izelmanLot = {
  ufid: "NEDAP-TR-IZM-034", name: "34 Sabancı", lat: 38.41, lng: 27.12,
  type: "OffStreet", status: "Opened", isPaid: true, provider: "İZELMAN A.Ş",
  occupancy: { total: { free: 16, occupied: 25 } }, poi: { metroStation: "Konak" },
};

// CKAN envanter kaydı: İZELMAN lotuyla AYNI konumda, böylece birleştirme
// (150 m yarıçaplı konum eşleşmesi) gerçekten çalışır ve doluluk taban kayda
// biner. Koordinatlar ayrılırsa iki ayrı otopark görünür — birleştirmenin
// bozulduğu bu testte fark edilmeli.
const ckanKaydi = {
  _id: 1, OTOPARK_ADI: "34 Sabancı", ILCE: "KONAK",
  ACILIS_SAATI: "00:00", KAPANIS_SAATI: "24:00",
  KAPASITE: 41, ENLEM: 38.41, BOYLAM: 27.12,
};

const metroIstasyonu = { Enlem: 38.4105, Boylam: 27.1205, Adi: "Konak", IstasyonId: 1 };

const overpassDugum = {
  type: "node", id: 1, lat: 38.42, lon: 27.14,
  tags: { amenity: "bicycle_rental", operator: "BİSİM", ref: "51", capacity: "20" },
};

const otpVehicleParking = {
  vehicleParkingId: "izmir-pr:NEDAP-TR-IZM-034", name: "34 Sabancı", lat: 38.41, lon: 27.12,
  tags: ["park_and_ride"], state: "open", realtime: true,
  carPlaces: true, anyCarPlaces: true, bicyclePlaces: false,
  capacity: { carSpaces: 41, bicycleSpaces: null },
  availability: { carSpaces: 16, bicycleSpaces: null },
};

// Overpass GET, İZELMAN GET, Photon GET — hepsi axios.get.
// URL'e bakıp doğru gövdeyi döndürür.
function axiosGetYonlendir(url) {
  if (url.includes("overpass")) {
    if (url.includes("bicycle_rental")) {
      return Promise.resolve({ data: { elements: [overpassDugum] } });
    }
    if (url.includes("bicycle_parking")) {
      return Promise.resolve({ data: { elements: [{ type: "node", id: 2, lat: 38.43, lon: 27.15, tags: { capacity: "10", covered: "yes" } }] } });
    }
    return Promise.resolve({ data: { elements: [{ type: "way", id: 3, center: { lat: 38.44, lon: 27.16 }, tags: { name: "Konak Otopark", parking: "underground", fee: "yes", capacity: "250" } }] } });
  }
  // Otopark verisi iki kaynaktan gelir; ikisi de mock'lanmalı yoksa servis
  // disk yedeğine düşer ve test gerçek dosyaya bağlı hale gelir.
  if (url.includes("acikveri.bizizmir.com")) {
    return Promise.resolve({ data: { success: true, result: { records: [ckanKaydi] } } });
  }
  if (url.includes("/istasyonlar")) return Promise.resolve({ data: [metroIstasyonu] });
  if (url.includes("/trengarlari")) return Promise.resolve({ data: { onemliyer: [] } });
  if (url.includes("/iskeleler"))   return Promise.resolve({ data: [] });
  if (url.includes("izmir.bel.tr")) return Promise.resolve({ data: [izelmanLot] });
  if (url.includes("photon")) {
    return Promise.resolve({ data: { features: [{ properties: { osm_id: 7, name: "Konak", type: "city" }, geometry: { coordinates: [27.12, 38.41] } }] } });
  }
  return Promise.reject(new Error("beklenmeyen GET: " + url));
}

let app;
beforeEach(() => {
  jest.resetModules();
  axios = require("axios");
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  axios.get.mockImplementation(axiosGetYonlendir);
  axios.post.mockResolvedValue({
    data: { data: { vehicleParkings: [otpVehicleParking], serviceTimeRange: { start: 1745700000, end: 1830000000 } } },
  });

  // server.js listen çağırır; test için router'ları ayrı bir app'e bağlarız.
  const express = require("express");
  app = express();
  app.use(express.json());
  app.use("/", require("../routes/healthRouter"));
  app.use("/", require("../routes/routeRouter"));
  app.use("/bisim", require("../routes/bisimRouter"));
  app.use("/parking", require("../routes/parkingRouter"));
  app.use("/", require("../routes/osmRouter"));
  const { errorHandler, notFoundHandler } = require("../middleware/errorHandler");
  app.use(notFoundHandler);
  app.use(errorHandler);
});
afterEach(() => jest.restoreAllMocks());

// Zarf + eleman alanlarını tek yerde doğrular.
async function sozlesmeyiDogrula(yol, tanim) {
  const res = await request(app).get(yol).expect(200);
  expect(res.body).toHaveProperty(tanim.zarf);
  expect(Array.isArray(res.body[tanim.zarf])).toBe(true);
  expect(res.body[tanim.zarf].length).toBeGreaterThan(0);
  const eleman = res.body[tanim.zarf][0];
  for (const alan of tanim.alanlar) {
    expect(Object.keys(eleman)).toContain(alan);
  }
  for (const alan of tanim.ek || []) {
    expect(res.body).toHaveProperty(alan);
  }
  return eleman;
}

describe("uygulamanın tükettiği uçlar", () => {
  test("GET /bisim/stations bölge döndürür", async () => {
    const b = await sozlesmeyiDogrula("/bisim/stations", UCLAR["GET /bisim/stations"]);
    expect(typeof b.lat).toBe("number");
    // Bölgede yuva yoktur; OTP'ye gönderilen nominal kapasite kullanıcıya sızmamalı.
    expect(b).not.toHaveProperty("capacity");
  });

  // Otopark uçları ağı İSTEK YOLUNDA beklemez; liste arka plan turunda dolar.
  // Test o turu açıkça çalıştırır — çağrılmazsa servis disk yedeğine düşer ve
  // test mock'lanmış veriyi değil, depodaki gerçek dosyayı ölçerdi.
  const otoparkTuruBekle = () => require("../services/ParkingService").yenile();

  test("GET /parking/stations envanter ile doluluğu birleştirir", async () => {
    await otoparkTuruBekle();
    const st = await sozlesmeyiDogrula("/parking/stations", UCLAR["GET /parking/stations"]);
    expect(st).not.toHaveProperty("lng");  // İZELMAN'ın lng'si dışarı sızmaz
    expect(st.lon).toBe(27.12);
    // Aynı konumdaki CKAN kaydı ile İZELMAN kaydı TEK satır olmalı: kapasite
    // envanterden, doluluk canlı kaynaktan.
    expect(st.source).toBe("ckan+izelman");
    expect(st.capacity).toBe(41);
    expect(st.free).toBe(16);
    // P+R kararı artık ölçülen mesafeye dayanıyor.
    expect(typeof st.railDistanceM).toBe("number");
  });

  test("GET /parking/otp-lots", async () => {
    await otoparkTuruBekle();
    await sozlesmeyiDogrula("/parking/otp-lots", UCLAR["GET /parking/otp-lots"]);
  });

  test("GET /parking/osm", async () => {
    const spot = await sozlesmeyiDogrula("/parking/osm", UCLAR["GET /parking/osm"]);
    expect(spot.lat).toBe(38.44);          // way'in center'ı okundu
  });

  test("GET /parking/bike-racks", async () => {
    await sozlesmeyiDogrula("/parking/bike-racks", UCLAR["GET /parking/bike-racks"]);
  });

  test("GET /geocode", async () => {
    const res = await request(app).get("/geocode?q=konak").expect(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    for (const alan of UCLAR["GET /geocode"].alanlar) {
      expect(Object.keys(res.body.results[0])).toContain(alan);
    }
    // lat/lon burada METİNDİR (Nominatim biçimi); uygulama parseFloat eder.
    expect(typeof res.body.results[0].lat).toBe("string");
  });
});

describe("OTP'nin dayattığı gövdeler", () => {
  // Bir alan adı yanlış yazıldığında OTP hata vermeden SIFIR kayıt yükler.
  test("GET /parking/feed — ParkAPI şeması", async () => {
    const res = await request(app).get("/parking/feed").expect(200);
    expect(Array.isArray(res.body[OTP_PARKAPI.zarf])).toBe(true);
    const lot = res.body.lots[0];
    for (const alan of OTP_PARKAPI.alanlar) expect(Object.keys(lot)).toContain(alan);
    // Burada koordinat lng'dir — sözleşmenin tek istisnası.
    expect(Object.keys(lot.coords)).toEqual(expect.arrayContaining(OTP_PARKAPI.koordinat));
    expect(lot.state).toBeDefined();
    expect(lot).not.toHaveProperty("vehicleParkingId"); // eski, çalışmayan biçim
  });

  test("GET /parking/bike-feed — ParkAPI şeması, bisiklet updater'ı için", async () => {
    const res = await request(app).get("/parking/bike-feed").expect(200);
    expect(Array.isArray(res.body[OTP_BIKE_PARKAPI.zarf])).toBe(true);
    const lot = res.body.lots[0];
    for (const alan of OTP_BIKE_PARKAPI.alanlar) expect(Object.keys(lot)).toContain(alan);
    expect(Object.keys(lot.coords)).toEqual(expect.arrayContaining(OTP_BIKE_PARKAPI.koordinat));
    expect(lot.state).toBeDefined();
    // `free` HİÇBİR lotta olmamalı: doluluk araba yerlerinindir. Taşınırsa
    // dolu bir otopark bisiklete de kapalı sayılır.
    for (const l of res.body.lots) expect(l).not.toHaveProperty("free");
  });

  test("GBFS station_information", async () => {
    const res = await request(app).get("/bisim/gbfs/station_information").expect(200);
    const st = res.body.data.stations[0];
    for (const alan of GBFS.istasyonAlanlari) expect(Object.keys(st)).toContain(alan);
    expect(typeof st.station_id).toBe("string");
  });

  // BİSİM dockless: serbest araç bölge içinde her yere bırakılabilir.
  // Bu uç olmadan OTP ağı istasyonlu sanıyor ve bisikleti en yakın
  // istasyona bıraktırıp kalan yolu yürütüyordu (ölçüldü: 1294 m).
  test("GBFS free_bike_status — serbest dolaşan bisikletler", async () => {
    const res = await request(app).get("/bisim/gbfs/free_bike_status").expect(200);
    const bikes = res.body.data.bikes;
    expect(bikes.length).toBeGreaterThan(0);
    for (const alan of GBFS.serbestBisikletAlanlari) expect(Object.keys(bikes[0])).toContain(alan);
    // true olan araç OTP'de rotalamaya hiç girmez.
    expect(bikes.every((b) => b.is_reserved === false && b.is_disabled === false)).toBe(true);
    // Kimlik konumdan türetilir: aynı nokta her turda aynı bike_id'yi
    // taşımalı, yoksa OTP her turda aracı silip yenisini ekler.
    expect(new Set(bikes.map((b) => b.bike_id)).size).toBe(bikes.length);
  });

  // Bu feed olmadan OTP serbest araçlara kendi yer tutucusunu veriyor ve
  // rota kartında bacak "Default vehicle type" diye görünüyordu.
  test("GBFS vehicle_types — araç adı ve dockless beyanı", async () => {
    const res = await request(app).get("/bisim/gbfs/vehicle_types").expect(200);
    const tur = res.body.data.vehicle_types[0];
    for (const alan of GBFS.aracTuruAlanlari) expect(Object.keys(tur)).toContain(alan);
    expect(tur.return_constraint).toBe("free_floating");
    expect(tur.name).toContain("BİSİM");
  });

  // Alma noktaları KULLANICIYA GÖSTERİLMEZ: gerçek bisiklet konumu değiller,
  // koridor üzerinde örneklenmiş varsayımlar. Haritada alan görünür.
  test("serbest bisikletler kullanıcıya dönük uçta sızmaz", async () => {
    const res = await request(app).get("/bisim/stations").expect(200);
    expect(res.body.model).toBe("bolge");
    expect(res.body).not.toHaveProperty("bikes");
    expect(res.body.bolgeler.length).toBeLessThan(50);   // 165 alma noktası değil
  });

  // ── Aşağıdaki üçü, ölçülerek bulunmuş SESSİZ arızaları bekler. Üçü de
  // hata log'u üretmeden rotalardan bisikleti tamamen kaldırıyordu.

  // 1) is_renting:false gönderildiğinde OTP istasyonu kullanılamaz sayar.
  // Eski model canlı doluluk yok diye false gönderiyordu; sonuç, grafikte 52
  // istasyon vardı ve hiçbiri açık değildi, hiçbir rotada bisiklet çıkmadı.
  // Bölge modelinde doluluk kavramı yok: bölgenin açık olması işletmecinin
  // tanımıdır, dolayısıyla true doğru cevaptır.
  test("station_status bölgeleri AÇIK bildirir", async () => {
    const res = await request(app).get("/bisim/gbfs/station_status").expect(200);
    const hepsi = res.body.data.stations;
    expect(hepsi.length).toBeGreaterThan(0);
    expect(hepsi.every((s) => s.is_renting && s.is_returning)).toBe(true);
  });

  // 2) OTP geometriyi MultiPolygon olarak okur. Polygon gönderildiğinde
  // ayrıştırma hatası TÜM feed yüklemesini iptal etti; istasyon listesi
  // sessizce eski halinde takılı kaldı.
  test("geofencing_zones geometrisi MultiPolygon", async () => {
    const res = await request(app).get("/bisim/gbfs/geofencing_zones").expect(200);
    const f = res.body.data.geofencing_zones.features[0];
    expect(f.geometry.type).toBe(GBFS.bolgeGeometrisi);
    expect(f.geometry.coordinates.length).toBeGreaterThan(0);
  });

  // 3) OTP 2.8.1 kuralları koşulsuz okur (getRules().get(0)). rules boş
  // bırakıldığında NullPointerException attı ve istasyon sayısı 0'a indi.
  // Hiçbir yasak içermeyen kural = "işletme alanı": dışına bırakılamaz,
  // içinde her yere bırakılabilir.
  test("geofencing_zones kuralları boş değil ve bırakmayı serbest bırakır", async () => {
    const res = await request(app).get("/bisim/gbfs/geofencing_zones").expect(200);
    const kurallar = res.body.data.geofencing_zones.features[0].properties.rules;
    expect(Array.isArray(kurallar)).toBe(true);
    expect(kurallar.length).toBeGreaterThan(0);
    expect(kurallar[0].ride_allowed).toBe(true);
    expect(kurallar[0].ride_through_allowed).toBe(true);
  });

  // Discovery'de listelenmeyen alt feed'i OTP hiç istemez ve o feed'in
  // taşıdığı kural sessizce kaybolur. İki kez yaşandı: geofencing_zones
  // listelenmediğinde bırakma kısıtı, free_bike_status listelenmediğinde
  // dockless model kayboldu (ikincisinde bisiklet istasyona bırakılıp
  // kalan 1294 m yürünüyordu).
  test("GBFS discovery sözleşmedeki tüm alt feed'leri listeler", async () => {
    const res = await request(app).get("/bisim/gbfs").expect(200);
    const adlar = res.body.data.en.feeds.map((f) => f.name);
    expect(adlar).toEqual([
      "system_information", "station_information", "station_status",
      "vehicle_types", "free_bike_status", "geofencing_zones",
    ]);
    expect(adlar.length).toBe(GBFS.yollar.length - 1);   // discovery ucu hariç
  });
});

describe("sağlık uçları", () => {
  test("GET /health her zaman 200", async () => {
    const res = await request(app).get("/health").expect(200);
    for (const alan of SAGLIK["GET /health"].alanlar) expect(res.body).toHaveProperty(alan);
    expect(res.body.status).toBe("ok");
  });

  test("GET /health/ready durum ve issues taşır", async () => {
    const res = await request(app).get("/health/ready");
    for (const alan of SAGLIK["GET /health/ready"].alanlar) expect(res.body).toHaveProperty(alan);
    expect(SAGLIK.durumlar).toContain(res.body.status);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  // OTP erişilemezse rota üretilemez: bu "down" ve 503'tür.
  test("OTP düşükken /health/ready 503 döner", async () => {
    axios.post.mockRejectedValue(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const res = await request(app).get("/health/ready").expect(503);
    expect(res.body.status).toBe("down");
    expect(res.body.issues).toContain("otp_unreachable");
  });
});

describe("hata sözleşmesi", () => {
  test("bilinmeyen yol 404 + {error, path}", async () => {
    const res = await request(app).get("/yok-boyle-bir-uc").expect(404);
    expect(res.body).toEqual({ error: "Bilinmeyen uç nokta.", path: "/yok-boyle-bir-uc" });
  });

  // İstemci için fark önemli: 502 "tekrar dene", 500 "denemenin faydası yok".
  test("dış kaynak tükendiğinde 502 + {error, detail}", async () => {
    const fs = require("fs");
    jest.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("ENOENT"); });
    axios.get.mockRejectedValue(new Error("overpass down"));
    const res = await request(app).get("/parking/osm").expect(502);
    expect(res.body).toHaveProperty("error");
    expect(res.body).toHaveProperty("detail");
  });
});
