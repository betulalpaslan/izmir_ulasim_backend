const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const config = require("../config");
const { fetchIstasyonlar, enYakinIstasyon, haversine } = require("./RayliIstasyonService");



const BUILD_CACHE_FILE = path.join(__dirname, "..", "parking_cache.json");

const GECICI_HATALAR = new Set([
  "EAI_AGAIN",     // DNS geçici olarak çözemedi
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",     // resolver ısınmamış olabilir
  "EPIPE",
]);

const TEKRAR_SAYISI  = 3;
const TEKRAR_BEKLEME = 1500;   // ms; her denemede ikiye katlanır

function bekle(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function istekle(url, ayarlar = {}) {
  let sonHata;
  for (let deneme = 1; deneme <= TEKRAR_SAYISI; deneme++) {
    try {
      return await axios.get(url, { family: 4, ...ayarlar });
    } catch (err) {
      sonHata = err;
      if (!GECICI_HATALAR.has(err.code) || deneme === TEKRAR_SAYISI) throw err;
      const gecikme = TEKRAR_BEKLEME * 2 ** (deneme - 1);
      console.warn(
        `${url} — ${err.code}, ${gecikme} ms sonra yeniden deneniyor ` +
        `(${deneme}/${TEKRAR_SAYISI - 1})`
      );
      await bekle(gecikme);
    }
  }
  throw sonHata;
}
const ESLESME_YARICAP_M = 150;   // aynı otoparkın iki kaynaktaki konumu arası azami sapma

let envanter = null;             // CKAN kaynaklı taban liste
let envanterTime = 0;
let envanterSource = null;       // "ckan" | "build-cache" | "none"

let doluluk = new Map();         // ufid → İZELMAN kaydı
let dolulukTime = 0;
let dolulukSource = null;        // "izelman" | "none"

let birlesik = [];               // dışarı verilen liste
let yenilemeTimer = null;

// ─── Envanter (CKAN) ───────────────────────────────────────────────────

function ckanKaydiniCevir(r, tip, resourceId) {
  const lat = Number(r.ENLEM), lng = Number(r.BOYLAM);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;   // koordinatsız kayıt 0,0'a düşer
  return {
    // CKAN'da ufid yok. Satır kimliği kaynak bazında sabit olduğu için id
    // turlar arasında değişmez — OTP lot kimliğini böyle takip eder.
    ufid: `CKAN-${resourceId.slice(0, 8)}-${r._id}`,
    name: r.OTOPARK_ADI || r.BLOK_ADI || "Otopark",
    lat, lng,
    type: tip,
    kapasite: Number(r.KAPASITE) || 0,
    ilce: r.ILCE || null,
    acilis: r.ACILIS_SAATI || null,
    kapanis: r.KAPANIS_SAATI || null,
    provider: "İZELMAN A.Ş",
    isPaid: null,                // CKAN ücret bilgisi taşımıyor
    occupancy: null,
    kaynak: "ckan",
  };
}

async function birKaynagiCek({ resourceId, tip }) {
  const res = await istekle(config.CKAN_DATASTORE_URL, {
    params: { resource_id: resourceId, limit: 1000 },
    timeout: config.TIMEOUT.CKAN,
  });
  if (!res.data?.success) throw new Error(`CKAN başarısız: ${resourceId}`);
  return (res.data.result.records || [])
    .map((r) => ckanKaydiniCevir(r, tip, resourceId))
    .filter(Boolean);
}

async function envanteriYenile() {
  // Üç kaynaktan biri düşerse diğerleri yine yüklenir: eksik envanter, boş
  // envanterden iyidir.
  const sonuclar = await Promise.allSettled(config.CKAN_OTOPARK_KAYNAKLARI.map(birKaynagiCek));
  const liste = sonuclar.filter((s) => s.status === "fulfilled").flatMap((s) => s.value);

  if (liste.length) {
    envanter = liste;
    envanterTime = Date.now();
    envanterSource = "ckan";
    tohumuYaz(liste);
    return;
  }
  if (envanter) return;                       // eldeki liste korunur

  if (diskYedeginiOku()) return;
  envanter = [];
  envanterSource = "none";
  console.warn("Otopark envanteri: tüm kaynaklar başarısız");
}


const TOHUM_ASGARI = 20;
function tohumuYaz(liste) {
  if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID) return;
  if (liste.length < TOHUM_ASGARI) {
    console.warn(`Otopark tohumu yazılmadı: yalnız ${liste.length} kayıt geldi (asgari ${TOHUM_ASGARI})`);
    return;
  }
  try { fs.writeFileSync(BUILD_CACHE_FILE, JSON.stringify(liste, null, 1)); } catch {}
}

function diskYedeginiOku() {
  try {
    const raw = JSON.parse(fs.readFileSync(BUILD_CACHE_FILE, "utf8"));
    if (Array.isArray(raw) && raw.length) {
      envanter = raw;
      envanterTime = Date.now();
      envanterSource = "build-cache";
      console.warn("Otopark envanteri: CKAN erişilemez, build-cache kullanılıyor");
      return true;
    }
  } catch {}
  return false;
}

// ─── Doluluk (İZELMAN) ─────────────────────────────────────────────────

async function dolulugaYenile() {
  try {
    const res = await istekle(config.IZELMAN_PARK_URL, { timeout: config.TIMEOUT.IZELMAN });
    const ham = Array.isArray(res.data) ? res.data : [];
    if (!ham.length) throw new Error("boş yanıt");
    doluluk = new Map(ham.filter((p) => p.ufid).map((p) => [p.ufid, p]));
    dolulukTime = Date.now();
    dolulukSource = "izelman";
  } catch (err) {
    // Doluluk kaybı envanteri düşürmez: otoparklar listelenmeye devam eder,
    // yalnız boş yer sayısı null olur.
    if (!doluluk.size) dolulukSource = "none";
    // Hata KODU da yazılıyor: "alınamadı" tek başına zaman aşımı mı, DNS mi,
    // 500 mü ayırt ettirmiyordu ve teşhis logdan yapılamıyordu.
    console.warn(`Otopark doluluğu alınamadı [${err.code || "?"}]:`, err.message);
  }
}

// ─── Birleştirme ───────────────────────────────────────────────────────

// Türkçe karakterleri ve noktalamayı düşürür; iki kaynağın aynı otoparkı
// farklı yazdığı durumları karşılaştırılabilir hale getirir
// ("08 Vasif Cinar Yol Kenarı Otopark" ↔ "VASIFÇINAR  BULVARI  - 2").
const TR = { "İ": "I", "I": "I", "ı": "I", "Ş": "S", "ş": "S", "Ğ": "G", "ğ": "G",
             "Ü": "U", "ü": "U", "Ö": "O", "ö": "O", "Ç": "C", "ç": "C" };
function adNormalize(s) {
  return String(s || "").replace(/[İIıŞşĞğÜüÖöÇç]/g, (c) => TR[c])
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

// Ortak anlamlı kelime sayısı. "OTOPARK", "BULVARI" gibi her isimde geçen
// kelimeler ayırt edici olmadığı için elenir — yoksa her kayıt her kayda benzer.
const DOLGU = new Set(["OTOPARK", "OTOPARKI", "BULVARI", "BULVAR", "YOL", "KENARI",
                       "CD", "SK", "SOKAK", "CADDESI", "KATLI", "YER", "ALTI", "ALTINDA"]);
function anlamliKelimeler(s) {
  return adNormalize(s).split(" ").filter((t) => t.length > 2 && !DOLGU.has(t));
}

function isimSkoru(a, b) {
  const ta = anlamliKelimeler(a), tb = anlamliKelimeler(b);
  if (!ta.length || !tb.length) return 0;
  const kume = new Set(tb);
  const ortak = ta.filter((t) => kume.has(t)).length;
  if (ortak) return ortak;
  // "VASIF CINAR" ↔ "VASIFCINAR": iki kaynak aynı adı farklı bölüyor, kelime
  // kesişimi bulamaz. Dolgu kelimeler atıldıktan sonra kalan çekirdekler
  // birbirini kapsıyorsa aynı yerdir.
  const ca = ta.join(""), cb = tb.join("");
  if (ca.length > 5 && cb.length > 5 && (ca.includes(cb) || cb.includes(ca))) return 1;
  return 0;
}


function enYakinEnvanterKaydi(lot, liste) {
  const t = lot.occupancy?.total;
  const lotKap = ((t?.free) || 0) + ((t?.occupied) || 0);

  let enIyi = null;
  for (const e of liste) {
    const d = haversine(lot.lat, lot.lng, e.lat, e.lng);
    if (d > ESLESME_YARICAP_M) continue;

    const isim = isimSkoru(lot.name, e.name);
    const kapSkor = lotKap && e.kapasite
      ? 1 - Math.min(1, Math.abs(e.kapasite - lotKap) / Math.max(e.kapasite, lotKap))
      : 0;
    const puan = 2 * isim + kapSkor - d / ESLESME_YARICAP_M;

    // İsim de tutmuyor kapasite de çok uzaksa bağlama: yanlış otoparkın
    // doluluğunu göstermektense doluluğu hiç göstermemek yeğdir.
    if (!isim && kapSkor < 0.6) continue;

    if (!enIyi || puan > enIyi.puan) enIyi = { e, puan };
  }
  return enIyi?.e || null;
}

function birlestir() {
  const taban = (envanter || []).map((e) => ({ ...e }));
  const eslesmis = new Set();

  for (const canli of doluluk.values()) {
    if (!Number.isFinite(canli.lat) || !Number.isFinite(canli.lng)) continue;
    // Bir envanter kaydına yalnız bir canlı kayıt bağlanır; ikinci aday
    // üstüne yazmak yerine kendi satırı olarak durur (aşağıya düşer).
    const aday = enYakinEnvanterKaydi(canli, taban);
    const hedef = aday && !eslesmis.has(aday.ufid) ? aday : null;
    if (hedef) {
      hedef.occupancy    = canli.occupancy || null;
      hedef.nonstop      = canli.nonstop;
      hedef.openingHours = canli.openingHours;
      hedef.isPaid       = canli.isPaid ?? hedef.isPaid;
      hedef.poi          = canli.poi;
      hedef.ufidCanli    = canli.ufid;
      hedef.kaynak       = "ckan+izelman";
      eslesmis.add(hedef.ufid);
    } else {
      // Envanterde karşılığı olmayan sensörlü otopark atılmaz: doluluk verisi
      // olan bir kaydı kaybetmek, mükerrer göstermekten kötüdür.
      taban.push({ ...canli, kapasite: 0, kaynak: "izelman" });
    }
  }

  // P+R kararının girdisi: en yakın raylı/vapur istasyonuna mesafe.
  for (const l of taban) {
    const yakin = enYakinIstasyon(l.lat, l.lng);
    l.rayliMesafeM = yakin ? yakin.mesafeM : null;
    l.rayliTip     = yakin ? yakin.tip : null;
    l.rayliAd      = yakin ? yakin.ad : null;
  }

  birlesik = taban;
}


let yenileniyor = null;

async function yenile() {
  if (yenileniyor) return yenileniyor;
  yenileniyor = (async () => {
    try {
      const isler = [dolulugaYenile(), fetchIstasyonlar().catch(() => {})];
      if (!envanter || Date.now() - envanterTime >= config.TTL.PARK_ENVANTER) {
        isler.push(envanteriYenile());
      }
      await Promise.all(isler);
      birlestir();
    } finally {
      yenileniyor = null;
    }
  })();
  return yenileniyor;
}

// Sunucu açılışında bir kez çağrılır. İlk turu bekler (o an cache boştur),
// sonrasını arka plana alır.
async function baslatYenileme() {
  await yenile();
  if (!yenilemeTimer) {
    yenilemeTimer = setInterval(() => { yenile().catch(() => {}); }, config.TTL.PARKING);
    yenilemeTimer.unref?.();
  }
  return birlesik;
}

function durdurYenileme() {
  if (yenilemeTimer) { clearInterval(yenilemeTimer); yenilemeTimer = null; }
}

// İstek yolundan çağrılır ve ASLA ağ beklemez. Liste henüz hiç dolmadıysa
// disk yedeğiyle tohumlanır; yenileme zaten arka planda dönüyordur.
function fetchParks() {
  if (!birlesik.length) {
    if (!envanter) diskYedeginiOku();
    if (envanter) birlestir();
  }
  return birlesik;
}

function isParkAndRide(p) {
  if (p.type === "OffStreet") return true;
  if (Number.isFinite(p.rayliMesafeM) && p.rayliMesafeM <= config.PR_YARICAP_M) return true;
  const nearRail = p.poi?.metroStation || p.poi?.trainStation || p.poi?.tramStation;
  return !!nearRail;
}

function kapasiteHesapla(p) {
  const t = p.occupancy?.total;
  if (t && (t.free != null || t.occupied != null)) return (t.free || 0) + (t.occupied || 0);
  return p.kapasite || 0;
}

const HHMM = /^(\d{1,2}):(\d{2})$/;
function dakikaya(s) {
  const m = HHMM.exec(String(s == null ? "" : s).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const GUNLER = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];


function acikMi(p, simdi = new Date()) {
  if (p.nonstop === true) return true;
  let acilis = p.acilis, kapanis = p.kapanis;
  if (acilis == null && p.openingHours) {
    // İZELMAN aralığı "07:00 – 22:00" biçiminde ve ayraç uzun tire.
    const aralik = String(p.openingHours[GUNLER[simdi.getDay()]] || "").split(/[–—-]/);
    if (aralik.length === 2) { acilis = aralik[0]; kapanis = aralik[1]; }
  }
  const a = dakikaya(acilis), k = dakikaya(kapanis);
  if (a == null || k == null) return true;
  if (a === k || k >= 24 * 60) return true;                          // 00:00–24:00 = kesintisiz
  const su = simdi.getHours() * 60 + simdi.getMinutes();
  return k > a ? su >= a && su < k : su >= a || su < k;              // gece aşan aralık
}

function toOtpParking(p) {
  const t = p.occupancy?.total;
  const dolulukVar = !!t && (t.free != null || t.occupied != null);
  const lot = {
    id:     p.ufid,                 // OTP başına feedId ekler → "izmir-pr:<ufid>"
    name:   p.name,
    coords: { lat: p.lat, lng: p.lng },
    state:  acikMi(p) ? "open" : "closed",
    total:  kapasiteHesapla(p),
  };

  if (dolulukVar) lot.free = t.free || 0;
  return lot;
}

function toParkingStation(p) {
  const t = p.occupancy?.total;
  const dolulukVar = !!t && (t.free != null || t.occupied != null);
  return {
    id:        p.ufid,
    name:      p.name,
    lat:       p.lat,
    lon:       p.lng,
    type:      p.type,
    capacity:  kapasiteHesapla(p),
    free:      dolulukVar ? t.free || 0 : null,
    occupied:  dolulukVar ? t.occupied || 0 : null,
    status:    acikMi(p) ? "Opened" : "Closed",
    isPaid:    p.isPaid == null ? null : p.isPaid,
    // Hangi istasyona ne kadar yakın olduğu artık ölçülüyor, tahmin edilmiyor.
    nearMetro: p.rayliTip === "metro" || !!p.poi?.metroStation,
    nearTrain: p.rayliTip === "tren" || p.rayliTip === "izban" || !!p.poi?.trainStation,
    nearTram:  !!p.poi?.tramStation,
    nearFerry: p.rayliTip === "iskele",
    railDistanceM: p.rayliMesafeM == null ? null : p.rayliMesafeM,
    railName:  p.rayliAd == null ? null : p.rayliAd,
    provider:  p.provider,
    source:    p.kaynak || null,
  };
}

const RAYLI_MODLAR = new Set(["SUBWAY", "RAIL", "TRAM"]);

const ISTASYON_KUMELEME_M = 150;


const ISTASYON_BISIKLET_KAPASITESI = 20;

const RAYLI_DURAK_CACHE = path.join(__dirname, "..", "rayli_durak_cache.json");

let rayliDurakListesi = null;
let rayliDurakZamani = 0;

function rayliDuraklariKumele(duraklar) {
  const kumeler = [];
  for (const d of duraklar) {
    const mevcut = kumeler.find((k) => haversine(k.lat, k.lon, d.lat, d.lon) <= ISTASYON_KUMELEME_M);
    if (mevcut) { mevcut.uyeler.push(d); continue; }
    kumeler.push({ lat: d.lat, lon: d.lon, ad: d.ad, uyeler: [d] });
  }
  return kumeler;
}


async function rayliDuraklar() {
  if (rayliDurakListesi && Date.now() - rayliDurakZamani < config.TTL.ISTASYON) {
    return rayliDurakListesi;
  }
  try {
    const res = await axios.post(
      config.OTP_URL,
      { query: "{ stops { name lat lon routes { mode } } }" },
      { timeout: config.TIMEOUT.OTP_SORGU }
    );
    const ham = res.data?.data?.stops || [];
    const rayli = ham
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
      .filter((s) => (s.routes || []).some((r) => RAYLI_MODLAR.has(r.mode)))
      .map((s) => ({ ad: s.name || "İstasyon", lat: s.lat, lon: s.lon }));
    if (!rayli.length) throw new Error("raylı durak bulunamadı");

    rayliDurakListesi = rayliDuraklariKumele(rayli).map((k) => ({ ad: k.ad, lat: k.lat, lon: k.lon }));
    rayliDurakZamani = Date.now();
    if (process.env.NODE_ENV !== "test" && !process.env.JEST_WORKER_ID) {
      try { fs.writeFileSync(RAYLI_DURAK_CACHE, JSON.stringify(rayliDurakListesi)); } catch {}
    }
    return rayliDurakListesi;
  } catch (err) {
    console.warn("Raylı durak listesi alınamadı:", err.message);
    if (rayliDurakListesi) return rayliDurakListesi;
    try {
      const raw = JSON.parse(fs.readFileSync(RAYLI_DURAK_CACHE, "utf8"));
      if (Array.isArray(raw) && raw.length) {
        rayliDurakListesi = raw;
        rayliDurakZamani = Date.now();
        return rayliDurakListesi;
      }
    } catch {}
    return [];
  }
}


function rayliDuraklariUnut() {
  rayliDurakListesi = null;
  rayliDurakZamani = 0;
}

const slug = (s) => adNormalize(s).replace(/ /g, "-") || "ISTASYON";


async function bisikletParkYerleri() {
  const lots = [];
  const gorulen = new Set();

  for (const d of await rayliDuraklar()) {
    const id = `rail-${slug(d.ad)}-${d.lat.toFixed(4)}-${d.lon.toFixed(4)}`;
    if (gorulen.has(id)) continue;
    gorulen.add(id);
    lots.push({
      id,
      name: `${d.ad} istasyonu bisiklet parkı`,
      coords: { lat: d.lat, lng: d.lon },
      state: "open",
      total: ISTASYON_BISIKLET_KAPASITESI,
    });
  }

  for (const p of fetchParks()) {
    if (!isParkAndRide(p)) continue;
    if (p.lat == null || p.lng == null) continue;
    const lot = toOtpParking(p);
    // Doluluk ARABA yerlerinindir; bisiklet için anlamı yok. `free`
    // taşınırsa OTP dolu bir otoparka bisiklet de park edilemez sayar.
    delete lot.free;
    lots.push({ ...lot, id: `bike-${lot.id}`, total: ISTASYON_BISIKLET_KAPASITESI });
  }

  return lots;
}

function getStatus() {
  const now = Date.now();
  return {
    source:      envanterSource,
    envanter:    {
      source: envanterSource,
      ageSec: envanter ? Math.floor((now - envanterTime) / 1000) : null,
      lots:   envanter ? envanter.length : null,
    },
    doluluk:     {
      source: dolulukSource,
      ageSec: doluluk.size ? Math.floor((now - dolulukTime) / 1000) : null,
      lots:   doluluk.size || null,
    },
    ageSec:      envanter ? Math.floor((now - envanterTime) / 1000) : null,
    lots:        birlesik.length || null,
    dolulukluLots: birlesik.filter((p) => p.occupancy?.total).length || null,
    parkAndRide: birlesik.length ? birlesik.filter(isParkAndRide).length : null,
  };
}

module.exports = {
  fetchParks, baslatYenileme, durdurYenileme, yenile,
  isParkAndRide, toOtpParking, toParkingStation, acikMi, getStatus,
  bisikletParkYerleri, rayliDuraklar, rayliDuraklariUnut,
  enYakinEnvanterKaydi, isimSkoru,
};
