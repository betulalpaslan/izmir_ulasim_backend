const crypto = require("crypto");

const UPSTREAM_CODES = ["ECONNREFUSED", "ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"];

function errorHandler(err, req, res, next) {
  // Yanıt yazılmaya başlandıysa Express'in kendi kapatma mantığına bırak.
  if (res.headersSent) return next(err);

  const isUpstream = err.isAxiosError === true || UPSTREAM_CODES.includes(err.code);
  const status = err.status || err.statusCode || (isUpstream ? 502 : 500);

  // Hata METNİ artık istemciye dönmüyor: "connect ECONNREFUSED 127.0.0.1:8080"
  // gibi mesajlar iç yapıyı (OTP'nin yaşadığı port, dosya yolları) açık
  // ediyordu. Detay loga yazılır; istemciye yalnız o satırı logda bulmaya
  // yarayan kimlik gider — destek istendiğinde sorulacak tek şey bu.
  const istekId = crypto.randomUUID().slice(0, 8);
  console.error(`[${istekId}] [${req.method} ${req.originalUrl}] ${status}:`, err.message);

  res.status(status).json({
    error: status === 502 ? "Dış servise ulaşılamıyor." : "Sunucu hatası.",
    istekId,
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: "Bilinmeyen uç nokta.", path: req.originalUrl });
}

module.exports = { errorHandler, notFoundHandler };
