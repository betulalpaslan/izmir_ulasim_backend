const path = require("path");
const config = require("../config");
const { createOverpassSource, IZMIR_BBOX } = require("./OverpassService");

// ─── OSM kaynaklı park yerleri ─────────────────────────────────────────
// İki ayrı katman, iki ayrı kaynak: araba otoparkları ve bisiklet parkları.
// İkisi de uygulamadan taşındı; artık cache, mirror ve disk yedeği
// arkalarında (bkz. OverpassService).
//
// Not: bisiklet parkları OTP graph'ında da var (OSM'den build edilir) ve
// /parking/otp-lots?vehicle=bicycle onları döndürür. Bu uç ise OTP'ye
// bağımlı değildir: OTP kapalıyken de harita katmanı çizilebilsin diye
// doğrudan Overpass'tan beslenir.

// Kapalı/yeraltı otoparklar + isimli açık otoparklar. İsimsiz yüzey
// otoparkları kasten dışarıda: OSM'de her market önü işaretlenmiş durumda
// ve haritayı okunmaz hâle getiriyorlar.
const OTOPARK_SORGUSU = `
  [out:json][timeout:10];
  (
    node[amenity=parking][parking~"multi-storey|underground"](${IZMIR_BBOX});
    way[amenity=parking][parking~"multi-storey|underground"](${IZMIR_BBOX});
    node[amenity=parking][parking=surface][name](${IZMIR_BBOX});
    way[amenity=parking][parking=surface][name](${IZMIR_BBOX});
  );
  out center;
`;

const BISIKLET_PARK_SORGUSU = `[out:json];node[amenity=bicycle_parking](${IZMIR_BBOX});out;`;

const otoparkKaynak = createOverpassSource({
  ad: "OsmParking",
  query: OTOPARK_SORGUSU,
  cacheFile: path.join(__dirname, "..", "osm_parking_cache.json"),
  timeoutMs: config.TIMEOUT.OVERPASS_AGIR, // way + out center sorgusu node sorgusundan yavaş
});

const bisikletParkKaynak = createOverpassSource({
  ad: "BicycleParking",
  query: BISIKLET_PARK_SORGUSU,
  cacheFile: path.join(__dirname, "..", "bike_parking_cache.json"),
});

// way'lerin koordinatı `out center` ile center.lat/lon'a düşer; node'larda
// doğrudan lat/lon vardır. İkisini de karşılamayan kayıt atılır — koordinatsız
// bir otopark haritada 0,0'a, yani Gine Körfezi'ne düşer.
function toOsmParking(e) {
  return {
    id:       e.id,
    name:     e.tags?.name || null,
    lat:      e.lat ?? e.center?.lat,
    lon:      e.lon ?? e.center?.lon,
    type:     e.tags?.parking || "surface",
    fee:      e.tags?.fee === "yes" ? true : e.tags?.fee === "no" ? false : null,
    capacity: parseInt(e.tags?.capacity) || null,
  };
}

function toBicycleParking(e) {
  return {
    id:       e.id,
    lat:      e.lat,
    lon:      e.lon,
    // OSM'de bisiklet parklarının çoğunda capacity etiketi yok. Bilinmiyorsa
    // null'dır; uydurma bir sayı kullanıcıya gerçek yuva sayısı gibi görünür.
    capacity: parseInt(e.tags?.capacity) || null,
    covered:  e.tags?.covered === "yes" ? true : e.tags?.covered === "no" ? false : null,
  };
}

const koordinatliMi = (p) => p.lat != null && p.lon != null;

async function fetchOsmParkingSpots() {
  return (await otoparkKaynak.fetch()).map(toOsmParking).filter(koordinatliMi);
}

async function fetchBicycleParkings() {
  return (await bisikletParkKaynak.fetch()).map(toBicycleParking).filter(koordinatliMi);
}

function getStatus() {
  return { osmParking: otoparkKaynak.getStatus(), bicycleParking: bisikletParkKaynak.getStatus() };
}

module.exports = {
  fetchOsmParkingSpots,
  fetchBicycleParkings,
  toOsmParking,
  toBicycleParking,
  getStatus,
  OTOPARK_SORGUSU,
  BISIKLET_PARK_SORGUSU,
};
