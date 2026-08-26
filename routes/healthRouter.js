const express = require("express");
const axios = require("axios");
const bikeShare = require("../services/BikeShareService");
const parking   = require("../services/ParkingService");

const OTP_PORT = process.env.OTP_PORT || 8080;
const OTP_URL = `http://localhost:${OTP_PORT}/otp/gtfs/v1`;

const router = express.Router();
const startedAt = Date.now();

// Bu servisin karakteristik hata biçimi sessiz bozulmadır: her şey 200
// döner ama içerik yanlıştır. Üç örnek, üçü de yaşandı ya da yaşanabilir:
//   • Overpass düşer → istasyon listesi aylar öncesinin build-cache'inden gelir
//   • İZELMAN düşer → P+R lot sayısı 0'a iner, park_and_ride rotaları kaybolur
//   • GTFS calendar penceresi biter → toplu taşıma rotaları hatasız yok olur
// Hiçbiri log'a hata yazmaz. Bu uçların işi bunları görünür kılmaktır.

// ─── /health — canlılık (liveness) ─────────────────────────────────────
// Ucuz ve HER ZAMAN 200: hiç ağ isteği yapmaz, yalnızca "Node ayakta mı"
// sorusunu yanıtlar. Platform healthcheck'i ve start.sh'ın hazırlık
// yoklaması bunu kullanmalı — OTP'ye bağlanırsa OTP'nin ~1 dakikalık
// açılışı boyunca deploy başarısız sayılır.
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    checkedAt: new Date().toISOString(),
  });
});

// ─── /health/ready — hazırlık + veri sağlığı (readiness) ───────────────
// İzlemenin çekeceği uç. OTP'ye tek bir hafif GraphQL sorgusu atar.
//   ok       → her şey taze
//   degraded → servis cevap veriyor ama veri bayat/eksik (yukarıdaki 3 örnek)
//   down     → OTP erişilemez; rota üretilemiyor  → HTTP 503
router.get("/health/ready", async (req, res) => {
  const bike = bikeShare.getStatus();
  const park = parking.getStatus();
  const otp  = await checkOtp();

  const issues = [];
  if (!otp.reachable)                         issues.push("otp_unreachable");
  if (otp.expired === true)                   issues.push("graph_expired");
  if (otp.daysRemaining != null && otp.daysRemaining >= 0 && otp.daysRemaining < 7)
                                              issues.push("graph_expiring_soon");
  if (bike.source === "build-cache")          issues.push("bisim_build_cache");
  if (bike.stale)                             issues.push("bisim_overpass_backoff");
  if (bike.stations === 0)                    issues.push("bisim_no_stations");
  if (park.source === "build-cache")          issues.push("parking_build_cache");
  if (park.source === "none")                 issues.push("parking_no_source");
  if (park.parkAndRide === 0)                 issues.push("parking_no_park_and_ride");

  const status = !otp.reachable ? "down" : issues.length ? "degraded" : "ok";

  res.status(status === "down" ? 503 : 200).json({
    status,
    issues,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    checks: { otp, bisim: bike, parking: park },
    checkedAt: new Date().toISOString(),
  });
});

// OTP'nin ayakta olup olmadığını VE graph'ın hangi tarih aralığını
// kapsadığını tek sorguda öğrenir. Timeout kısa: sağlık ucu yavaş olursa
// izleme aracı zaman aşımını "servis öldü" diye raporlar.
async function checkOtp() {
  const query = `{ serviceTimeRange { start end } }`;
  try {
    const r = await axios.post(OTP_URL, { query }, { timeout: 3000 });
    if (r.data?.errors?.length) {
      return { reachable: true, graphqlError: true, detail: r.data.errors[0]?.message ?? null };
    }
    const range = r.data?.data?.serviceTimeRange || {};
    const endMs = range.end ? range.end * 1000 : null;
    const toIso = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : null);
    return {
      reachable: true,
      serviceStart: toIso(range.start),
      serviceEnd:   toIso(range.end),
      daysRemaining: endMs ? Math.floor((endMs - Date.now()) / 86400000) : null,
      expired: endMs ? endMs < Date.now() : null,
    };
  } catch (err) {
    return { reachable: false, detail: err.message };
  }
}

module.exports = router;
