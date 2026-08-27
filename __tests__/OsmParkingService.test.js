const { toOsmParking, toBicycleParking, OTOPARK_SORGUSU, BISIKLET_PARK_SORGUSU } = require("../services/OsmParkingService");

describe("toOsmParking", () => {
  test("node'da koordinat doğrudan lat/lon'dan alınır", () => {
    const out = toOsmParking({ id: 1, lat: 38.42, lon: 27.14, tags: { name: "Konak Otopark", parking: "underground", fee: "yes", capacity: "250" } });
    expect(out).toEqual({ id: 1, name: "Konak Otopark", lat: 38.42, lon: 27.14, type: "underground", fee: true, capacity: 250 });
  });

  // way'lerin kendi lat/lon'u yoktur; Overpass `out center` ile merkez verir.
  // Bu okunmazsa way'ler koordinatsız kalır ve süzgeçte elenirdi — yani
  // katlı otoparkların yarısı haritadan kaybolurdu.
  test("way'de koordinat center'dan alınır", () => {
    const out = toOsmParking({ id: 2, center: { lat: 38.43, lon: 27.15 }, tags: { parking: "multi-storey" } });
    expect(out.lat).toBe(38.43);
    expect(out.lon).toBe(27.15);
  });

  test("fee üç durumlu: yes/no/bilinmiyor", () => {
    expect(toOsmParking({ id: 1, lat: 1, lon: 1, tags: { fee: "yes" } }).fee).toBe(true);
    expect(toOsmParking({ id: 1, lat: 1, lon: 1, tags: { fee: "no" } }).fee).toBe(false);
    expect(toOsmParking({ id: 1, lat: 1, lon: 1, tags: {} }).fee).toBeNull();
    // "customers" gibi tanımadığımız değerler de "bilinmiyor" sayılır
    expect(toOsmParking({ id: 1, lat: 1, lon: 1, tags: { fee: "customers" } }).fee).toBeNull();
  });

  test("kapasite yoksa null, uydurulmaz", () => {
    expect(toOsmParking({ id: 1, lat: 1, lon: 1, tags: {} }).capacity).toBeNull();
    expect(toOsmParking({ id: 1, lat: 1, lon: 1, tags: { capacity: "yes" } }).capacity).toBeNull();
  });

  test("etiketsiz kayıt çökmez, tip surface varsayılır", () => {
    expect(toOsmParking({ id: 3, lat: 1, lon: 1 })).toMatchObject({ name: null, type: "surface" });
  });
});

describe("toBicycleParking", () => {
  test("kapasite ve üstü kapalılık taşınır", () => {
    expect(toBicycleParking({ id: 5, lat: 38.4, lon: 27.1, tags: { capacity: "12", covered: "yes" } }))
      .toEqual({ id: 5, lat: 38.4, lon: 27.1, capacity: 12, covered: true });
  });

  test("çoğu bisiklet parkında etiket yok — null kalır", () => {
    expect(toBicycleParking({ id: 6, lat: 38.4, lon: 27.1, tags: {} }))
      .toEqual({ id: 6, lat: 38.4, lon: 27.1, capacity: null, covered: null });
  });
});

describe("sorgular", () => {
  test("otopark sorgusu isimsiz yüzey otoparklarını dışarıda bırakır", () => {
    // [parking=surface][name] — isim şartı bilinçli: OSM'de her market önü
    // işaretli ve isimsizleri haritayı okunmaz hâle getiriyor.
    expect(OTOPARK_SORGUSU).toContain("[parking=surface][name]");
    expect(OTOPARK_SORGUSU).toContain("out center;");   // way'ler için şart
    expect(OTOPARK_SORGUSU).toContain("38.2,26.8,38.6,27.5");
  });

  test("bisiklet park sorgusu doğru etiketi arar", () => {
    expect(BISIKLET_PARK_SORGUSU).toContain("node[amenity=bicycle_parking]");
  });
});
