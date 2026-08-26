const {
  safeFloat,
  buildTransitPreferences,
  buildModesInput,
  extractCriteria,
  rankWithTopsis,
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

  // DİKKAT: BICYCLE_PARKING erişimi, OTP'nin bisiklet park yeri olarak
  // bildiği noktaları kullanır. Şu anki router-config.json'da o feed
  // (izmir-pr-bike) /parking/feed'i, yani İZELMAN'ın ARABA otoparklarını
  // gösteriyor — bisiklet bu yüzden bir araba otoparkına park ediliyor.
  // Test mevcut davranışı sabitler; feed düzeltilince bu yorum kalkmalı.
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

const leg = (mode, duration) => ({ mode, duration });

describe("extractCriteria", () => {
  test("süreleri toplar, yürüyüşü ayrıca sayar", () => {
    const it = { legs: [leg("WALK", 300), leg("BUS", 900), leg("WALK", 120)] };
    expect(extractCriteria(it)).toEqual({ totalDuration: 1320, walkDuration: 420, transfers: 0 });
  });

  test("aktarma = toplu taşıma bacağı sayısı - 1", () => {
    const it = { legs: [leg("WALK", 60), leg("BUS", 600), leg("TRAM", 400), leg("SUBWAY", 300)] };
    expect(extractCriteria(it).transfers).toBe(2);
  });

  // Bisiklet ve araba bacakları aktarma sayılmaz; yalnızca toplu taşıma sayılır.
  test("bisiklet/araba bacakları aktarma üretmez", () => {
    const it = { legs: [leg("BICYCLE_RENTAL", 400), leg("CAR", 300), leg("BICYCLE", 200)] };
    expect(extractCriteria(it).transfers).toBe(0);
  });

  test("bacaksız güzergâh sıfırlanır, çökmez", () => {
    expect(extractCriteria({})).toEqual({ totalDuration: 0, walkDuration: 0, transfers: 0 });
  });
});

describe("rankWithTopsis", () => {
  test("tek ya da sıfır güzergâhta liste olduğu gibi döner", () => {
    const bir = [{ legs: [leg("BUS", 600)] }];
    expect(rankWithTopsis(bir)).toBe(bir);
    expect(rankWithTopsis([])).toEqual([]);
  });

  test("her kritere göre daha iyi olan güzergâh başa gelir", () => {
    const iyi  = { id: "iyi",  legs: [leg("WALK", 120), leg("BUS", 600)] };
    const kotu = { id: "kotu", legs: [leg("WALK", 900), leg("BUS", 900), leg("TRAM", 600)] };
    expect(rankWithTopsis([kotu, iyi])[0].id).toBe("iyi");
  });

  test("girdiyi bozmaz, yeni sıralı dizi döndürür", () => {
    const a = { id: "a", legs: [leg("WALK", 100), leg("BUS", 500)] };
    const b = { id: "b", legs: [leg("WALK", 800), leg("BUS", 900)] };
    const girdi = [b, a];
    const cikti = rankWithTopsis(girdi);
    expect(girdi.map((x) => x.id)).toEqual(["b", "a"]);
    expect(cikti).toHaveLength(2);
    expect(cikti).toEqual(expect.arrayContaining([a, b]));
  });

  // Tüm güzergâhlar aynıysa normalizasyonda 0'a bölme riski var.
  test("özdeş güzergâhlarda NaN üretmez", () => {
    const it = { legs: [leg("BUS", 600)] };
    const out = rankWithTopsis([{ ...it }, { ...it }]);
    expect(out).toHaveLength(2);
    expect(out.every(Boolean)).toBe(true);
  });
});
