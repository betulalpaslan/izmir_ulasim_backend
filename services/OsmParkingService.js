const path = require("path");
const config = require("../config");
const { createOverpassSource, IZMIR_BBOX } = require("./OverpassService");


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
