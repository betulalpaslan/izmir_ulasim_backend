const asyncHandler = require("../middleware/asyncHandler");
const { errorHandler, notFoundHandler } = require("../middleware/errorHandler");

const sahteRes = () => {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  return res;
};
const sahteReq = (over = {}) => ({ method: "GET", originalUrl: "/parking/feed", ...over });

describe("asyncHandler", () => {

  test("reddedilen Promise'i next(err)'e verir", async () => {
    const hata = new Error("İZELMAN düştü");
    const next = jest.fn();
    await asyncHandler(async () => { throw hata; })(sahteReq(), sahteRes(), next);
    expect(next).toHaveBeenCalledWith(hata);
  });

  test("senkron throw'u da yakalar", async () => {
    const next = jest.fn();
    await asyncHandler(() => { throw new Error("senkron"); })(sahteReq(), sahteRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].message).toBe("senkron");
  });

  test("başarılı handler'da next çağrılmaz", async () => {
    const next = jest.fn();
    const res = sahteRes();
    await asyncHandler(async (req, r) => { r.json({ lots: [] }); })(sahteReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({ lots: [] });
  });

  test("Promise döndürmeyen handler'ı da kabul eder", async () => {
    const next = jest.fn();
    const res = sahteRes();
    await asyncHandler((req, r) => r.json({ ok: true }))(sahteReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true });
  });
});

describe("errorHandler", () => {
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  // 502/500 ayrımı istemci için anlamlıdır: 502 → tekrar dene,
  // 500 → burada bir hata var, denemenin faydası yok.
  test("axios hatası 502 olur", () => {
    const res = sahteRes();
    const err = Object.assign(new Error("timeout of 8000ms exceeded"), { isAxiosError: true });
    errorHandler(err, sahteReq(), res, jest.fn());
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toBe("Dış servise ulaşılamıyor.");
  });

  // Hata metni iç yapıyı ele veriyordu ("connect ECONNREFUSED 127.0.0.1:8080"
  // OTP'nin portunu söylüyor). Detay logda kalmalı, yanıtta yalnız o satırı
  // logda bulduran kimlik olmalı.
  test("iç hata metni istemciye sızmaz, loga yazılır", () => {
    const res = sahteRes();
    const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { isAxiosError: true });
    errorHandler(err, sahteReq(), res, jest.fn());
    expect(res.body).not.toHaveProperty("detail");
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|8080/);
    expect(res.body.istekId).toMatch(/^[0-9a-f]{8}$/);
    expect(logSpy.mock.calls[0].join(" ")).toContain("connect ECONNREFUSED 127.0.0.1:8080");
    expect(logSpy.mock.calls[0].join(" ")).toContain(res.body.istekId);
  });

  test("ağ hata kodları 502 olur", () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNABORTED"]) {
      const res = sahteRes();
      errorHandler(Object.assign(new Error(code), { code }), sahteReq(), res, jest.fn());
      expect(res.statusCode).toBe(502);
    }
  });

  test("kod kaynaklı hata 500 olur", () => {
    const res = sahteRes();
    errorHandler(new TypeError("x is not a function"), sahteReq(), res, jest.fn());
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("Sunucu hatası.");
  });

  test("hatanın kendi status'ü varsa o kazanır", () => {
    const res = sahteRes();
    errorHandler(Object.assign(new Error("yok"), { status: 404 }), sahteReq(), res, jest.fn());
    expect(res.statusCode).toBe(404);
  });

  // Yanıt yazılmaya başlandıysa ikinci kez yazmak Express'i patlatır.
  test("headersSent ise yanıta dokunmaz, next'e devreder", () => {
    const res = sahteRes();
    res.headersSent = true;
    const next = jest.fn();
    const err = new Error("geç kalan hata");
    errorHandler(err, sahteReq(), res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.statusCode).toBeNull();
  });
});

describe("notFoundHandler", () => {
  test("404 ve istenen yolu döner", () => {
    const res = sahteRes();
    notFoundHandler(sahteReq({ originalUrl: "/bisim/gbsf" }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Bilinmeyen uç nokta.", path: "/bisim/gbsf" });
  });
});

// Tanılama uçları OTP şemasını ve feed durumunu döküyor, /otp-rental-test
// ayrıca OTP'ye gerçek bir plan sorgusu attırıyor. Anahtarsız istek "böyle
// bir uç yok" cevabı almalı: 403 demek ucun VAR olduğunu söylemek olurdu.
describe("taniKorumasi", () => {
  const taniKorumasi = require("../middleware/taniKorumasi");
  const eskiAnahtar = process.env.TANI_ANAHTARI;
  const req = (over = {}) => ({
    method: "GET", originalUrl: "/otp-status", path: "/otp-status",
    query: {}, get: () => undefined, ...over,
  });

  afterEach(() => {
    if (eskiAnahtar === undefined) delete process.env.TANI_ANAHTARI;
    else process.env.TANI_ANAHTARI = eskiAnahtar;
  });

  test("ortamda anahtar tanımlı değilse uç yokmuş gibi davranır", () => {
    delete process.env.TANI_ANAHTARI;
    const res = sahteRes();
    const next = jest.fn();
    taniKorumasi(req({ query: { anahtar: "ne-olursa" } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Bilinmeyen uç nokta.", path: "/otp-status" });
  });

  test("yanlış anahtar geçmez", () => {
    process.env.TANI_ANAHTARI = "dogru-anahtar";
    const res = sahteRes();
    const next = jest.fn();
    taniKorumasi(req({ query: { anahtar: "yanlis" } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });

  test("doğru anahtar başlıkla da sorgu parametresiyle de geçer", () => {
    process.env.TANI_ANAHTARI = "dogru-anahtar";

    const basliklaNext = jest.fn();
    taniKorumasi(req({ get: (ad) => (ad === "x-tani-anahtari" ? "dogru-anahtar" : undefined) }),
      sahteRes(), basliklaNext);
    expect(basliklaNext).toHaveBeenCalled();

    const sorguylaNext = jest.fn();
    taniKorumasi(req({ query: { anahtar: "dogru-anahtar" } }), sahteRes(), sorguylaNext);
    expect(sorguylaNext).toHaveBeenCalled();
  });

  // Yanıt, anahtarın taşındığı sorgu dizesini geri yansıtmamalı.
  test("404 gövdesi anahtarı geri yansıtmaz", () => {
    process.env.TANI_ANAHTARI = "dogru-anahtar";
    const res = sahteRes();
    taniKorumasi(
      req({ originalUrl: "/otp-status?anahtar=yanlis", query: { anahtar: "yanlis" } }),
      res, jest.fn()
    );
    expect(JSON.stringify(res.body)).not.toContain("yanlis");
  });
});
