const { isParkAndRide, toOtpParking, toParkingStation } = require("../services/ParkingService");

// İZELMAN'ın gerçek gövde biçiminden sadeleştirilmiş örnek.
const izelmanLot = {
  ufid: "NEDAP-TR-IZM-034",
  name: "34 Sabanci Kültür Merkezi",
  lat: 38.414551,
  lng: 27.122476,
  type: "OffStreet",
  status: "Opened",
  isPaid: true,
  provider: "İZELMAN A.Ş",
  occupancy: { total: { free: 16, occupied: 25 } },
  poi: { metroStation: "Konak" },
};

describe("toOtpParking — OTP ParkAPI sözleşmesi", () => {
  // Bu testin varlık sebebi: alan adları OTP tarafından DAYATILIR ve bir kez
  // yanlış yazıldığında OTP hata vermeden sıfır otopark yükler. Eskiden gövde
  // {vehicleParkings:[{x, y, capacity, availability}]} biçimindeydi; ParkAPI
  // updater'ı bu alanların hiçbirini tanımadığı için otopark listesi sessizce
  // boş kalıyordu. Aşağıdaki isimler bu yüzden serbestçe değiştirilemez.
  test("ParkAPI'nin beklediği alan adlarını tam olarak üretir", () => {
    expect(toOtpParking(izelmanLot)).toEqual({
      id: "NEDAP-TR-IZM-034",
      name: "34 Sabanci Kültür Merkezi",
      coords: { lat: 38.414551, lng: 27.122476 },
      state: "open",
      total: 41,
      free: 16,
    });
  });

  test("koordinat coords nesnesinin içindedir, x/y değil", () => {
    const out = toOtpParking(izelmanLot);
    expect(out.coords.lat).toBe(38.414551);
    expect(out.coords.lng).toBe(27.122476);
    expect(out).not.toHaveProperty("x");
    expect(out).not.toHaveProperty("y");
    expect(out).not.toHaveProperty("vehicleParkingId");
  });

  // state ZORUNLUDUR: OTP null kontrolü yapmadan okur, eksikse updater düşer.
  test("state her zaman doldurulur; yalnızca Opened açık sayılır", () => {
    expect(toOtpParking({ ...izelmanLot, status: "Opened" }).state).toBe("open");
    expect(toOtpParking({ ...izelmanLot, status: "Closed" }).state).toBe("closed");
    expect(toOtpParking({ ...izelmanLot, status: undefined }).state).toBe("closed");
  });

  test("total = free + occupied", () => {
    const out = toOtpParking({ ...izelmanLot, occupancy: { total: { free: 3, occupied: 7 } } });
    expect(out.total).toBe(10);
    expect(out.free).toBe(3);
  });

  // BİLİNEN TUTARSIZLIK: doluluk bilinmediğinde 0 yazılır ve otopark
  // "sıfır kapasiteli" bildirilir. BikeShareService aynı soruya farklı cevap
  // verir (bilinmiyorsa alanı hiç göndermez). Test mevcut davranışı sabitler;
  // karar değiştiğinde burası da değişmeli.
  test("doluluk eksikse 0 yazar — kapasite bilinmiyor demek değildir", () => {
    const out = toOtpParking({ ...izelmanLot, occupancy: undefined });
    expect(out.total).toBe(0);
    expect(out.free).toBe(0);
  });
});

describe("isParkAndRide", () => {
  test("OffStreet olan her lot P+R sayılır", () => {
    expect(isParkAndRide({ type: "OffStreet" })).toBe(true);
  });

  test("OffStreet değilse raylı sisteme yakınlık aranır", () => {
    expect(isParkAndRide({ type: "OnStreet", poi: { metroStation: "Konak" } })).toBe(true);
    expect(isParkAndRide({ type: "OnStreet", poi: { trainStation: "Alsancak" } })).toBe(true);
    expect(isParkAndRide({ type: "OnStreet", poi: { tramStation: "Karşıyaka" } })).toBe(true);
    expect(isParkAndRide({ type: "OnStreet", poi: {} })).toBe(false);
    expect(isParkAndRide({ type: "OnStreet" })).toBe(false);
  });
});

describe("toParkingStation — uygulamanın harita katmanı", () => {
  test("lng alanını lon olarak yeniden adlandırır", () => {
    const out = toParkingStation(izelmanLot);
    expect(out.lon).toBe(27.122476);
    expect(out).not.toHaveProperty("lng");
  });

  test("raylı sistem yakınlığını boolean'a indirger", () => {
    const out = toParkingStation(izelmanLot);
    expect(out.nearMetro).toBe(true);
    expect(out.nearTrain).toBe(false);
    expect(out.nearTram).toBe(false);
  });

  test("kapasite ve doluluk birlikte raporlanır", () => {
    const out = toParkingStation(izelmanLot);
    expect(out.capacity).toBe(41);
    expect(out.free).toBe(16);
    expect(out.occupied).toBe(25);
  });
});
