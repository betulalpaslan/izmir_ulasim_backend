const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const config = require("../config");
const { fetchIstasyonlar, enYakinIstasyon, haversine } = require("./RayliIstasyonService");

// ─── Otopark verisi ────────────────────────────────────────────────────
// İki kaynak, iki farklı iş:
//
//   ENVANTER  — İzmir Açık Veri (CKAN), 82 otopark. Kapasite, konum, çalışma
//               saati. Doluluk YOK. Nadiren değişir, günlük tazelenir.
//   DOLULUK   — İZELMAN openapi ucu, 14 otopark. Anlık boş/dolu. Envanterin
//               üstüne koordinat eşleşmesiyle binlenir.
//
// Önceden yalnız İZELMAN kullanılıyordu ve envanter ondan türetiliyordu:
// sensörü olmayan 68 otopark hiç var olmamış gibi davranılıyordu. Doluluğu
// bilinmeyen bir otoparkı listelememek, onu göstermemekten daha kötü —
// kapasitesi ve konumu biliniyor, rotalama için bu yeterli.
//
// İkinci değişiklik: ağ artık istek yolunda beklenmez. İZELMAN ucu ölçülen
// üç denemede 48.8 / 57.0 / 58.3 saniyede yanıtladı; 8 saniyelik timeout her
// turda dolup /parking/feed'i 8 saniye geciktiriyordu. OTP'nin ParkAPI
// updater'ı 5 saniyede vazgeçtiği için graph'a HİÇBİR otopark girmiyordu
// (otp.log'da 237 başarısız çekim, tek bir başarı yok). Artık istekler eldeki
// listeyi anında döner, yenileme arka planda çalışır.

const BUILD_CACHE_FILE = path.join(__dirname, "..", "parking_cache.json");
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
  const res = await axios.get(config.CKAN_DATASTORE_URL, {
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

// Disk tohumunu yazmanın İKİ koşulu var, ikisi de ölçülmüş arızadan geliyor:
//
//  1. Test ortamında hiç yazılmaz. Sözleşme testi mock'lanmış CKAN yanıtıyla
//     yenile() çağırıyor; koruma olmadan 82 kayıtlık gerçek tohum dosyası 3
//     sahte kayıtla eziliyordu ve sunucu bir sonraki açılışta onu okuyup 2
//     otopark gösteriyordu. Test, ürettiği veriyi depoya sızdırmamalı.
//  2. Şüpheli derecede kısa liste yazılmaz. Üç CKAN kaynağından ikisi
//     düştüğünde elde 11 kayıt kalır; onu tohum diye kalıcılaştırmak, geçici
//     bir kesintiyi kalıcı veri kaybına çevirir.
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
    const res = await axios.get(config.IZELMAN_PARK_URL, { timeout: config.TIMEOUT.IZELMAN });
    const ham = Array.isArray(res.data) ? res.data : [];
    if (!ham.length) throw new Error("boş yanıt");
    doluluk = new Map(ham.filter((p) => p.ufid).map((p) => [p.ufid, p]));
    dolulukTime = Date.now();
    dolulukSource = "izelman";
  } catch (err) {
    // Doluluk kaybı envanteri düşürmez: otoparklar listelenmeye devam eder,
    // yalnız boş yer sayısı null olur.
    if (!doluluk.size) dolulukSource = "none";
    console.warn("Otopark doluluğu alınamadı:", err.message);
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

// İZELMAN kaydını envanterdeki karşılığına bağlar. Ortak bir anahtar yok
// (CKAN'da ufid, İZELMAN'da CKAN satır numarası bulunmuyor), bu yüzden
// eşleştirme konuma göre yapılır. 150 m, aynı otoparkın iki kaynakta farklı
// noktalardan (giriş / alan merkezi) işaretlenmesini karşılar.
//
// Ama YALNIZ mesafe yetmiyor. Ölçüldü: Ali Çetinkaya yol kenarı otoparkı
// (28 yer) 49 m ötedeki ALSANCAK YER ALTI'na (133 yer) bağlanıyordu; doğru
// karşılığı olan ALİ ÇETİNKAYA BULVARI (30 yer) 62 m'de, yani biraz daha
// uzaktaydı. Sonuç: 133 araçlık bir yeraltı garajı haritada 28 yer kapasiteli
// görünüyor ve başka bir otoparkın doluluğunu gösteriyordu.
//
// Bu yüzden aday, üç sinyalin birleşiminden seçilir: isim benzerliği (en
// ağırlıklı — sokak adı iki kaynakta da yazıyor), kapasite yakınlığı, mesafe.
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

// ─── Yenileme döngüsü ──────────────────────────────────────────────────

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

// ─── Sınıflandırma ve dönüşümler ───────────────────────────────────────

// Bir otoparkın "Park + Devam" sayılması.
//
// Eskiden yalnız İZELMAN'ın `poi.metroStation` gibi bayraklarına bakıyordu.
// O bayraklar sensörlü 14 kayıtta var, envanterin kalan 68'inde yok — yani
// kural, veri kaynağının kapsamına göre sonuç veriyordu. Artık asıl ölçüt
// istasyona olan gerçek mesafe; `poi` yalnız geriye dönük yedek olarak duruyor
// (kaynak onu doldurduysa yok saymak için sebep yok).
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

// Çalışma saatinden açık/kapalı kararı.
//
// İZELMAN'ın `status` alanı KULLANILMIYOR: canlı yanıtta 14 otoparkın 13'ü,
// çalışma saati 07:00–22:00 yazmasına rağmen öğle vakti "Closed" bildiriyor.
// Bu değer OTP'ye state:"closed" olarak geçtiğinde OTP o otoparkta park etmeyi
// hiç denemez — yani feed düzelse bile P+R rotası üretilmezdi.
//
// Saat bilinmiyorsa AÇIK kabul edilir: yanlışlıkla açık saymak bir otoparkı
// gereksiz önerir, yanlışlıkla kapalı saymak onu tamamen görünmez kılar.
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

// OTP ParkAPI formatı (offenesdresden/ParkAPI şeması).
// OTP'nin ParkAPIUpdater'ı gövdede "lots" dizisi arar ve her lot için
// coords.lat / coords.lng / total / free alanlarını okur. Eski
// {vehicleParkings:[{x,y,capacity,availability}]} biçimi hiçbir alanı
// karşılamadığı için OTP sessizce 0 otopark yüklüyordu.
// state ZORUNLUDUR: OTP null kontrolü yapmadan okur, eksikse updater düşer.
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
  // free YALNIZCA gerçekten biliniyorsa gönderilir. Bilinmeyeni 0 yazmak
  // OTP'ye "bu otopark dolu" demektir ve otoparkı rotalamadan tamamen düşürür
  // — kapasitesi bilinen 68 statik otoparkın hepsi böyle kaybolurdu.
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

// ─── Bisiklet park yerleri (BICYCLE_PARK_API feed'i) ───────────────────
//
// Neden ayrı bir feed gerekti — ölçüm, Narlıdere → Çiğli, Pzt 08:00,
// "bisikletim + aktarma" modu:
//
//   BİSİKLET 18 dk / 4.2 km  →  OTOBÜS 311, 13 dk  →  METRO M1
//
// Yani kullanıcı metroya bisikletle gidebilecekken, metronun 3 km beriside
// bisikletini bırakıp araya bir otobüs bacağı sıkıştırılıyordu. Sebep
// rotalamada değil VERİDE: OTP'nin bisiklet bacağı ancak bisiklet park yeri
// OLAN bir noktada bitebilir, ve graph'taki 87 bisiklet parkının tamamı
// OSM'den geliyor — İnciraltı, Sahilevleri, Bostanlı gibi sahil/rekreasyon
// noktaları. Raylı sistem istasyonlarının hiçbirinde kayıt yok. OTP de en
// yakın gerçek park yerini seçip kalan mesafeyi otobüsle kapatıyordu.
//
// Bizim /parking/feed'imiz bu boşluğu dolduramıyordu: PARK_API kaynak tipi
// lotları YALNIZ araba için kaydeder. OTP'nin BICYCLE_PARK_API tipi aynı
// gövdeyi bisiklet yeri olarak yutar — bu feed onun içindir.
//
// ── Kaynak neden RayliIstasyonService DEĞİL ──
// İlk deneme istasyonları İZULAŞ'ın açık veri uçlarından aldı ve ÖLÇÜMDE
// DAHA KÖTÜ sonuç verdi: "Narlıdere İtfaiye" metro istasyonu o listede var,
// ama GTFS feed'inde orada metro seferi YOK (900 m yarıçapta yalnız otobüs
// durağı bulunuyor). OTP bisikleti oraya park edip yine otobüse biniyordu —
// düzeltilmek istenen arızanın ta kendisi, üstelik daha yakın bir noktada.
//
// Bu yüzden kaynak OTP'nin KENDİ durak listesi: bir noktaya bisiklet parkı
// koymanın tek gerekçesi orada gerçekten raylı sefer olmasıdır, idari bir
// listede istasyon yazması değil. Aynı sebeple vapur iskelesi de yok —
// İzmir GTFS'inde route_type=4 hiç bulunmuyor.
const RAYLI_MODLAR = new Set(["SUBWAY", "RAIL", "TRAM"]);

// İki peron ve üç giriş aynı istasyondur. Bu yarıçap içindeki raylı duraklar
// tek bir park noktasında toplanır; yoksa Halkapınar tek başına altı lot
// üretir ve OTP'nin park yeri seçimi anlamsızca dallanır.
const ISTASYON_KUMELEME_M = 150;

// Kapasite ÖLÇÜLMÜŞ değil nominaldir: İzmir metrosu ve İZBAN istasyonlarında
// bisiklet park yeri bulunur ama sayısal envanteri yayınlanmıyor. Yalnız
// OTP'nin "burada park edilebilir" bilmesi için gönderilir, kullanıcıya
// dönük uçlarda gösterilmez. Envanter yayınlanırsa bu sabit onunla değişmeli.
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

// Raylı durakları OTP'den çeker. Konumlar graph ömrü boyunca sabittir, bu
// yüzden günde bir kez yeterli. OTP'ye ulaşılamazsa disk yedeği kullanılır:
// bu feed OTP'nin açılışında çekiliyor ve o an GraphQL ucu henüz yanıt
// vermeyebilir — yedek olmadan ilk turda boş feed gönderilirdi.
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

// Test için: liste modül içinde 24 saat önbelleklenir, testler arasında
// sıfırlanmazsa ilk testin verisi sonrakilere sızar (bir kez oldu).
// jest.resetModules() işe yaramıyor — o, testin ayarladığı axios mock'unu da
// yeniliyor ve modül gerçek ağa/disk yedeğine düşüyor.
function rayliDuraklariUnut() {
  rayliDurakListesi = null;
  rayliDurakZamani = 0;
}

const slug = (s) => adNormalize(s).replace(/ /g, "-") || "ISTASYON";

// OTP'ye bisiklet parkı olarak sunulacak noktalar:
//   • raylı sefer YAPILAN duraklar (asıl katkı — yukarıdaki ölçüme bakınız)
//   • P+R otoparkları (araba yeri olan yere bisiklet de bırakılır)
// OSM'den gelen 87 bisiklet parkı graph'ta zaten var; bu feed onların
// yerini almaz, üstüne eklenir.
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

// ─── Sağlık durumu ─────────────────────────────────────────────────────
// Bkz. OverpassService kaynaklarının getStatus'u — aynı gerekçe. parkAndRide
// sayısı ayrıca raporlanır: OTP feed'i yalnızca o alt kümeyi görür, dolayısıyla
// "kaynak yanıt veriyor ama P+R lotu 0" durumu rotalamayı sessizce bozar.
//
// Tek bir `source` alanı artık gerçeği anlatmıyor: envanter ve doluluk ayrı
// kaynaklardan gelir ve ayrı ayrı düşebilir. Eski alan, /health/ready'deki
// mevcut kontroller kırılmasın diye envanterin kaynağını göstermeye devam eder.
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
  // Test için: eşleştirme saf bir fonksiyon ve bir kez sessizce yanlış
  // otoparkı bağladı (bkz. enYakinEnvanterKaydi yorumu).
  enYakinEnvanterKaydi, isimSkoru,
};
