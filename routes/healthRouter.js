const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const config = require("../config");
const axios = require("axios");
const bisimBolge = require("../services/BisimBolgeService");
const parking   = require("../services/ParkingService");
const osmParking = require("../services/OsmParkingService");
const istasyon  = require("../services/RayliIstasyonService");


const router = express.Router();
const startedAt = Date.now();

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    checkedAt: new Date().toISOString(),
  });
});

router.get("/health/ready", asyncHandler(async (req, res) => {
  const bike = bisimBolge.getStatus();
  const park = parking.getStatus();
  const osm  = osmParking.getStatus();
  const ist  = istasyon.getStatus();
  const otp  = await checkOtp();

  const issues = [];
  if (!otp.reachable)                         issues.push("otp_unreachable");
  if (otp.expired === true)                   issues.push("graph_expired");
  if (otp.daysRemaining != null && otp.daysRemaining >= 0 && otp.daysRemaining < 7)
                                              issues.push("graph_expiring_soon");
  if (bike.bolgeler === 0)                    issues.push("bisim_bolge_yok");
  if (otp.reachable && otp.kiralamaBolge === 0)     issues.push("otp_kiralama_bolgesi_yok");
  if (otp.reachable && otp.kiralamaAcik === 0 && otp.kiralamaBolge > 0)
                                              issues.push("otp_kiralama_hepsi_kapali");
  if (park.source === "build-cache")          issues.push("parking_build_cache");
  if (park.source === "none")                 issues.push("parking_no_source");
  if (park.parkAndRide === 0)                 issues.push("parking_no_park_and_ride");
  // İstasyon türlerinden biri tazelenemediğinde P+R sınıflandırması eksik
  // kalır ve otopark sayısı SESSİZCE düşer — bir turda 91 istasyon yerine 36
  // yüklendi, P+R 52'den 44'e indi, hiçbir yerde iz bırakmadı.
  if (ist.tazelenemeyen?.length)              issues.push("istasyon_kismi");
  if (ist.source === "none")                  issues.push("istasyon_yok");
  // OSM katmanları: henüz hiç çekilmemişse (source null) sorun sayılmaz —
  // ilgili profil seçilene kadar kimse istemez, tembel yüklenirler.
  if (osm.osmParking.source === "build-cache")     issues.push("osm_parking_build_cache");
  if (osm.bicycleParking.source === "build-cache") issues.push("bike_parking_build_cache");
  if (osm.osmParking.stale || osm.bicycleParking.stale) issues.push("overpass_backoff");

  const status = !otp.reachable ? "down" : issues.length ? "degraded" : "ok";

  res.status(status === "down" ? 503 : 200).json({
    status,
    issues,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    checks: { otp, bisim: bike, parking: park, osm, istasyon: ist },
    checkedAt: new Date().toISOString(),
  });
}));


async function checkOtp() {
  const query = `{
    serviceTimeRange { start end }
    vehicleRentalStations { allowPickupNow }
  }`;
  try {
    const r = await axios.post(config.OTP_URL, { query }, { timeout: config.TIMEOUT.OTP_SAGLIK });
    if (r.data?.errors?.length) {
      return { reachable: true, graphqlError: true, detail: r.data.errors[0]?.message ?? null };
    }
    const range = r.data?.data?.serviceTimeRange || {};
    const kiralama = r.data?.data?.vehicleRentalStations || [];
    const endMs = range.end ? range.end * 1000 : null;
    const toIso = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : null);
    return {
      reachable: true,
      serviceStart: toIso(range.start),
      serviceEnd:   toIso(range.end),
      daysRemaining: endMs ? Math.floor((endMs - Date.now()) / 86400000) : null,
      expired: endMs ? endMs < Date.now() : null,
      kiralamaBolge: kiralama.length,
      kiralamaAcik:  kiralama.filter((k) => k.allowPickupNow).length,
    };
  } catch (err) {
    return { reachable: false, detail: err.message };
  }
}

module.exports = router;
