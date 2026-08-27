jest.mock("axios");
jest.mock("fs");
const axios = require("axios");
const fs = require("fs");
const { createOverpassSource, OVERPASS_MIRRORS, IZMIR_BBOX } = require("../services/OverpassService");

const dugum = (id) => ({ type: "node", id, lat: 38.4, lon: 27.1, tags: {} });
const yanit = (ids) => ({ data: { elements: ids.map(dugum) } });

let uyariSpy;
beforeEach(() => {
  jest.clearAllMocks();
  uyariSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => uyariSpy.mockRestore());

const kaynakYap = (over = {}) =>
  createOverpassSource({ ad: "Test", query: "[out:json];node;out;", cacheFile: "/sahte/cache.json", ...over });

describe("mirror denemesi", () => {
  test("ilk mirror çalışırsa diğerlerine gidilmez", async () => {
    axios.get.mockResolvedValueOnce(yanit([1, 2]));
    const k = kaynakYap();
    expect(await k.fetch()).toHaveLength(2);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toContain(OVERPASS_MIRRORS[0]);
  });

  test("düşen mirror'dan sonra sıradaki denenir", async () => {
    axios.get
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(yanit([7]));
    const k = kaynakYap();
    expect(await k.fetch()).toHaveLength(1);
    expect(axios.get).toHaveBeenCalledTimes(3);
    expect(k.getStatus().source).toBe("overpass");
  });
});

describe("cache", () => {
  test("TTL içinde ikinci istek ağa çıkmaz", async () => {
    axios.get.mockResolvedValue(yanit([1]));
    const k = kaynakYap();
    await k.fetch();
    await k.fetch();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test("TTL dolunca yeniden çekilir", async () => {
    axios.get.mockResolvedValue(yanit([1]));
    const k = kaynakYap({ ttlMs: 0 });
    await k.fetch();
    await k.fetch();
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});

describe("başarısızlık davranışı", () => {
  // Tüm mirror'lar düştüğünde her istekte üçünü birden denemek, Overpass
  // yavaşken her isteğe 24 saniye ekler. Backoff bunu engeller.
  test("hepsi düşerse backoff'a girilir ve stale cache döner", async () => {
    axios.get.mockResolvedValueOnce(yanit([1, 2, 3]));
    const k = kaynakYap({ ttlMs: 0, backoffMs: 60000 });
    await k.fetch();

    axios.get.mockRejectedValue(new Error("down"));
    const ikinci = await k.fetch();
    expect(ikinci).toHaveLength(3);          // eski veri korundu
    expect(k.getStatus().stale).toBe(true);
    expect(k.getStatus().retryInSec).toBeGreaterThan(0);

    axios.get.mockClear();
    await k.fetch();
    expect(axios.get).not.toHaveBeenCalled(); // backoff sürüyor, ağa çıkılmaz
  });

  test("cache yokken disk yedeğine düşülür", async () => {
    axios.get.mockRejectedValue(new Error("down"));
    fs.readFileSync.mockReturnValue(JSON.stringify({ elements: [dugum(9), dugum(10)] }));
    const k = kaynakYap();
    expect(await k.fetch()).toHaveLength(2);
    expect(k.getStatus().source).toBe("build-cache");
  });

  // Sessizce boş liste dönmek "veri yok" ile "kaynak düştü"yü karıştırırdı.
  test("yedek de yoksa 502 statülü hata fırlatılır", async () => {
    axios.get.mockRejectedValue(new Error("down"));
    fs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const err = await kaynakYap().fetch().catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toContain("Test");
  });

  test("cacheFile verilmemişse diske hiç bakılmaz", async () => {
    axios.get.mockRejectedValue(new Error("down"));
    await expect(kaynakYap({ cacheFile: null }).fetch()).rejects.toThrow();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });
});

describe("getStatus ve peek", () => {
  test("hiç çekilmemişken boş durum döner", () => {
    const d = kaynakYap().getStatus();
    expect(d).toEqual({ source: null, ageSec: null, elements: null, stale: false, retryInSec: 0 });
  });

  // Sağlık ucu Overpass'ı tetiklememeli.
  test("peek ağa çıkmadan bellekteki veriyi verir", async () => {
    const k = kaynakYap();
    expect(k.peek()).toBeNull();
    axios.get.mockResolvedValue(yanit([1, 2]));
    await k.fetch();
    axios.get.mockClear();
    expect(k.peek()).toHaveLength(2);
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe("İzmir kutusu", () => {
  // Overpass sırası güney,batı,kuzey,doğu — Photon/Nominatim'inkinden farklı.
  test("kutu Overpass konvansiyonunda", () => {
    expect(IZMIR_BBOX).toBe("38.2,26.8,38.6,27.5");
    const [g, b, k, d] = IZMIR_BBOX.split(",").map(Number);
    expect(g).toBeLessThan(k);   // güney < kuzey
    expect(b).toBeLessThan(d);   // batı < doğu
  });
});
