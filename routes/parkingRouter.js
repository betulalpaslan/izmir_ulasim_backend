const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const config = require("../config");
const axios = require("axios");
const { fetchParks, isParkAndRide, toOtpParking, toParkingStation, bisikletParkYerleri } = require("../services/ParkingService");


const router = express.Router();

// OTP'nin ParkAPI updater'ı bu uç noktayı dakikada bir çeker.
// Gövde şeması OTP tarafından dayatılır: { lots: [...] } — bkz. toOtpParking.
router.get("/feed", asyncHandler(async (req, res) => {
  const all = await fetchParks();
  const lots = all
    .filter(isParkAndRide)
    .filter((p) => p.lat != null && p.lng != null)  // koordinatsız lot 0,0'a düşer
    .map(toOtpParking);
  res.json({ lots });
}));

// OTP'nin BICYCLE_PARK_API updater'ı buradan besleniyor. Gövde şeması
// /feed ile aynı (ParkAPI), farkı OTP'nin bu lotları BİSİKLET yeri olarak
// kaydetmesi — bkz. ParkingService.bisikletParkYerleri, oradaki ölçüm bu ucun neden var olduğunu anlatıyor.
router.get("/bike-feed", asyncHandler(async (req, res) => {
  res.json({ lots: await bisikletParkYerleri() });
}));

router.get("/stations", asyncHandler(async (req, res) => {
  const tumu = req.query.kapsam === "tumu";
  try {
    const all = await fetchParks();
    const stations = all
      .filter((p) => (tumu ? true : isParkAndRide(p)))
      .filter((p) => p.lat && p.lng)
      .map(toParkingStation);
    res.json({ stations, kapsam: tumu ? "tumu" : "park-and-ride", updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Otopark stations hatası:", err.message);
    res.status(502).json({ error: "İZELMAN otopark servisine ulaşılamıyor." });
  }
}));

// OTP'nin routing için kullandığı lotlar — doluluk doğrudan İZELMAN'dan
router.get("/otp-lots", asyncHandler(async (req, res) => {

  const query = `{
    vehicleParkings {
      vehicleParkingId
      name
      lat
      lon
      tags
      state
      realtime
      carPlaces
      anyCarPlaces
      bicyclePlaces
      capacity     { carSpaces bicycleSpaces }
      availability { carSpaces bicycleSpaces }
    }
  }`;
  try {
    const [otpRes, izelmanParks] = await Promise.all([
      axios.post(config.OTP_URL, { query }, { timeout: config.TIMEOUT.OTP_SORGU }),
      fetchParks(),
    ]);

    // GraphQL hataları sessizce yutulmamalı: boş liste ile "OTP'de veri yok" ayırt edilemiyordu.
    if (otpRes.data?.errors?.length) {
      console.error("OTP vehicleParkings GraphQL hatası:", JSON.stringify(otpRes.data.errors));
      return res.status(502).json({ error: "OTP GraphQL hatası", details: otpRes.data.errors });
    }
    const lots = otpRes.data?.data?.vehicleParkings || [];

 
    const izelmanMap = {};
    for (const p of izelmanParks) {
      izelmanMap[p.ufid] = p;
    }

    const tagFilter = req.query.tag;
    const vehicle = req.query.vehicle;

    let filtered = lots;
    if (vehicle === "bicycle") filtered = filtered.filter((p) => p.bicyclePlaces === true);
    else if (vehicle === "car") filtered = filtered.filter((p) => p.carPlaces === true || p.anyCarPlaces === true);
    if (tagFilter) filtered = filtered.filter((p) => (p.tags || []).includes(tagFilter));

    const stations = filtered.map((p) => {
      const live = izelmanMap[String(p.vehicleParkingId).split(":").pop()];
      const free     = live?.occupancy?.total?.free     ?? null;
      const occupied = live?.occupancy?.total?.occupied ?? null;
      const capacity = free != null && occupied != null ? free + occupied : null;
      return {
        id:       p.vehicleParkingId,
        name:     p.name,
        lat:      p.lat,
        lon:      p.lon,
        tags:     p.tags || [],
        state:    p.state ?? null,
        // OTP'nin o yeri hangi araç için kullanılabilir saydığı
        bicyclePlaces: p.bicyclePlaces ?? null,
        carPlaces:     (p.carPlaces || p.anyCarPlaces) ?? null,
        // OTP'nin kendi gördüğü yer sayıları — feed'in doğru yutulduğunu doğrular
        otpCarSpaces:     p.capacity?.carSpaces ?? null,
        otpBicycleSpaces: p.capacity?.bicycleSpaces ?? null,
        otpFreeCar:       p.availability?.carSpaces ?? null,
        free,
        occupied,
        capacity,
      };
    });

    res.json({ stations, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("OTP vehicleParking hatası:", err.message);
    res.status(502).json({ error: "OTP'ye ulaşılamıyor." });
  }
}));

module.exports = router;
