jest.mock("axios");
const axios = require("axios");
const { searchAddress, fetchPhoton, asciiye, tekrarlariEle, GEOCODE_BBOX, MIN_UZUNLUK } = require("../services/GeocodingService");

const photonYanit = (ozellikler) => ({
  data: {
    features: ozellikler.map((p, i) => ({
      properties: { osm_id: 1000 + i, ...p },
      geometry: { coordinates: [p.lon ?? 27.1 + i / 100, p.lat ?? 38.4 + i / 100] },
    })),
  },
});

beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe("asciiye — Türkçe karakter katlaması", () => {
  // Photon'un indeksi ASCII'ye katlanmış: "güzel" HİÇ sonuç döndürmüyor,
  // "guzel" Güzelbahçe/Güzelyalı/Güzelyurt'u buluyor. Türkçe klavyeyle yazan
  // kullanıcı bu yüzden boş liste görüyordu.
  test("altı Türkçe harfi de karşılığına çevirir", () => {
    expect(asciiye("güzelbahçe")).toBe("guzelbahce");
    expect(asciiye("çiğli")).toBe("cigli");
    expect(asciiye("Şirinyer")).toBe("Sirinyer");
    expect(asciiye("İzmir")).toBe("Izmir");
    expect(asciiye("Ödemiş")).toBe("Odemis");
    expect(asciiye("ılıca")).toBe("ilica");
  });

  test("ASCII metni bozmaz", () => {
    expect(asciiye("konak")).toBe("konak");
    expect(asciiye("Bornova 1")).toBe("Bornova 1");
  });
});

describe("fetchPhoton", () => {
  test("sorgu ASCII'ye çevrilerek gönderilir", async () => {
    axios.get.mockResolvedValue(photonYanit([{ name: "Güzelbahçe", type: "city" }]));
    await fetchPhoton("güzelbahçe");
    expect(decodeURIComponent(axios.get.mock.calls[0][0])).toContain("q=guzelbahce");
  });

  // lang parametresi GÖNDERİLMEMELİ: Photon yalnızca default/de/en/fr
  // destekler, "lang=tr" 400 döndürür. Uygulama tam olarak bunu yapıyordu,
  // yani Photon hiç çalışmıyor ve her arama sessizce Nominatim'e düşüyordu.
  test("lang parametresi gönderilmez", async () => {
    axios.get.mockResolvedValue(photonYanit([]));
    await fetchPhoton("konak");
    expect(axios.get.mock.calls[0][0]).not.toContain("lang=");
  });

  test("bbox Photon konvansiyonunda: batı,güney,doğu,kuzey", async () => {
    axios.get.mockResolvedValue(photonYanit([]));
    await fetchPhoton("konak");
    const url = decodeURIComponent(axios.get.mock.calls[0][0]);
    expect(url).toContain(`bbox=${GEOCODE_BBOX.bati},${GEOCODE_BBOX.guney},${GEOCODE_BBOX.dogu},${GEOCODE_BBOX.kuzey}`);
    // Overpass'ın kutusu güney,batı,kuzey,doğu sırasındadır — karıştırılırsa
    // arama İzmir yerine bambaşka bir kutuya kısıtlanır.
    expect(GEOCODE_BBOX.bati).toBeLessThan(GEOCODE_BBOX.dogu);
    expect(GEOCODE_BBOX.guney).toBeLessThan(GEOCODE_BBOX.kuzey);
  });

  // "als" yazan kullanıcı Alsancak semtini arıyordur, Alsancak Gar'ın
  // çatı poligonunu değil.
  test("yerleşim yerleri bina/sokak kayıtlarının önüne geçer", async () => {
    axios.get.mockResolvedValue(photonYanit([
      { name: "Alsancak Gar", type: "house", lat: 38.44, lon: 27.15 },
      { name: "Alsancak Tüneli", type: "street", lat: 38.45, lon: 27.16 },
      { name: "Alsancak", type: "district", lat: 38.43, lon: 27.14 },
    ]));
    const r = await fetchPhoton("als");
    expect(r[0].display_name).toContain("Alsancak");
    expect(r[0].display_name).not.toContain("Gar");
    expect(r[1].display_name).toContain("Tüneli");  // street, house'un önünde
    expect(r[2].display_name).toContain("Gar");     // house en sonda
  });

  test("iç sıralama alanı dışarı sızmaz", async () => {
    axios.get.mockResolvedValue(photonYanit([{ name: "Konak", type: "city" }]));
    expect(await fetchPhoton("konak")).toEqual([
      expect.not.objectContaining({ _sira: expect.anything() }),
    ]);
  });
});

describe("tekrarlariEle", () => {
  // Aynı yer OSM'de birden çok kayıtla durur (station + tram_stop + building)
  // ve altı satırlık listeyi tek başına doldurur.
  test("~200 m yakınlıktaki kayıtlar tek sonuç sayılır", () => {
    const r = tekrarlariEle([
      { display_name: "Alsancak Gar", lat: "38.4400", lon: "27.1500" },
      { display_name: "Alsancak Gar (tram)", lat: "38.4401", lon: "27.1501" },
      { display_name: "Konak", lat: "38.4187", lon: "27.1283" },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].display_name).toBe("Alsancak Gar"); // ilk gelen, yani en öncelikli tür kalır
  });

  test("koordinatı okunamayan kayıt atılır", () => {
    expect(tekrarlariEle([{ lat: "abc", lon: "27.1" }, { lat: "38.4", lon: "27.1" }])).toHaveLength(1);
  });
});

describe("searchAddress", () => {
  test("iki harf yeter — 'ko' aranır", async () => {
    expect(MIN_UZUNLUK).toBe(2);
    axios.get.mockResolvedValue(photonYanit([{ name: "Konak", type: "city" }]));
    expect(await searchAddress("ko")).toHaveLength(1);
  });

  test("tek harf ağa hiç çıkmaz", async () => {
    expect(await searchAddress("k")).toEqual([]);
    expect(await searchAddress("")).toEqual([]);
    expect(await searchAddress(null)).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test("aynı sorgu ikinci kez ağa çıkmaz (cache)", async () => {
    axios.get.mockResolvedValue(photonYanit([{ name: "Bornova", type: "city" }]));
    await searchAddress("bornova xyz");
    await searchAddress("BORNOVA XYZ");   // büyük/küçük harf aynı anahtar
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  // Nominatim'in hız sınırı IP başınadır ve backend'de tek IP var; bu yüzden
  // yalnızca Photon boş dönerse çağrılır.
  test("Photon sonuç verirse Nominatim çağrılmaz", async () => {
    axios.get.mockResolvedValue(photonYanit([{ name: "Karşıyaka", type: "city" }]));
    await searchAddress("karsiyaka test1");
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toContain("photon");
  });

  test("Photon boş dönerse Nominatim denenir", async () => {
    axios.get
      .mockResolvedValueOnce(photonYanit([]))
      .mockResolvedValueOnce({ data: [{ place_id: 9, lat: "38.4", lon: "27.1", display_name: "Konak, İzmir" }] });
    const r = await searchAddress("konak test2");
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(axios.get.mock.calls[1][0]).toContain("nominatim");
    expect(r[0].place_id).toBe("nm_9");
  });

  // Adres araması çalışmasa bile kullanıcı haritadan nokta seçerek rota kurabilir.
  test("iki kaynak da düşerse boş liste döner, hata fırlatılmaz", async () => {
    axios.get.mockRejectedValue(new Error("ağ yok"));
    await expect(searchAddress("konak test3")).resolves.toEqual([]);
  });
});
