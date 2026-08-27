jest.mock("axios");
const request = require("supertest");
const { UCLAR, OTP_PARKAPI, GBFS, SAGLIK } = require("../contract");

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
  test("GET /bisim/stations", async () => {
    const st = await sozlesmeyiDogrula("/bisim/stations", UCLAR["GET /bisim/stations"]);
    expect(st.bikes).toBeNull();          // doluluk uydurulmaz
    expect(typeof st.lat).toBe("number");
  });

  test("GET /parking/stations", async () => {
    const st = await sozlesmeyiDogrula("/parking/stations", UCLAR["GET /parking/stations"]);
    expect(st).not.toHaveProperty("lng");  // İZELMAN'ın lng'si dışarı sızmaz
    expect(st.lon).toBe(27.12);
  });

  test("GET /parking/otp-lots", async () => {
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

  test("GBFS station_information", async () => {
    const res = await request(app).get("/bisim/gbfs/station_information").expect(200);
    const st = res.body.data.stations[0];
    for (const alan of GBFS.istasyonAlanlari) expect(Object.keys(st)).toContain(alan);
    expect(typeof st.station_id).toBe("string");
  });

  test("GBFS kapasite bilinmiyorsa alan hiç gönderilmez", async () => {
    axios.get.mockImplementation((url) =>
      url.includes("bicycle_rental")
        ? Promise.resolve({ data: { elements: [{ type: "node", id: 9, lat: 38.4, lon: 27.1, tags: { amenity: "bicycle_rental", operator: "BİSİM" } }] } })
        : axiosGetYonlendir(url));
    const res = await request(app).get("/bisim/gbfs/station_information").expect(200);
    expect(res.body.data.stations[0]).not.toHaveProperty("capacity");
  });

  test("GBFS discovery üç alt feed'i listeler", async () => {
    const res = await request(app).get("/bisim/gbfs").expect(200);
    const adlar = res.body.data.en.feeds.map((f) => f.name);
    expect(adlar).toEqual(["system_information", "station_information", "station_status"]);
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
