jest.mock("axios");
const axios = require("axios");
const {
  safeFloat,
  buildTransitPreferences,
  buildModesInput,
  buildModesInputs,
  planRoute,
} = require("../services/OtpService");
const config = require("../config");

const TRANSIT = [{ mode: "BUS" }];

describe("safeFloat", () => {
  test("geçerli sayıyı çevirir", () => {
    expect(safeFloat("38.42")).toBe(38.42);
    expect(safeFloat(27)).toBe(27);
  });

  test("çevrilemeyen değerde null döner — 0 değil", () => {
    expect(safeFloat("abc")).toBeNull();
    expect(safeFloat(undefined)).toBeNull();
    expect(safeFloat(null)).toBeNull();
    expect(safeFloat(Infinity)).toBeNull();
  });
});

describe("buildTransitPreferences", () => {
  test("seçim yoksa dört mod birden açılır", () => {
    expect(buildTransitPreferences([])).toEqual([{ mode: "BUS" }, { mode: "RAIL" }, { mode: "TRAM" }, { mode: "SUBWAY" }]);
    expect(buildTransitPreferences(undefined)).toHaveLength(4);
  });

  // RAIL seçimi metroyu da kapsar: İzmir'de İZBAN (RAIL) ve metro (SUBWAY)
  // kullanıcı için tek kategori.
  test("RAIL seçilince SUBWAY de eklenir", () => {
    expect(buildTransitPreferences(["RAIL"])).toEqual([{ mode: "RAIL" }, { mode: "SUBWAY" }]);
  });

  test("tanınmayan mod listesi varsayılana düşer", () => {
    expect(buildTransitPreferences(["UÇAK"])).toHaveLength(4);
  });

  test("seçilen modların sırası sabittir", () => {
    expect(buildTransitPreferences(["TRAM", "BUS"]))
      .toEqual([{ mode: "BUS" }, { mode: "TRAM" }]);
  });

  // İzmir feed'inde vapur (route_type=4) hiç yok; FERRY istense bile
  // mod listesine girmemeli, yoksa OTP karşılığı olmayan bir mod arar.
  test("FERRY yok sayılır", () => {
    expect(buildTransitPreferences(["FERRY"])).toHaveLength(4);   // varsayılana düşer
    expect(buildTransitPreferences(["BUS", "FERRY"])).toEqual([{ mode: "BUS" }]);
  });
});

describe("buildModesInput", () => {
  test("varsayılan profil: yürü + toplu taşıma", () => {
    expect(buildModesInput("transit", null, TRANSIT)).toEqual({
      transit: { access: ["WALK"], egress: ["WALK"], transfer: ["WALK"], transit: TRANSIT },
    });
  });

  test("car profili yalnızca doğrudan sürüş üretir", () => {
    expect(buildModesInput("car", null, TRANSIT)).toEqual({ direct: ["CAR"] });
  });

  test("park_and_ride: arabayla eriş, yürüyerek çık", () => {
    const out = buildModesInput("park_and_ride", null, TRANSIT);
    expect(out.transit.access).toEqual(["CAR_PARKING"]);
    expect(out.transit.egress).toEqual(["WALK"]);
    expect(out.direct).toBeUndefined();
  });

  // BICYCLE_PARKING erişimi, OTP'nin bisiklet park yeri olarak bildiği
  // noktaları kullanır: OSM'den graph'a giren amenity=bicycle_parking
  // noktaları ve /parking/bike-feed'in bildirdiği raylı sistem istasyonları
  // (bkz. ParkingService.bisikletParkYerleri).
  test("bicycle + PARK: bisikleti park et, toplu taşımaya bin", () => {
    const out = buildModesInput("bicycle", "PARK", TRANSIT);
    expect(out.transit.access).toEqual(["BICYCLE_PARKING"]);
    expect(out.direct).toBeUndefined();
  });

  // WALK, BICYCLE_RENTAL'ın yanında ZORUNLU: onsuz OTP "BIKE_RENTAL needs to
  // be combined with WALK mode for the same leg" hatası verir ve mod hiç
  // sonuç döndürmez. Ölçüldü — kaldırma denendi, mod tamamen sustu.
  test("bicycle + RENT: BİSİM erişim/çıkışta, WALK ile birlikte", () => {
    const out = buildModesInput("bicycle", "RENT", TRANSIT);
    expect(out.transit.access).toEqual(["BICYCLE_RENTAL", "WALK"]);
    expect(out.transit.egress).toEqual(["BICYCLE_RENTAL", "WALK"]);
  });

  // Bisiklet modlarının İKİSİ DE aktarmalıdır. Tek başına bisiklet sürüşü
  // ölçümde kullanıcıya işe yaramaz tek bir kart üretiyordu (Narlıdere →
  // Çiğli: 137 dk / 33.5 km kesintisiz sürüş) ve aktarmalı adayları listeden
  // itiyordu — bu yüzden `direct` hiçbir bisiklet modunda istenmiyor.
  test("hiçbir bisiklet modu doğrudan sürüş istemez", () => {
    expect(buildModesInput("bicycle", "PARK", TRANSIT).direct).toBeUndefined();
    expect(buildModesInput("bicycle", "RENT", TRANSIT).direct).toBeUndefined();
    expect(buildModesInput("bicycle", null, TRANSIT).direct).toBeUndefined();
  });

  // Eski bir istemci bikeType göndermeyebilir. O zaman kaldırılmış olan
  // "baştan sona sürüş" modu değil, PARK karşılığı verilir — uygulamadaki
  // resolveProfileKey de aynı eşlemeyi yapar.
  test("bicycle (bikeType yok): PARK varsayılır", () => {
    expect(buildModesInput("bicycle", null, TRANSIT))
      .toEqual(buildModesInput("bicycle", "PARK", TRANSIT));
  });
});

// NOT: extractCriteria ve rankWithTopsis testleri, o fonksiyonlarla birlikte
// kaldırıldı. Güzergâh sıralaması artık yalnızca uygulamada yapılıyor
// (izmir_ulasim/utils/routeScoring.js) ve orada test ediliyor.

// ─── Kendi bisikletinde iki güzergâh tipi ──────────────────────────────
// Bisiklet İzmir'de metroya, tramvaya ve İZBAN'a bindirilebiliyor; yani
// istasyonda bırakmak tek seçenek değil. OTP ikisini AYNI erişim listesinde
// kabul etmiyor ("Bicycle can't be combined with other modes for the same
// leg: [BIKE, BIKE_TO_PARK]"), bu yüzden iki ayrı sorgu atılıyor.
describe("buildModesInputs", () => {
  test("kendi bisikleti: hem taşıma hem park sorgusu üretilir", () => {
    const cikti = buildModesInputs("bicycle", "PARK", TRANSIT);
    expect(cikti).toHaveLength(2);
    expect(cikti[0].transit.access).toEqual(["BICYCLE"]);
    expect(cikti[1].transit.access).toEqual(["BICYCLE_PARKING"]);
  });

  // Bisikletle bindiysen inerken ve aktarmada da bisiklet sende. Bunlar
  // BICYCLE olmazsa OTP o güzergâh tipini hiç üretmez.
  test("taşıma sorgusunda çıkış ve aktarma da bisikletli", () => {
    const [tasima] = buildModesInputs("bicycle", "PARK", TRANSIT);
    expect(tasima.transit.egress).toEqual(["BICYCLE"]);
    expect(tasima.transit.transfer).toEqual(["BICYCLE"]);
  });

  test("bikeType yoksa da iki sorgu üretilir", () => {
    expect(buildModesInputs("bicycle", null, TRANSIT)).toHaveLength(2);
  });

  test("BİSİM ve bisiklet dışı profiller tek sorgu", () => {
    expect(buildModesInputs("bicycle", "RENT", TRANSIT)).toHaveLength(1);
    expect(buildModesInputs("transit", null, TRANSIT)).toHaveLength(1);
    expect(buildModesInputs("park_and_ride", null, TRANSIT)).toHaveLength(1);
  });
});

// ─── Kiralık bisiklet etiketleme ───────────────────────────────────────
// OTP kiralık bisikleti de "BICYCLE" diye bildirir. Kiralık olduğu yalnız
// bacağın uçlarındaki alandan anlaşılır ve BU ALAN MODELE GÖRE DEĞİŞİR:
// istasyonlu ağda `vehicleRentalStation`, dockless ağda `rentalVehicle`.
// BİSİM dockless'a geçince ikincisi devreye girdi; yalnız birincisine
// bakıldığında etiketleme sessizce başarısız oluyor ve uygulamanın BİSİM
// süzgeci tüm güzergâhları eliyordu.
describe("kiralık bisiklet etiketleme", () => {
  const KONUM = { fromLat: 38.41, fromLon: 27.12, toLat: 38.44, toLon: 27.15 };
  const yanit = (legs) => ({
    data: { data: { planConnection: { edges: [{ node: { legs } }], routingErrors: [] } } },
  });
  const modlar = async (legs) => {
    axios.post.mockResolvedValueOnce(yanit(legs));
    const r = await planRoute({ ...KONUM, profile: "bicycle", bikeType: "RENT" });
    return r.itineraries[0].legs.map((l) => l.mode);
  };

  beforeEach(() => jest.clearAllMocks());

  test("serbest araç (dockless) BICYCLE_RENTAL olarak etiketlenir", async () => {
    expect(await modlar([
      { mode: "BICYCLE", duration: 900, distance: 4000,
        from: { rentalVehicle: { vehicleId: "bisim-izmir:bisim-38.41870-27.12830" } }, to: {} },
    ])).toEqual(["BICYCLE_RENTAL"]);
  });

  test("istasyonlu ağ da etiketlenmeye devam eder", async () => {
    expect(await modlar([
      { mode: "BICYCLE", duration: 900, distance: 4000,
        from: { vehicleRentalStation: { stationId: "konak-iskele" } }, to: {} },
    ])).toEqual(["BICYCLE_RENTAL"]);
  });

  test("kendi bisikleti etiketlenmez", async () => {
    expect(await modlar([
      { mode: "BICYCLE", duration: 900, distance: 4000, from: {}, to: {} },
    ])).toEqual(["BICYCLE"]);
  });
});

// ─── İki sorgunun birleştirilmesi ──────────────────────────────────────
// Kendi bisikletinde iki ayrı OTP sorgusu atılır (taşıma + park) ve
// sonuçlar birleştirilir. Buradaki testler o birleştirmenin kenarlarını
// tutuyor.
//
// NOT: Burada bir zamanlar "bisikletsiz yedek" testleri vardı. O mekanizma
// kaldırıldı (bkz. services/OtpService.js): bisiklet hiçbir güzergâhta işe
// yaramadığında backend yürüyüş erişimiyle yeniden sorup BİSİKLETSİZ
// güzergâhlar döndürüyordu. Ölçümü doğruydu (282 m'lik bisiklet bacağı
// yolculuğu 6.2 dakika uzatıyordu) ama çözümü yanlış yerdeydi: kullanıcı
// "Bisikletim + Aktarma" seçmişken içinde bisiklet olmayan bir liste
// alıyordu. Karar artık tek yerde — uygulamanın MOD_AMACI süzgeci — ve
// mod boş kalırsa sebebi yazılıyor.
describe("bisiklet sorgularının birleştirilmesi", () => {
  const KONUM = { fromLat: 38.41, fromLon: 27.12, toLat: 38.47, toLon: 27.22 };
  const yanit = (legs) => ({
    data: { data: { planConnection: { edges: [{ node: { legs } }], routingErrors: [] } } },
  });
  const bos = { data: { data: { planConnection: { edges: [], routingErrors: [] } } } };

  const tasinan = [
    { mode: "BICYCLE", duration: 300, distance: 2000 },
    { mode: "SUBWAY", duration: 1200, distance: 9000 },
    { mode: "BICYCLE", duration: 600, distance: 3000 },
  ];
  const parkli = [
    { mode: "BICYCLE", duration: 300, distance: 2000 },
    { mode: "SUBWAY", duration: 1200, distance: 9000 },
    { mode: "WALK", duration: 400, distance: 500 },
  ];

  beforeEach(() => jest.clearAllMocks());

  // Kendi bisikletinde ÜÇ istek gider: taşıma + park + bisikletsiz taban
  // çizgisi. Üçüncüsünün sonucu listeye girmez, yalnız ölçü olarak kullanılır.
  test("iki sorgunun sonucu birleşir", async () => {
    axios.post
      .mockResolvedValueOnce(yanit(tasinan))
      .mockResolvedValueOnce(yanit(parkli))
      .mockResolvedValueOnce(bos);
    const r = await planRoute({ ...KONUM, profile: "bicycle", bikeType: "PARK" });
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(r.itineraries).toHaveLength(2);
  });

  // Aynı güzergâh iki sorgudan da dönebilir (ör. bisiklet hiç kullanılmayan
  // düz transit rotası); kullanıcı aynı kartı iki kez görmemeli.
  test("iki sorgudan gelen aynı güzergâh tekilleşir", async () => {
    axios.post
      .mockResolvedValueOnce(yanit(parkli))
      .mockResolvedValueOnce(yanit(parkli))
      .mockResolvedValueOnce(bos);
    const r = await planRoute({ ...KONUM, profile: "bicycle", bikeType: "PARK" });
    expect(r.itineraries).toHaveLength(1);
  });

  // Tek sorgu düştüğünde tüm isteği başarısız saymak, çalışan seçeneği de
  // kaybetmek olurdu.
  test("sorgulardan biri düşerse diğerinin sonucu döner", async () => {
    axios.post
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(yanit(parkli))
      .mockResolvedValueOnce(bos);
    const r = await planRoute({ ...KONUM, profile: "bicycle", bikeType: "PARK" });
    expect(r.itineraries).toHaveLength(1);
  });

  test("iki sorgu da düşerse hata yukarı taşınır", async () => {
    axios.post
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"));
    await expect(planRoute({ ...KONUM, profile: "bicycle", bikeType: "PARK" }))
      .rejects.toThrow("timeout");
  });

  // ─── Bisikletsiz taban çizgisi ──
  // "Bu bisiklet işe yarıyor mu" sorusunun dürüst cevabı ancak bisikletsiz
  // alternatifle karşılaştırarak verilebilir (ölçüm: 282 m'lik bacak
  // yolculuğu 6.2 dakika UZATIYORDU). Sonuç kullanıcıya gösterilmez; yalnız
  // en iyi süresi her güzergâha iliştirilir ve eleme kararını gösterim
  // katmanı verir (MOD_AMACI.bicycle_park).
  test("bisiklet profilinde taban çizgisi sorgusu yapılır ve güzergâha iliştirilir", async () => {
    const yuruyusluTaban = [
      { mode: "WALK", duration: 600, distance: 800 },
      { mode: "SUBWAY", duration: 1800, distance: 12000 },
    ];
    axios.post
      .mockResolvedValueOnce(yanit(tasinan))
      .mockResolvedValueOnce(bos)
      .mockResolvedValueOnce(yanit(yuruyusluTaban));

    const r = await planRoute({ ...KONUM, profile: "bicycle", bikeType: "PARK" });

    expect(axios.post).toHaveBeenCalledTimes(3);
    // Taban sorgusu bisikletsiz erişim istemeli.
    expect(axios.post.mock.calls[2][1].variables.modes.transit.access).toEqual(["WALK"]);
    expect(r.bisikletsizEnIyiSn).toBe(2400);
    // ...ve güzergâhlara iliştirilmeli: puanlama katmanı oradan okuyor.
    expect(r.itineraries[0].bisikletsizEnIyiSn).toBe(2400);
    // Taban güzergâhları LİSTEYE GİRMEZ — mod saflığı.
    expect(r.itineraries).toHaveLength(1);
  });

  test("taban sorgusu düşerse istek yine başarılı olur, taban null kalır", async () => {
    axios.post
      .mockResolvedValueOnce(yanit(tasinan))
      .mockResolvedValueOnce(bos)
      .mockRejectedValueOnce(new Error("timeout"));

    const r = await planRoute({ ...KONUM, profile: "bicycle", bikeType: "PARK" });
    expect(r.bisikletsizEnIyiSn).toBeNull();
    expect(r.itineraries).toHaveLength(1);
  });

  // Bisiklet dışı profillerde tek sorgu atılır; ikinci sorgu boşuna
  // OTP yükü demektir.
  test("bisiklet dışı profillerde tek sorgu atılır", async () => {
    axios.post.mockResolvedValueOnce(yanit([{ mode: "WALK", duration: 280, distance: 350 }]));
    await planRoute({ ...KONUM, profile: "transit" });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  // Artık HİÇBİR koşulda bisikletsiz yedek sorgusu atılmaz: bisiklet
  // modunda üçüncü bir istek görülürse yedek geri gelmiş demektir.
  // Bisiklet kısa olsa bile YÜRÜYÜŞLÜ GÜZERGÂH DÖNMEZ. Eski "bisikletsiz
  // yedek" burada listeyi değiştiriyordu; artık yalnız taban çizgisi
  // ölçülür, liste bisikletli kalır.
  test("bisiklet kısa olsa bile listeye yürüyüşlü güzergâh girmez", async () => {
    const cokKisa = [
      { mode: "BICYCLE", duration: 60, distance: 282 },
      { mode: "SUBWAY", duration: 1200, distance: 9000 },
    ];
    axios.post
      .mockResolvedValueOnce(yanit(cokKisa))
      .mockResolvedValueOnce(bos)
      .mockResolvedValueOnce(yanit([{ mode: "WALK", duration: 900, distance: 1100 }]));
    const r = await planRoute({ ...KONUM, profile: "bicycle", bikeType: "PARK" });
    expect(r.itineraries).toHaveLength(1);
    expect(r.itineraries[0].legs.some((l) => l.mode === "BICYCLE")).toBe(true);
    expect(r).not.toHaveProperty("bisikletsizYedek");
  });
});
