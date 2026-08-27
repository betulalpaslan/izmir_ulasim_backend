const {
  safeFloat,
  buildTransitPreferences,
  buildModesInput,
} = require("../services/OtpService");

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
    expect(buildTransitPreferences(["FERRY", "BUS", "TRAM"]))
      .toEqual([{ mode: "BUS" }, { mode: "TRAM" }, { mode: "FERRY" }]);
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
  // noktaları (2026-08 ölçümünde 87 tane). Ayrı bir feed yoktur ve
  // gerekmez — bkz. router-config.json.
  test("bicycle + PARK: bisikleti park et, toplu taşımaya bin", () => {
    const out = buildModesInput("bicycle", "PARK", TRANSIT);
    expect(out.transit.access).toEqual(["BICYCLE_PARKING"]);
    expect(out.direct).toBeUndefined();
  });

  test("bicycle + RENT: BİSİM hem doğrudan hem erişim/çıkışta kullanılır", () => {
    const out = buildModesInput("bicycle", "RENT", TRANSIT);
    expect(out.direct).toEqual(["BICYCLE_RENTAL", "WALK"]);
    expect(out.transit.access).toEqual(["BICYCLE_RENTAL", "WALK"]);
    expect(out.transit.egress).toEqual(["BICYCLE_RENTAL", "WALK"]);
  });

  test("bicycle (bikeType yok): kendi bisikletiyle doğrudan gidiş", () => {
    const out = buildModesInput("bicycle", null, TRANSIT);
    expect(out.direct).toEqual(["BICYCLE"]);
    expect(out.transit.access).toEqual(["WALK"]);
  });
});

// NOT: extractCriteria ve rankWithTopsis testleri, o fonksiyonlarla birlikte
// kaldırıldı. Güzergâh sıralaması artık yalnızca uygulamada yapılıyor
// (izmir_ulasim/utils/routeScoring.js) ve orada test ediliyor.
