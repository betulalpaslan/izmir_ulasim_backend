const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const BUILD_CACHE_FILE = path.join(__dirname, "..", "bisim_cache.json");

const OVERPASS_MIRRORS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
const IZMIR_BBOX = "38.2,26.8,38.6,27.5";
const CACHE_TTL     = 24 * 60 * 60 * 1000; // 24 saat — istasyon konumları nadiren değişir
const RETRY_BACKOFF =  6 * 60 * 60 * 1000; // Overpass başarısız → 6 saat bekle, tekrar deneme

let cache = null;
let cacheTime = 0;
let nextOverpassAttempt = 0; // başarısız denemeden sonra bekleme

async function fetchBisim() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;

  // Kısa süre önce Overpass başarısız olduysa tekrar denemeden stale cache döndür
  if (cache && now < nextOverpassAttempt) return cache;

  const query = `[out:json];node[amenity=bicycle_rental](${IZMIR_BBOX});out;`;
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const res = await axios.get(`${mirror}?data=${encodeURIComponent(query)}`, { timeout: 8000 });
      cache = res.data.elements || [];
      cacheTime = now;
      nextOverpassAttempt = 0;
      return cache;
    } catch {
      // bu mirror başarısız, sıradakini dene
    }
  }

  // Tüm mirror'lar başarısız — bir sonraki denemeyi 6 saat sonraya ertele
  nextOverpassAttempt = now + RETRY_BACKOFF;

  if (cache) return cache; // stale in-memory cache yeterli

  // İlk yükleme ve Overpass yok — build-cache'e düş
  try {
    const raw = JSON.parse(fs.readFileSync(BUILD_CACHE_FILE, "utf8"));
    cache = raw.elements || [];
    cacheTime = now;
    console.warn("BikeShare: Overpass erişilemez, build-cache kullanılıyor");
    return cache;
  } catch {}

  throw new Error("BİSİM verisi hiçbir kaynaktan alınamadı");
}

// ─── İstasyon süzme ve zenginleştirme ────────────────────────────────
// Overpass `amenity=bicycle_rental` sorgusu BİSİM dışındaki noktaları da
// döndürür (özel kiralama dükkânları, kaldırılmış istasyonlar). Ayrım
// isimden değil etiketten yapılır.

const SNAPSHOT_FILE = path.join(__dirname, "..", "bisim_stations.json");

// ref → kapasite. OSM'de istasyonların çoğunda capacity etiketi yok;
// 2025-07 anlık görüntüsündeki gerçek yuva sayılarıyla tamamlanır.
// Anlık görüntüde DOLULUK yoktur, yalnızca kapasite.
let capacityByRef = null;
function loadCapacityByRef() {
  if (capacityByRef) return capacityByRef;
  capacityByRef = {};
  try {
    const doc = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
    for (const st of doc.stations || []) {
      const ref = String(st.id).replace(/^bisim-/, "");
      if (st.capacity > 0) capacityByRef[ref] = st.capacity;
    }
  } catch {
    // anlık görüntü yoksa kapasite yalnızca OSM etiketinden gelir
  }
  return capacityByRef;
}

// "BİSİM" ve "Bisim" aynı işletmecidir. Türkçe İ harfi nedeniyle
// toLowerCase() yetmez — toLocaleLowerCase("tr") şarttır.
function isBisimOperator(tags) {
  const op = tags?.operator;
  return !!op && op.toLocaleLowerCase("tr") === "bisim";
}

function getRawStations(data) {
  if (!Array.isArray(data)) return [];
  return data.filter((e) => {
    // was:amenity = artık mevcut olmayan istasyon
    if (e.tags?.["was:amenity"]) return false;
    return isBisimOperator(e.tags);
  });
}

// Overpass düğümlerinde koordinat doğrudan lat/lon alanlarındadır.
function parseCoord(element) {
  if (typeof element.lat === "number" && typeof element.lon === "number") {
    return { lat: element.lat, lon: element.lon };
  }
  return null;
}

function mapToStation(e) {
  const ref = e.tags?.ref || null;
  const capacity =
    parseInt(e.tags?.capacity) || (ref ? loadCapacityByRef()[ref] : null) || null;
  return {
    id:       e.id,
    name:     e.tags?.name || `BİSİM ${ref || e.id}`,
    active:   true,
    capacity,
    // BİSİM canlı verisi 2025-07-23'ten beri hiçbir kaynakta yayınlanmıyor.
    // Uydurma sayı üretilmez; null "bilinmiyor" demektir.
    bikes:    null,
    lat:      e.lat,
    lon:      e.lon,
    ref,
  };
}

module.exports = { fetchBisim, parseCoord, getRawStations, mapToStation, isBisimOperator };
