const fs    = require("fs");
const path  = require("path");
const { createOverpassSource, IZMIR_BBOX } = require("./OverpassService");

// Overpass erişimi (mirror sırası, 24 saat cache, 6 saat backoff, disk
// yedeği) OverpassService'te ortak. Burada kalan tek şey BİSİM'e özgü olan:
// hangi sorgu çekilir ve gelen düğümler nasıl süzülüp zenginleştirilir.
const bisimKaynak = createOverpassSource({
  ad: "BikeShare",
  query: `[out:json];node[amenity=bicycle_rental](${IZMIR_BBOX});out;`,
  cacheFile: path.join(__dirname, "..", "bisim_cache.json"),
});

const fetchBisim = bisimKaynak.fetch;

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

// ─── Sağlık durumu ─────────────────────────────────────────────────────
// Kaynağın kendi durumu (nereden geldi, ne kadar eski, backoff'ta mı) +
// BİSİM'e özgü tek sayı: süzgeçten geçen istasyon adedi. "Overpass yanıt
// veriyor ama BİSİM istasyonu 0" durumu ancak burada görülür.
function getStatus() {
  const ham = bisimKaynak.peek();
  return { ...bisimKaynak.getStatus(), stations: ham ? getRawStations(ham).length : null };
}

module.exports = { fetchBisim, parseCoord, getRawStations, mapToStation, isBisimOperator, getStatus };
