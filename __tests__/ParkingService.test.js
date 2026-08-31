jest.mock("axios");
const axios = require("axios");
const {
  isParkAndRide, toOtpParking, toParkingStation, acikMi,
  enYakinEnvanterKaydi, isimSkoru, bisikletParkYerleri, rayliDuraklariUnut,
} = require("../services/ParkingService");

// İZELMAN'ın gerçek gövde biçiminden sadeleştirilmiş örnek: doluluğu OLAN lot.
const sensorluLot = {
  ufid: "NEDAP-TR-IZM-034",
  name: "34 Sabanci Kültür Merkezi",
  lat: 38.414551,
  lng: 27.122476,
  type: "OffStreet",
  isPaid: true,
  provider: "İZELMAN A.Ş",
  nonstop: true,
  occupancy: { total: { free: 16, occupied: 25 } },
  poi: { metroStation: "Konak" },
  rayliMesafeM: 120,
  rayliTip: "metro",
  rayliAd: "Konak",
  kaynak: "ckan+izelman",
};

// CKAN envanterinden gelen, sensörü OLMAYAN lot. Otoparkların çoğu böyle:
// 82 kaydın yalnız 14'ünde anlık doluluk var.
const envanterLot = {
  ufid: "CKAN-6ad4ad67-1",
  name: "ÇANKAYA KATLI",
  lat: 38.4189,
  lng: 27.1326,
  type: "OffStreet",
  kapasite: 1170,
  acilis: "00:00",
  kapanis: "24:00",
  provider: "İZELMAN A.Ş",
  isPaid: null,
  occupancy: null,
  rayliMesafeM: 210,
  rayliTip: "metro",
  rayliAd: "Çankaya",
  kaynak: "ckan",
};

describe("toOtpParking — OTP ParkAPI sözleşmesi", () => {
  // Bu testin varlık sebebi: alan adları OTP tarafından DAYATILIR ve bir kez
  // yanlış yazıldığında OTP hata vermeden sıfır otopark yükler. Eskiden gövde
  // {vehicleParkings:[{x, y, capacity, availability}]} biçimindeydi; ParkAPI
  // updater'ı bu alanların hiçbirini tanımadığı için otopark listesi sessizce
  // boş kalıyordu. Aşağıdaki isimler bu yüzden serbestçe değiştirilemez.
  test("ParkAPI'nin beklediği alan adlarını tam olarak üretir", () => {
    expect(toOtpParking(sensorluLot)).toEqual({
      id: "NEDAP-TR-IZM-034",
      name: "34 Sabanci Kültür Merkezi",
      coords: { lat: 38.414551, lng: 27.122476 },
      state: "open",
      total: 41,
      free: 16,
    });
  });

  test("koordinat coords nesnesinin içindedir, x/y değil", () => {
    const out = toOtpParking(sensorluLot);
    expect(out.coords.lat).toBe(38.414551);
    expect(out.coords.lng).toBe(27.122476);
    expect(out).not.toHaveProperty("x");
    expect(out).not.toHaveProperty("y");
    expect(out).not.toHaveProperty("vehicleParkingId");
  });

  test("total = free + occupied (doluluk varken)", () => {
    const out = toOtpParking({ ...sensorluLot, occupancy: { total: { free: 3, occupied: 7 } } });
    expect(out.total).toBe(10);
    expect(out.free).toBe(3);
  });

  // DAVRANIŞ DEĞİŞTİ. Önceden doluluk bilinmediğinde free ve total 0 yazılıyordu
  // ve otopark "sıfır kapasiteli" bildiriliyordu. OTP bunu "dolu" diye okuyup
  // otoparkta park etmeyi hiç denemez; kapasitesi bilinen ama sensörü olmayan
  // 68 otopark rotalamadan böyle düşerdi. Artık kapasite envanterden gelir ve
  // free HİÇ GÖNDERİLMEZ — OTP alanı olmayanı "gerçek zamanlı veri yok" sayar.
  test("doluluk bilinmiyorsa free gönderilmez, total envanter kapasitesidir", () => {
    const out = toOtpParking(envanterLot);
    expect(out.total).toBe(1170);
    expect(out).not.toHaveProperty("free");
  });

  // state ZORUNLUDUR: OTP null kontrolü yapmadan okur, eksikse updater düşer.
  test("state her zaman doldurulur", () => {
    expect(toOtpParking(envanterLot).state).toBe("open");
    expect(toOtpParking({ ...envanterLot, acilis: "07:00", kapanis: "21:00" }).state)
      .toMatch(/^(open|closed)$/);
  });
});

describe("acikMi — çalışma saatinden açık/kapalı", () => {
  // İZELMAN'ın `status` alanı KULLANILMIYOR: canlı yanıtta 14 otoparkın 13'ü,
  // çalışma saati 07:00–22:00 yazmasına rağmen öğle vakti "Closed" bildiriyor.
  // O değere uyulsaydı OTP hiçbirinde park etmezdi.
  test("status alanı yok sayılır, saat esas alınır", () => {
    const ogle = new Date(2026, 7, 30, 12, 0);
    const lot = { status: "Closed", acilis: "07:00", kapanis: "22:00" };
    expect(acikMi(lot, ogle)).toBe(true);
  });

  test("çalışma saati dışında kapalıdır", () => {
    expect(acikMi({ acilis: "07:00", kapanis: "22:00" }, new Date(2026, 7, 30, 5, 0))).toBe(false);
    expect(acikMi({ acilis: "07:00", kapanis: "22:00" }, new Date(2026, 7, 30, 23, 0))).toBe(false);
  });

  test("00:00–24:00 ve nonstop kesintisiz sayılır", () => {
    expect(acikMi({ acilis: "00:00", kapanis: "24:00" }, new Date(2026, 7, 30, 3, 0))).toBe(true);
    expect(acikMi({ nonstop: true }, new Date(2026, 7, 30, 3, 0))).toBe(true);
  });

  test("İZELMAN'ın uzun tireli openingHours biçimini okur", () => {
    const pazar = new Date(2026, 7, 30, 12, 0);   // 30.08.2026 pazar
    expect(acikMi({ openingHours: { sunday: "07:00 – 22:00" } }, pazar)).toBe(true);
    expect(acikMi({ openingHours: { sunday: "07:00 – 22:00" } }, new Date(2026, 7, 30, 4, 0))).toBe(false);
  });

  // Bilinmeyeni kapalı saymak otoparkı tamamen görünmez kılar; açık saymak
  // yalnız gereksiz önerir. İkisinden az zararlısı seçildi.
  test("saat bilinmiyorsa açık kabul edilir", () => {
    expect(acikMi({})).toBe(true);
  });
});

describe("isParkAndRide", () => {
  test("OffStreet olan her lot P+R sayılır", () => {
    expect(isParkAndRide({ type: "OffStreet" })).toBe(true);
  });

  // Asıl ölçüt bu. Eskiden yalnız İZELMAN'ın `poi` bayraklarına bakılıyordu;
  // o bayraklar sensörlü 14 kayıtta var, envanterin kalan 68'inde yok — yani
  // kural veri kaynağının kapsamına göre sonuç veriyordu.
  test("yol kenarı otoparkı istasyona yakınsa P+R sayılır", () => {
    expect(isParkAndRide({ type: "OnStreet", rayliMesafeM: 250 })).toBe(true);
    expect(isParkAndRide({ type: "OnStreet", rayliMesafeM: 400 })).toBe(true);
    expect(isParkAndRide({ type: "OnStreet", rayliMesafeM: 401 })).toBe(false);
  });

  test("mesafe bilinmiyorsa poi bayrakları yedek olarak kullanılır", () => {
    expect(isParkAndRide({ type: "OnStreet", poi: { metroStation: "Konak" } })).toBe(true);
    expect(isParkAndRide({ type: "OnStreet", poi: { trainStation: "Alsancak" } })).toBe(true);
    expect(isParkAndRide({ type: "OnStreet", poi: { tramStation: "Karşıyaka" } })).toBe(true);
    expect(isParkAndRide({ type: "OnStreet", poi: {} })).toBe(false);
    expect(isParkAndRide({ type: "OnStreet" })).toBe(false);
  });
});

describe("toParkingStation — uygulamanın harita katmanı", () => {
  test("lng alanını lon olarak yeniden adlandırır", () => {
    const out = toParkingStation(sensorluLot);
    expect(out.lon).toBe(27.122476);
    expect(out).not.toHaveProperty("lng");
  });

  test("raylı sistem yakınlığı ölçülen mesafeden gelir", () => {
    const out = toParkingStation(sensorluLot);
    expect(out.nearMetro).toBe(true);
    expect(out.railDistanceM).toBe(120);
    expect(out.railName).toBe("Konak");
  });

  test("kapasite ve doluluk birlikte raporlanır", () => {
    const out = toParkingStation(sensorluLot);
    expect(out.capacity).toBe(41);
    expect(out.free).toBe(16);
    expect(out.occupied).toBe(25);
  });

  // Sensörsüz otopark listeden DÜŞMEZ. free null'dır — sıfır değil: "boş yer
  // yok" ile "boş yer sayısı bilinmiyor" farklı şeyler ve uygulama ikisini
  // farklı gösterir.
  test("sensörsüz otoparkta kapasite envanterden gelir, doluluk null'dır", () => {
    const out = toParkingStation(envanterLot);
    expect(out.capacity).toBe(1170);
    expect(out.free).toBeNull();
    expect(out.occupied).toBeNull();
    expect(out.source).toBe("ckan");
  });
});

describe("enYakinEnvanterKaydi — canlı doluluğu doğru otoparka bağlar", () => {
  // ÖLÇÜLMÜŞ ARIZA. Eşleştirme yalnız mesafeye bakarken Ali Çetinkaya yol
  // kenarı otoparkı (28 yer) 49 m ötedeki ALSANCAK YER ALTI'na (133 yer)
  // bağlanıyordu; doğru karşılığı 62 m'de, yani biraz daha uzaktaydı.
  // Sonuç: 133 araçlık yeraltı garajı haritada 28 yer kapasiteli görünüyor ve
  // başka bir otoparkın doluluğunu gösteriyordu.
  test("daha yakın ama ilgisiz kaydı değil, adı ve kapasitesi tutanı seçer", () => {
    const canli = {
      name: "05 Ali Cetinkaya Yol Kenarı Otopark",
      lat: 38.433452, lng: 27.147500,
      occupancy: { total: { free: 0, occupied: 28 } },
    };
    const envanter = [
      { ufid: "a", name: "ALSANCAK YER ALTI",     lat: 38.4338884, lng: 27.1476040, kapasite: 133 },
      { ufid: "b", name: "ALİ ÇETİNKAYA BULVARI", lat: 38.4330000, lng: 27.1480000, kapasite: 30 },
    ];
    expect(enYakinEnvanterKaydi(canli, envanter).ufid).toBe("b");
  });

  test("ne ad ne kapasite tutuyorsa hiç bağlamaz", () => {
    const canli = {
      name: "99 Bilinmeyen Otopark", lat: 38.4334, lng: 27.1475,
      occupancy: { total: { free: 0, occupied: 28 } },
    };
    const envanter = [{ ufid: "a", name: "ALSANCAK YER ALTI", lat: 38.4338, lng: 27.1476, kapasite: 133 }];
    expect(enYakinEnvanterKaydi(canli, envanter)).toBeNull();
  });

  test("yarıçap dışındaki kayda bakmaz", () => {
    const canli = { name: "HÜRRİYET BULVARI", lat: 38.0, lng: 27.0, occupancy: { total: { free: 4, occupied: 36 } } };
    const envanter = [{ ufid: "a", name: "HÜRRİYET BULVARI", lat: 38.424774, lng: 27.141169, kapasite: 40 }];
    expect(enYakinEnvanterKaydi(canli, envanter)).toBeNull();
  });
});

describe("isimSkoru — iki kaynağın aynı adı farklı yazması", () => {
  test("Türkçe karakter ve noktalama farkını yok sayar", () => {
    expect(isimSkoru("33 Hürriyet Bulvarı", "HÜRRİYET BULVARI")).toBeGreaterThan(0);
    expect(isimSkoru("04 Ziya Gökalp Yol Kenarı Otopark", "ZİYA GÖKALP BULVARI -  1")).toBeGreaterThan(0);
  });

  // "VASIF CINAR" ↔ "VASIFCINAR": kaynaklar adı farklı bölüyor, kelime
  // kesişimi bulamıyor. Çekirdek kapsaması bunu yakalar.
  test("farklı bölünmüş adı çekirdek kapsamasıyla yakalar", () => {
    expect(isimSkoru("08 Vasif Cinar Yol Kenarı Otopark", "VASIFÇINAR  BULVARI  - 2")).toBeGreaterThan(0);
  });

  // "OTOPARK", "BULVARI" her isimde geçer; ayırt edici sayılırsa her kayıt
  // her kayda benzer çıkar ve skor anlamını yitirir.
  test("dolgu kelimeler benzerlik saymaz", () => {
    expect(isimSkoru("ALSANCAK YER ALTI", "KONAK YER ALTI")).toBe(0);
    expect(isimSkoru("Bostanlı Katlı Otopark", "GAZİEMİR KATLI")).toBe(0);
  });
});

// ─── Bisiklet park feed'i ──────────────────────────────────────────────
// Ölçüm (Narlıdere → Çiğli, Pzt 08:00): OSM'den gelen 87 bisiklet parkının
// hiçbiri raylı istasyonda değildi, OTP de bisikleti metronun 3 km beriside
// park edip araya otobüs sokuyordu. Bu feed o boşluğu dolduruyor.
describe("bisikletParkYerleri", () => {
  const otpYanit = (stops) => ({ data: { data: { stops } } });

  // Raylı durak listesi modül içinde 24 saat önbelleklenir (konumlar graph
  // ömrü boyunca sabit). Testler arasında sıfırlanmazsa ikinci testin mock'u
  // hiç kullanılmaz ve birincinin sonucu ölçülür — bu bir kez oldu.
  beforeEach(() => { jest.clearAllMocks(); rayliDuraklariUnut(); });

  // Kaynak İZULAŞ istasyon API'si DEĞİL, OTP'nin kendi durak listesi.
  // Sebebi ölçüldü: o liste "Narlıdere İtfaiye"yi metro istasyonu sayıyor ama
  // metro feed'i olmayan bir graph'ta orada yalnız otobüs durağı var; bisiklet
  // oraya park edilip yine otobüse biniliyordu.
  test("yalnız raylı sefer YAPILAN duraklar park yeri olur", async () => {
    axios.post.mockResolvedValueOnce(otpYanit([
      { name: "Halkapınar",    lat: 38.4350, lon: 27.1686, routes: [{ mode: "SUBWAY" }, { mode: "BUS" }] },
      { name: "Konak Tramvay", lat: 38.4187, lon: 27.1283, routes: [{ mode: "TRAM" }] },
      { name: "Sadece Otobüs", lat: 38.3900, lon: 27.0100, routes: [{ mode: "BUS" }] },
      { name: "Hatsız Durak",  lat: 38.3800, lon: 27.0200, routes: [] },
    ]));

    const adlar = (await bisikletParkYerleri()).map((l) => l.name);
    expect(adlar).toEqual(expect.arrayContaining([
      expect.stringContaining("Halkapınar"),
      expect.stringContaining("Konak Tramvay"),
    ]));
    expect(adlar.some((a) => a.includes("Sadece Otobüs"))).toBe(false);
    expect(adlar.some((a) => a.includes("Hatsız Durak"))).toBe(false);
  });

  // Aynı istasyonun iki peronu tek park noktası olmalı; yoksa Halkapınar tek
  // başına altı lot üretir ve OTP'nin park yeri seçimi anlamsızca dallanır.
  test("aynı istasyonun peronları tek noktada toplanır", async () => {
    axios.post.mockResolvedValueOnce(otpYanit([
      { name: "Halkapınar",   lat: 38.43500, lon: 27.16860, routes: [{ mode: "SUBWAY" }] },
      { name: "Halkapınar 2", lat: 38.43535, lon: 27.16800, routes: [{ mode: "RAIL" }] },
    ]));
    const rayli = (await bisikletParkYerleri()).filter((l) => l.id.startsWith("rail-"));
    expect(rayli).toHaveLength(1);
  });

  // `free` doluluk demektir ve doluluk ARABA yerlerinindir. Taşınırsa OTP
  // dolu bir otoparkı bisiklete de kapalı sayar.
  test("hiçbir lot doluluk (free) taşımaz", async () => {
    axios.post.mockResolvedValueOnce(otpYanit([
      { name: "Halkapınar", lat: 38.4350, lon: 27.1686, routes: [{ mode: "SUBWAY" }] },
    ]));
    for (const lot of await bisikletParkYerleri()) expect(lot).not.toHaveProperty("free");
  });

  // OTP açılışta bu feed'i çekiyor ve o an GraphQL ucu henüz yanıt vermeyebilir.
  // Boş feed göndermek yerine P+R otoparkları yine bildirilmeli.
  test("OTP'ye ulaşılamazsa boş dizi yerine eldekiyle devam eder", async () => {
    axios.post.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await expect(bisikletParkYerleri()).resolves.toEqual(expect.any(Array));
  });
});
