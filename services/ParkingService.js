const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const IZELMAN_PARK_URL  = "https://openapi.izmir.bel.tr/api/ibb/izum/otoparklar";
const BUILD_CACHE_FILE  = path.join(__dirname, "..", "parking_cache.json");
const CACHE_TTL = 60 * 1000;

let cache = null;
let cacheTime = 0;
let cacheSource = null;   // "izelman" | "build-cache" | "none" — /health bunu okur

async function fetchParks() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;

  try {
    const res = await axios.get(IZELMAN_PARK_URL, { timeout: 8000 });
    cache = Array.isArray(res.data) ? res.data : [];
    cacheTime = now;
    cacheSource = "izelman";
    return cache;
  } catch (err) {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(BUILD_CACHE_FILE, "utf8"));
      cache = Array.isArray(raw) ? raw : [];
      cacheTime = now;
      cacheSource = "build-cache";
      console.warn("Otopark: İZELMAN erişilemez, build-cache kullanılıyor");
      return cache;
    } catch {}
    cacheSource = "none";
    console.warn("Otopark: Tüm kaynaklar başarısız, boş liste döndürülüyor");
    return [];
  }
}

function isParkAndRide(p) {
  if (p.type === "OffStreet") return true;
  const nearRail = p.poi?.metroStation || p.poi?.trainStation || p.poi?.tramStation;
  return !!nearRail;
}

// OTP ParkAPI formatı (offenesdresden/ParkAPI şeması).
// OTP'nin ParkAPIUpdater'ı gövdede "lots" dizisi arar ve her lot için
// coords.lat / coords.lng / total / free alanlarını okur. Eski
// {vehicleParkings:[{x,y,capacity,availability}]} biçimi hiçbir alanı
// karşılamadığı için OTP sessizce 0 otopark yüklüyordu.
// state ZORUNLUDUR: OTP null kontrolü yapmadan okur, eksikse updater düşer.
function toOtpParking(p) {
  const free     = p.occupancy?.total?.free     || 0;
  const occupied = p.occupancy?.total?.occupied || 0;
  return {
    id:     p.ufid,                 // OTP başına feedId ekler → "izmir-pr:<ufid>"
    name:   p.name,
    coords: { lat: p.lat, lng: p.lng },
    state:  p.status === "Opened" ? "open" : "closed",
    total:  free + occupied,
    free,
  };
}

function toParkingStation(p) {
  const free     = p.occupancy?.total?.free     || 0;
  const occupied = p.occupancy?.total?.occupied || 0;
  return {
    id:        p.ufid,
    name:      p.name,
    lat:       p.lat,
    lon:       p.lng,
    type:      p.type,
    capacity:  free + occupied,
    free,
    occupied,
    status:    p.status,
    isPaid:    p.isPaid,
    nearMetro: !!p.poi?.metroStation,
    nearTrain: !!p.poi?.trainStation,
    nearTram:  !!p.poi?.tramStation,
    provider:  p.provider,
  };
}

// ─── Sağlık durumu ─────────────────────────────────────────────────────
// Bkz. BikeShareService.getStatus — aynı gerekçe. parkAndRide sayısı ayrıca
// raporlanır: OTP feed'i yalnızca o alt kümeyi görür, dolayısıyla "İZELMAN
// yanıt veriyor ama P+R lotu 0" durumu rotalamayı sessizce bozar.
function getStatus() {
  const now = Date.now();
  return {
    source:      cacheSource,                                        // izelman | build-cache | none | null
    ageSec:      cache ? Math.floor((now - cacheTime) / 1000) : null,
    lots:        cache ? cache.length : null,
    parkAndRide: cache ? cache.filter(isParkAndRide).length : null,
  };
}

module.exports = { fetchParks, isParkAndRide, toOtpParking, toParkingStation, getStatus };
