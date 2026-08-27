const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { fetchOsmParkingSpots, fetchBicycleParkings } = require("../services/OsmParkingService");
const { searchAddress } = require("../services/GeocodingService");

const router = express.Router();

// OSM otoparkları — kapalı/yeraltı + isimli açık otoparklar.
router.get("/parking/osm", asyncHandler(async (req, res) => {
  const spots = await fetchOsmParkingSpots();
  res.json({ spots, updatedAt: new Date().toISOString() });
}));

// OSM bisiklet parkları. Aynı noktalar OTP graph'ında da var
// (/parking/otp-lots?vehicle=bicycle); bu uç OTP kapalıyken de çalışsın diye
// doğrudan Overpass'tan beslenir.
router.get("/parking/bike-racks", asyncHandler(async (req, res) => {
  const stations = await fetchBicycleParkings();
  res.json({ stations, updatedAt: new Date().toISOString() });
}));

// Adres araması. Boş sorgu ya da 3 harften kısa girdi ağa hiç çıkmaz.
router.get("/geocode", asyncHandler(async (req, res) => {
  const results = await searchAddress(req.query.q);
  res.json({ results });
}));

module.exports = router;
