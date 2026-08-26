const { isBisimOperator, getRawStations, mapToStation, parseCoord } = require("../services/BikeShareService");

const node = (over = {}) => ({
  id: 1001,
  lat: 38.4237,
  lon: 27.1428,
  tags: { amenity: "bicycle_rental", operator: "BİSİM", ref: "51", ...(over.tags || {}) },
  ...over,
});

describe("isBisimOperator", () => {
  // Türkçe İ harfi: "BİSİM".toLowerCase() → "bi̇sim" (araya birleşik nokta
  // girer) ve "bisim" ile eşleşmez. toLocaleLowerCase("tr") şarttır.
  // Bu satır bozulursa filtre TÜM istasyonları eler ve harita boş kalır.
  test("BİSİM ve Bisim aynı işletmeci sayılır", () => {
    expect(isBisimOperator({ operator: "BİSİM" })).toBe(true);
    expect(isBisimOperator({ operator: "Bisim" })).toBe(true);
    expect(isBisimOperator({ operator: "bisim" })).toBe(true);
  });

  test("başka işletmeciler elenir", () => {
    expect(isBisimOperator({ operator: "Nextbike" })).toBe(false);
    expect(isBisimOperator({})).toBe(false);
    expect(isBisimOperator(null)).toBe(false);
    expect(isBisimOperator(undefined)).toBe(false);
  });
});

describe("getRawStations", () => {
  test("yalnızca BİSİM işletmeli düğümleri bırakır", () => {
    const data = [node(), node({ id: 2, tags: { operator: "Nextbike" } })];
    expect(getRawStations(data).map((e) => e.id)).toEqual([1001]);
  });

  // was:amenity = artık mevcut olmayan istasyon. OSM kaldırılmış noktaları
  // silmek yerine bu önekle işaretler; süzülmezse harita kapanmış
  // istasyonları gösterir ve OTP oralara rota kurar.
  test("was:amenity işaretli kaldırılmış istasyonları eler", () => {
    const kaldirilmis = node({ id: 3, tags: { operator: "BİSİM", "was:amenity": "bicycle_rental" } });
    expect(getRawStations([node(), kaldirilmis]).map((e) => e.id)).toEqual([1001]);
  });

  test("dizi olmayan girdide boş liste döner", () => {
    expect(getRawStations(null)).toEqual([]);
    expect(getRawStations(undefined)).toEqual([]);
    expect(getRawStations({ elements: [] })).toEqual([]);
  });
});

describe("mapToStation", () => {
  test("OSM capacity etiketi varsa o kullanılır", () => {
    const st = mapToStation(node({ tags: { operator: "BİSİM", ref: "51", capacity: "24" } }));
    expect(st.capacity).toBe(24);
  });

  // Kapasite bilinmiyorsa null'dır. Uydurma bir sayı (eskiden 10) GBFS'te
  // gerçek gibi görünür ve kullanıcıya yanlış yuva sayısı gösterir.
  test("kapasite hiçbir kaynaktan bulunamazsa null olur, uydurulmaz", () => {
    const st = mapToStation(node({ id: 999999, tags: { operator: "BİSİM" } }));
    expect(st.capacity).toBeNull();
  });

  // BİSİM canlı verisi 2025-07-23'ten beri hiçbir kaynakta yayınlanmıyor.
  // null "bilinmiyor" demektir; 0 "boş istasyon" demek olurdu.
  test("bikes her zaman null — doluluk bilinmiyor", () => {
    expect(mapToStation(node()).bikes).toBeNull();
  });

  test("isim yoksa ref'ten üretilir", () => {
    expect(mapToStation(node({ tags: { operator: "BİSİM", ref: "51" } })).name).toBe("BİSİM 51");
    expect(mapToStation(node({ id: 7, tags: { operator: "BİSİM" } })).name).toBe("BİSİM 7");
    expect(mapToStation(node({ tags: { operator: "BİSİM", name: "Konak Meydanı" } })).name).toBe("Konak Meydanı");
  });

  test("koordinatlar lat/lon olarak taşınır", () => {
    const st = mapToStation(node());
    expect(st.lat).toBe(38.4237);
    expect(st.lon).toBe(27.1428);
  });
});

describe("parseCoord", () => {
  test("sayısal lat/lon varsa nesne döner", () => {
    expect(parseCoord({ lat: 38.4, lon: 27.1 })).toEqual({ lat: 38.4, lon: 27.1 });
  });

  test("eksik ya da metin koordinatta null döner", () => {
    expect(parseCoord({ lat: 38.4 })).toBeNull();
    expect(parseCoord({ lat: "38.4", lon: "27.1" })).toBeNull();
    expect(parseCoord({})).toBeNull();
  });
});
