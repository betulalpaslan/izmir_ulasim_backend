const axios = require("axios");
const fs = require("fs");
const config = require("../config");


const OVERPASS_MIRRORS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];


const IZMIR_BBOX = "38.2,26.8,38.6,27.5";

const VARSAYILAN_TTL     = config.TTL.OVERPASS;
const VARSAYILAN_BACKOFF = config.OVERPASS_BACKOFF;


function createOverpassSource({ ad, query, cacheFile, ttlMs = VARSAYILAN_TTL, backoffMs = VARSAYILAN_BACKOFF, timeoutMs = config.TIMEOUT.OVERPASS }) {
  let cache = null;
  let cacheTime = 0;
  let nextAttempt = 0;
  let cacheSource = null; // "overpass" | "build-cache"

  async function fetchElements() {
    const now = Date.now();
    if (cache && now - cacheTime < ttlMs) return cache;

    // Kısa süre önce başarısız olduysa tekrar denemeden stale cache döndür.
    if (cache && now < nextAttempt) return cache;

    for (const mirror of OVERPASS_MIRRORS) {
      try {
        const res = await axios.get(`${mirror}?data=${encodeURIComponent(query)}`, { timeout: timeoutMs });
        cache = res.data?.elements || [];
        cacheTime = now;
        nextAttempt = 0;
        cacheSource = "overpass";
        return cache;
      } catch {
        // bu mirror başarısız, sıradakini dene
      }
    }

    nextAttempt = now + backoffMs;

    if (cache) return cache; // stale in-memory cache yeterli

    if (cacheFile) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        cache = raw.elements || [];
        cacheTime = now;
        cacheSource = "build-cache";
        console.warn(`${ad}: Overpass erişilemez, build-cache kullanılıyor`);
        return cache;
      } catch {
        // yedek yok ya da bozuk
      }
    }

    const err = new Error(`${ad}: veri hiçbir kaynaktan alınamadı`);
    err.status = 502;
    throw err;
  }

  // /health bunu okur: "veri geliyor mu" değil, "veri NEREDEN geliyor".
  function getStatus() {
    const now = Date.now();
    return {
      source:     cacheSource,
      ageSec:     cache ? Math.floor((now - cacheTime) / 1000) : null,
      elements:   cache ? cache.length : null,
      stale:      nextAttempt > now,
      retryInSec: nextAttempt > now ? Math.floor((nextAttempt - now) / 1000) : 0,
    };
  }

  function peek() {
    return cache;
  }

  return { ad, fetch: fetchElements, getStatus, peek };
}

module.exports = { createOverpassSource, OVERPASS_MIRRORS, IZMIR_BBOX, VARSAYILAN_TTL, VARSAYILAN_BACKOFF };
