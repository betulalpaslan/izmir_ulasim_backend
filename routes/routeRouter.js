const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const taniKorumasi = require("../middleware/taniKorumasi");
const config = require("../config");
const axios = require("axios");
const { safeFloat, planRoute } = require("../services/OtpService");

const router = express.Router();

router.post("/get-route", asyncHandler(async (req, res) => {
  const { from, to, profile, modes, bikeType, numItineraries, dateTime } = req.body || {};

  const fromLat = safeFloat(from?.lat);
  const fromLon = safeFloat(from?.lon);
  const toLat   = safeFloat(to?.lat);
  const toLon   = safeFloat(to?.lon);

  if (fromLat == null || fromLon == null || toLat == null || toLon == null) {
    return res.status(400).json({ error: "Başlangıç ve varış koordinatları gereklidir." });
  }

  try {
    const result = await planRoute({ fromLat, fromLon, toLat, toLon, profile, modes, bikeType, numItineraries, dateTime });
    return res.json(result);
  } catch (err) {
    if (err.otpErrors) {
      // Hata listesi OTP'nin şemasını ele veriyordu ve istemcide hiç
      // kullanılmıyor; loga yazılır, dışarı yalnız sebep çıkar.
      console.error("OTP GraphQL hatası:", JSON.stringify(err.otpErrors));
      return res.status(400).json({ error: "İstek OTP tarafından reddedildi." });
    }
    // OTP'ye ulaşılamaması 502 (tekrar denenebilir), kod hatası 500; ayrımı
    // errorHandler yapar. Burada her şeye 500 dönmek, uygulamaya "veri
    // kaynağına ulaşılamıyor" yerine "sunucuda hata" dedirtiyordu.
    throw err;
  }
}));



router.get("/otp-status", taniKorumasi, asyncHandler(async (req, res) => {
  const query = `{
    serviceTimeRange { start end }
    feeds { feedId agencies { name } }
  }`;
  try {
    const r = await axios.post(config.OTP_URL, { query }, { timeout: config.TIMEOUT.OTP_SORGU });
    if (r.data?.errors?.length) {
      return res.status(502).json({ error: "OTP GraphQL hatası", details: r.data.errors });
    }
    const range = r.data?.data?.serviceTimeRange || {};
    const toIso = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : null);
    const endMs = range.end ? range.end * 1000 : null;
    return res.json({
      serviceStart: toIso(range.start),
      serviceEnd:   toIso(range.end),
      daysRemaining: endMs ? Math.floor((endMs - Date.now()) / 86400000) : null,
      expired: endMs ? endMs < Date.now() : null,
      feeds: (r.data?.data?.feeds || []).map((f) => ({
        feedId: f.feedId,
        agencies: (f.agencies || []).map((a) => a.name),
      })),
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(502).json({ error: "OTP'ye ulaşılamıyor.", detail: err.message });
  }
}));

module.exports = router;
