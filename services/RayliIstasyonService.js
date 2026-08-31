const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const config = require("../config");

// ─── Raylı sistem + vapur istasyonları ─────────────────────────────────
// Tek işi var: bir koordinatın en yakın istasyona kaç metre uzakta olduğunu
// söylemek. ParkingService bunu "bu otopark P+R sayılır mı" kararında
// kullanır.
//
// Neden ayrı bir servis: P+R sınıflandırması önce İZELMAN feed'indeki
// `poi.metroStation` bayraklarına bakıyordu. O bayraklar yalnız sensörlü 14
// otoparkta var; CKAN envanterindeki 82 otoparkın hiçbirinde yok. Bayrak
// yerine mesafe ölçülünce sınıflandırma kaynaktan bağımsız hale geliyor.
//
// StopIndexService de durak yakınlığı hesaplar ama OTP'den TÜM durakları
// çeker (mod bilgisi olmadan, otobüs dahil) ve OTP ayakta olmasını gerektirir.
// Burada kaynak doğrudan açık veri portalı: OTP kapalıyken de çalışır ve
// yalnız raylı + vapur döner.

const CACHE_FILE = path.join(__dirname, "..", "istasyon_cache.json");
const HUCRE = 0.0045;          // ~500 m'lik ızgara hücresi
const R = 6371000, D = Math.PI / 180;

// Türler AYRI AYRI saklanır. Hepsi tek listede tutulup her turda baştan
// yazıldığında, uçlardan biri o an yavaş olduğunda o türün istasyonları
// sessizce kayboluyordu: ölçüldü, bir turda 91 istasyon yerine 36 yüklendi
// (İZBAN 41 + iskele 14 düştü) ve P+R sayısı 52'den 44'e indi. Kimse hata
// görmedi. Artık başarısız tür ESKİ verisini korur.
let turler = new Map();        // tip → istasyon dizisi
let turZamani = new Map();     // tip → son başarılı çekim zamanı
let istasyonlar = null;
let cacheTime = 0;
let cacheSource = null;        // "canli" | "kismi" | "build-cache" | "none"
let sonHatalar = [];           // tazelenemeyen türler — /health bunu okur
let izgara = null;

function haversine(lat1, lon1, lat2, lon2) {
  const dLa = (lat2 - lat1) * D, dLo = (lon2 - lon1) * D;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

const anahtar = (lat, lon) => Math.floor(lat / HUCRE) + "|" + Math.floor(lon / HUCRE);

// Dört ucun gövdesi dört farklı biçimde geliyor: alan adları Türkçe ama
// tutarsız (Adi/IstasyonAdi/ADI), enlem kimi yerde string, tren garları ise
// sayfalı bir zarfın `onemliyer` alanında. Normalleştirme burada bitiyor.
const AYRISTIRICILAR = {
  metro:  (d) => (Array.isArray(d) ? d : []).map((r) => ({ lat: +r.Enlem, lon: +r.Boylam, ad: r.Adi })),
  izban:  (d) => (Array.isArray(d) ? d : []).map((r) => ({ lat: +r.Enlem, lon: +r.Boylam, ad: r.IstasyonAdi })),
  iskele: (d) => (Array.isArray(d) ? d : []).map((r) => ({ lat: +r.Enlem, lon: +r.Boylam, ad: r.Adi })),
  tren:   (d) => (d?.onemliyer || []).map((r) => ({ lat: +r.ENLEM, lon: +r.BOYLAM, ad: r.ADI })),
};

async function birUcuCek(tip, url) {
  const res = await axios.get(url, { timeout: config.TIMEOUT.ISTASYON });
  return AYRISTIRICILAR[tip](res.data)
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({ ...s, tip }));
}

function izgarayiKur(liste) {
  const g = new Map();
  for (const s of liste) {
    const k = anahtar(s.lat, s.lon);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(s);
  }
  return g;
}

function yaz(liste, kaynak) {
  istasyonlar = liste;
  izgara = izgarayiKur(liste);
  cacheTime = Date.now();
  cacheSource = kaynak;
}

// Disk yedeğini türlere dağıtarak yükler. Eski biçim (düz dizi) de okunur.
function diskYedeginiYukle() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!Array.isArray(raw) || !raw.length) return false;
    for (const s of raw) {
      const tip = s.tip || "metro";
      if (!turler.has(tip)) turler.set(tip, []);
      turler.get(tip).push(s);
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchIstasyonlar() {
  if (istasyonlar && Date.now() - cacheTime < config.TTL.ISTASYON) return istasyonlar;

  // Henüz hiç veri yoksa önce diskten tohumla: aşağıdaki uçlardan biri
  // düşerse o türün istasyonları en azından yedekten gelir.
  if (!turler.size) diskYedeginiYukle();

  const girisler = Object.entries(config.ISTASYON_URLS);
  const sonuclar = await Promise.allSettled(girisler.map(([tip, url]) => birUcuCek(tip, url)));

  sonHatalar = [];
  sonuclar.forEach((s, i) => {
    const tip = girisler[i][0];
    if (s.status === "fulfilled" && s.value.length) {
      turler.set(tip, s.value);
      turZamani.set(tip, Date.now());
    } else {
      // Sessiz geçilmiyor: bu tür eski verisiyle devam ediyor ve bunu
      // /health'te görebilmek gerekiyor.
      const sebep = s.status === "rejected" ? s.reason?.message : "boş yanıt";
      sonHatalar.push(`${tip}: ${sebep}`);
      console.warn(`İstasyon [${tip}] tazelenemedi (${sebep}) — ${turler.get(tip)?.length || 0} eski kayıtla devam`);
    }
  });

  const liste = [...turler.values()].flat();
  if (!liste.length) {
    cacheSource = "none";
    console.warn("İstasyon: tüm kaynaklar başarısız — P+R sınıflandırması yalnız OffStreet'e düşecek");
    yaz([], "none");
    return istasyonlar;
  }

  yaz(liste, sonHatalar.length ? "kismi" : "canli");
  // Disk yedeği yalnız TÜM türler tazeyken yazılır: kısmi bir listeyi diske
  // yazmak, eksikliği kalıcı hale getirirdi.
  // Test ortamında yazılmaz: sözleşme testi tek sahte istasyonla çalışıyor ve
  // koruma olmadan gerçek 91 kayıtlık tohumu eziyordu (bkz. ParkingService
  // tohumuYaz — aynı arıza).
  if (!sonHatalar.length && process.env.NODE_ENV !== "test" && !process.env.JEST_WORKER_ID) {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(liste)); } catch {}
  }
  return istasyonlar;
}

// En yakın istasyona mesafe (m) ve o istasyonun türü. İstasyon indeksi hiç
// yüklenmemişse null döner — çağıran bunu "bilinmiyor" diye yorumlamalı,
// "yakında istasyon yok" diye değil.
function enYakinIstasyon(lat, lon) {
  if (!izgara || !istasyonlar?.length) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // Önce 3x3 hücre (~1.5 km) taranır; boş çıkarsa tam listeye düşülür.
  // Otoparkların çoğu ilk turda eşleşir, tam tarama nadiren çalışır.
  const i = Math.floor(lat / HUCRE), j = Math.floor(lon / HUCRE);
  const adaylar = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const h = izgara.get(`${i + di}|${j + dj}`);
      if (h) adaylar.push(...h);
    }
  }
  const havuz = adaylar.length ? adaylar : istasyonlar;

  let enIyi = null;
  for (const s of havuz) {
    const d = haversine(lat, lon, s.lat, s.lon);
    if (!enIyi || d < enIyi.mesafeM) enIyi = { mesafeM: Math.round(d), tip: s.tip, ad: s.ad };
  }
  return enIyi;
}

function getStatus() {
  const turDetay = {};
  for (const [tip, liste] of turler) turDetay[tip] = liste.length;
  return {
    source: cacheSource,
    ageSec: istasyonlar ? Math.floor((Date.now() - cacheTime) / 1000) : null,
    istasyon: istasyonlar ? istasyonlar.length : null,
    turler: turDetay,
    // Boş değilse: P+R sayısı olması gerekenden düşük, sebebi burada.
    tazelenemeyen: sonHatalar,
  };
}

module.exports = { fetchIstasyonlar, enYakinIstasyon, haversine, getStatus };
