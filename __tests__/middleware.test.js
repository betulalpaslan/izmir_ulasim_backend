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
  // Bu sarmalayıcının tek işi bu: sarılmamış hâlinde reddedilen Promise
  // Express'e hiç ulaşmaz, yanıt yazılmaz ve istek askıda kalır.
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
    expect(res.body.detail).toBe("timeout of 8000ms exceeded");
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
