const axios = require("axios");
const fs = require("fs");

// ─── Overpass erişiminin tek yeri ──────────────────────────────────────
// Uygulama bu sorguları bir süre doğrudan kendi cihazından çekiyordu.
// Üç şey kaybediliyordu: 24 saatlik cache, üç mirror denemesi ve disk
// yedeği. Dördüncüsü daha sinsiydi — Overpass'ın hız sınırı her kullanıcının
// cihazına ayrı uygulandığı için kalabalık saatte rastgele kullanıcılar
// boş katman görüyordu. Erişim artık tek bir yerden, tek IP üzerinden.

// Sıra bilinçli: overpass-api.de resmi ama en yüklü sunucu, bu yüzden sonda.
const OVERPASS_MIRRORS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

// Overpass kutu sırası: güney,batı,kuzey,doğu (lat,lon,lat,lon).
// DİKKAT: Photon/Nominatim bbox'ı batı,güney,doğu,kuzey sırasındadır —
// aynı sayılar farklı sırayla yazılır, bkz. GeocodingService.
const IZMIR_BBOX = "38.2,26.8,38.6,27.5";

const VARSAYILAN_TTL     = 24 * 60 * 60 * 1000; // istasyon/otopark konumları nadiren değişir
const VARSAYILAN_BACKOFF =  6 * 60 * 60 * 1000; // tüm mirror'lar düştü → 6 saat tekrar deneme

// Her Overpass kaynağı kendi cache'i, kendi backoff'u ve kendi disk yedeğiyle
// yaşar; biri düşünce diğerleri etkilenmez.
function createOverpassSource({ ad, query, cacheFile, ttlMs = VARSAYILAN_TTL, backoffMs = VARSAYILAN_BACKOFF, timeoutMs = 8000 }) {
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

    // İlk yükleme ve Overpass yok — build sırasında indirilen yedeğe düş.
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

    // 502: hata bizde değil, yukarı akışta. İstemci için fark önemli —
    // 502 "tekrar dene", 500 "burada bir hata var" demektir.
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

  // Bellekteki ham veriyi ağ isteği YAPMADAN verir (yoksa null).
  // Yalnız /health için: "kaç istasyon süzgeçten geçiyor" gibi kaynağa özel
  // sayıları hesaplayabilmek gerekiyor, ama sağlık ucu Overpass'ı tetiklememeli.
  function peek() {
    return cache;
  }

  return { ad, fetch: fetchElements, getStatus, peek };
}

module.exports = { createOverpassSource, OVERPASS_MIRRORS, IZMIR_BBOX, VARSAYILAN_TTL, VARSAYILAN_BACKOFF };
