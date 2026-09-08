const UPSTREAM_CODES = ["ECONNREFUSED", "ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"];

function errorHandler(err, req, res, next) {
  // Yanıt yazılmaya başlandıysa Express'in kendi kapatma mantığına bırak.
  if (res.headersSent) return next(err);

  const isUpstream = err.isAxiosError === true || UPSTREAM_CODES.includes(err.code);
  const status = err.status || err.statusCode || (isUpstream ? 502 : 500);

  console.error(`[${req.method} ${req.originalUrl}] ${status}:`, err.message);

  res.status(status).json({
    error: status === 502 ? "Dış servise ulaşılamıyor." : "Sunucu hatası.",
    detail: err.message,
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: "Bilinmeyen uç nokta.", path: req.originalUrl });
}

module.exports = { errorHandler, notFoundHandler };
