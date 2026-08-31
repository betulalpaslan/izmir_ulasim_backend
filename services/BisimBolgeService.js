const fs = require("fs");
const path = require("path");

// ─── BİSİM: bölge tabanlı (dockless) model ──────────────────────────────
// İzmir Büyükşehir Belediyesi 2025-08-04'te BİSİM'in SABİT İSTASYONLARINI
// kaldırdı. Sistem artık QR kodlu ve bölge tabanlı:
//
//   • Bisiklet ALMA   → bisikletler bölgeye dağınık bırakılmıştır
//   • Bisiklet BIRAKMA→ hizmet bölgesi içinde HER YERE serbest
//   • Yeşil "P" alanı → bırakınca bonus kazandıran teşvik bölgesi
//
// Eski modelimiz OpenStreetMap'in `amenity=bicycle_rental` düğümlerine
// dayanıyordu. OSM bu değişikliği yansıtmadı; o 52 "istasyon" artık var
// olmayan yuvaların kalıntısıydı. Dahası canlı doluluk verisi bulunmadığı
// için hepsini is_renting:false gönderiyorduk — OTP'de 52 istasyon vardı ve
// HİÇBİRİ kullanılabilir değildi, bu yüzden hiçbir rotada bisiklet çıkmıyordu.
//
// ── Modelin OTP'ye çevrimi ──
// BIRAKMA serbest olduğu için doğru karşılık GBFS `geofencing_zones`:
// kuralı olmayan bir bölge OTP'de "işletme alanı sınırı"dır, dışına
// bırakılamaz, içinde her yere bırakılabilir.
//
// ALMA tarafında canlı bisiklet konumu yok. Bunu uydurmuyoruz: bonus,
// işletmecinin bisikletleri belirli alanlarda BİRİKTİRMEK için kurduğu
// mekanizmadır, dolayısıyla yeşil P alanları "bisiklet bulunma olasılığı en
// yüksek yerler"dir. Alma noktası olarak onlar kullanılıyor. Canlı
// free_bike_status yayına girerse alma tarafı oradan beslenmeli.

const BOLGE_VERI = path.join(__dirname, "..", "data", "bisim-bolgeler.json");
const YOL_VERI   = path.join(__dirname, "..", "data", "bisiklet-yollari.geojson");

// Hizmet alanı, bisiklet yolu koridorlarının çevresine bu kadar genişletilir.
// Uygulamadaki yeşil alan koridorun iki yanındaki mahalleleri de kapsıyor.
const ALAN_TAMPON_M = 700;

// İşletme alanı kümeleri. Ayrı ayrı poligon üretilir; ÇAKIŞMAMALARI şart,
// çünkü çakışan parçalar geçersiz MultiPolygon üretir.
const KUMELER = [
  { id: "korfez",      ilceler: ["Çiğli", "Karşıyaka", "Bayraklı", "Konak", "Balçova", "Narlıdere"] },
  { id: "seferihisar", ilceler: ["Seferihisar"] },
];

const D = Math.PI / 180;

let veri = null;
function yukle() {
  if (!veri) veri = JSON.parse(fs.readFileSync(BOLGE_VERI, "utf8"));
  return veri;
}

function birakmaNoktalari() {
  return yukle().birakmaNoktalari;
}

// ─── Geometri ───────────────────────────────────────────────────────────
// Küçük yardımcılar; tek işi hizmet alanı poligonunu üretmek olduğu için
// dışarıdan geometri kütüphanesi getirilmedi.

// Andrew monotone chain — dışbükey kabuk. Girdi [lon,lat] çiftleri.
function disbukeyKabuk(noktalar) {
  const p = noktalar.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const capraz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const yari = (dizi) => {
    const yig = [];
    for (const n of dizi) {
      while (yig.length >= 2 && capraz(yig[yig.length - 2], yig[yig.length - 1], n) <= 0) yig.pop();
      yig.push(n);
    }
    yig.pop();
    return yig;
  };
  return yari(p).concat(yari(p.slice().reverse()));
}

// Kabuğu ağırlık merkezinden dışa doğru metre cinsinden genişletir.
// Ölçekleme değil ötelemedir: uzun-ince koridorlarda da tampon sabit kalır.
function genislet(kabuk, metre) {
  const n = kabuk.length;
  const cLon = kabuk.reduce((s, k) => s + k[0], 0) / n;
  const cLat = kabuk.reduce((s, k) => s + k[1], 0) / n;
  return kabuk.map(([lon, lat]) => {
    const dx = (lon - cLon) * Math.cos(lat * D) * 111320;
    const dy = (lat - cLat) * 111320;
    const uz = Math.hypot(dx, dy) || 1;
    return [
      +(lon + (dx / uz) * metre / (111320 * Math.cos(lat * D))).toFixed(6),
      +(lat + (dy / uz) * metre / 111320).toFixed(6),
    ];
  });
}

let hizmetAlaniCache = null;
function hizmetAlani() {
  if (hizmetAlaniCache) return hizmetAlaniCache;

  const yollar = JSON.parse(fs.readFileSync(YOL_VERI, "utf8")).features;
  const noktalar = birakmaNoktalari();

  hizmetAlaniCache = KUMELER.map((kume) => {
    const p = [];
    for (const f of yollar) {
      if (!kume.ilceler.includes(f.properties.ilce)) continue;
      const yur = (c) => (typeof c[0] === "number" ? p.push([c[0], c[1]]) : c.forEach(yur));
      yur(f.geometry.coordinates);
    }
    // Bonus alanları da kabuğa katılır: bisiklet yolu olmayan (ör. Bornova)
    // bölgeler yalnız yol geometrisinden çıkarılamaz.
    for (const b of noktalar) {
      if (kume.ilceler.includes(b.ilce) || (kume.id === "korfez" && b.ilce === "Bornova")) {
        p.push([b.lon, b.lat]);
      }
    }
    if (p.length < 3) return null;
    const halka = genislet(disbukeyKabuk(p), ALAN_TAMPON_M);
    return [[...halka, halka[0]]];          // GeoJSON: halka kapalı olmalı
  }).filter(Boolean);

  return hizmetAlaniCache;
}

// ─── Serbest bisikletler (GBFS free_bike_status) ───────────────────────
//
// SORUN. BİSİM'i 11 "istasyon" olarak sunmak OTP'ye YANLIŞ bir sistem tarif
// ediyordu. Ölçüm — Konak İskele → Alsancak Garı, salt kiralama:
//
//   BİSİKLET 12 dk / 2358 m (Konak İskele → Alsancak Kordon)
//   YÜRÜME   17 dk / 1294 m
//
// Yani bisiklet en yakın İSTASYONA bırakılıp kalan 1.3 km yürünüyordu.
// OTP istasyonlu (docked) bir ağ gördüğü için kiralamayı ancak bir
// istasyonda bitirebiliyor. BİSİM böyle çalışmıyor: 2025-08'den beri sabit
// istasyon yok, bisiklet hizmet alanı içinde HER YERE bırakılabilir.
//
// ÇÖZÜM. Bisikletler GBFS'in free_bike_status'ü ile "serbest dolaşan araç"
// olarak bildiriliyor. OTP'nin iç modelinde serbest bir araç, geofencing
// bölgesinin İÇİNDE her yerde bırakılabilir — BİSİM'in gerçek kuralı budur.
//
// ── UYDURULAN NE, UYDURULMAYAN NE ──
// Canlı bisiklet konumu YAYINLANMIYOR (free_bike_status diye bir açık uç
// yok). Buradaki koordinatlar tek tek bisikletlerin gerçek yeri DEĞİL;
// "bu koridorda bisiklet bulunur" varsayımının rotalanabilir hâlidir.
// Uydurma olmayan kısım konumların KAYNAĞI: noktalar açık veriden gelen
// GERÇEK bisiklet yolu geometrisi üzerinde örnekleniyor, hizmet alanına
// kör bir ızgara serpilmiyor. BİSİM bu koridor boyunca işletiliyor.
//
// Bu yüzden iki kural var ve ikisi de bilerek:
//   • Bu noktalar KULLANICIYA GÖSTERİLMEZ. /bisim/stations bölge döndürmeye
//     devam eder; haritada alan görünür, sahte bisiklet pini görünmez.
//   • Rota kartındaki metin kesinlik iddia etmez ("civarında bisiklet al").
// Canlı konum yayına girerse bu üretici silinip yerine gerçek veri konmalı.
const ALMA_ADIM_M = 400;

// Hangi ilçelerin bisiklet yolları örnekleniyor: yalnız işletme alanı
// kümelerine ait olanlar. Foça, Çeşme, Torbalı gibi ilçelerin de bisiklet
// yolu var ama BİSİM oralarda yok — koridora dahil edilirse hizmet alanı
// dışında alma noktası üretilirdi.
const HIZMET_ILCELERI = new Set(KUMELER.flatMap((k) => k.ilceler));

function iki_nokta_m(a, b) {
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * D) * 111320;
  const dy = (b[1] - a[1]) * 111320;
  return Math.hypot(dx, dy);
}

// Bir LineString üzerinde her ALMA_ADIM_M metrede bir nokta üretir.
// Düğümleri olduğu gibi almak yetmezdi: geometride kimi yerde 5 m'de bir
// düğüm var, kimi yerde 300 m'de bir. Örnekleme aralığı düzgün olmalı ki
// koridorun bazı parçaları bisiklet kaynıyor, bazıları boş görünmesin.
function cizgiyiOrnekle(koordinatlar, cikti) {
  let artan = 0;
  for (let i = 1; i < koordinatlar.length; i++) {
    const a = koordinatlar[i - 1], b = koordinatlar[i];
    const uzunluk = iki_nokta_m(a, b);
    if (!Number.isFinite(uzunluk) || uzunluk === 0) continue;
    let gidilen = ALMA_ADIM_M - artan;
    while (gidilen <= uzunluk) {
      const t = gidilen / uzunluk;
      cikti.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      gidilen += ALMA_ADIM_M;
    }
    artan = (artan + uzunluk) % ALMA_ADIM_M;
  }
}

let serbestCache = null;
function serbestBisikletler() {
  if (serbestCache) return serbestCache;

  const yollar = JSON.parse(fs.readFileSync(YOL_VERI, "utf8")).features;
  const noktalar = [];

  for (const f of yollar) {
    if (!HIZMET_ILCELERI.has(f.properties.ilce)) continue;
    const cizgiler = [];
    const yur = (c) => {
      if (typeof c[0] === "number") return;
      if (typeof c[0][0] === "number") cizgiler.push(c);
      else c.forEach(yur);
    };
    yur(f.geometry.coordinates);
    for (const c of cizgiler) cizgiyiOrnekle(c, noktalar);
  }

  // Bonus ("yeşil P") alanları her hâlükârda alma noktasıdır: işletmeci
  // bisikletleri oralarda BİRİKTİRMEK için bonus veriyor, yani bisiklet
  // bulunma olasılığı en yüksek yerler onlar. Bisiklet yolu geçmeyen
  // bölgeler (ör. Bornova) yalnız buradan gelir.
  for (const b of birakmaNoktalari()) noktalar.push([b.lon, b.lat]);

  serbestCache = noktalar.map(([lon, lat]) => ({
    // Kimlik konumdan türetilir: liste her turda aynı sırada üretilmediğinde
    // bile aynı nokta aynı bike_id'yi taşır. OTP kimliği değişen aracı yeni
    // bir araç sayıp eskisini kaldırıyor.
    bike_id: `bisim-${lat.toFixed(5)}-${lon.toFixed(5)}`,
    lat: +lat.toFixed(6),
    lon: +lon.toFixed(6),
  }));
  return serbestCache;
}

// GBFS 2.3 geofencing_zones.json
// DİKKAT: OTP geometriyi MultiPolygon olarak okur. Polygon gönderilirse
// ayrıştırma hata verir ve bu hata TÜM feed yüklemesini iptal eder —
// istasyon listesi de güncellenmez (ölçüldü: 52 eski istasyon takılı kaldı).
//
// Bölge, hiçbir şeyin yasaklanmadığı kuralla verilir. OTP'nin iç modelinde
// (GeofencingZone) bu "isBusinessArea" demektir: alanın DIŞINDA kiralama
// bitirilemez, İÇİNDE her yere bırakılabilir. BİSİM'in gerçek kuralı budur.
//
// `rules` alanı boş bırakılamaz: OTP 2.8.1 kuralları koşulsuz okuyor
// (GbfsGeofencingZoneMapper:60 → getRules().get(0)), null gelirse
// NullPointerException atıyor ve tüm feed güncellemesi düşüyor —
// ölçüldü, istasyon sayısı 0'a indi.
function geofencingZones() {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          name: "BİSİM hizmet alanı",
          rules: [{ ride_allowed: true, ride_through_allowed: true }],
        },
        geometry: { type: "MultiPolygon", coordinates: hizmetAlani() },
      },
    ],
  };
}

function getStatus() {
  const b = birakmaNoktalari();
  let alan = null;
  try { alan = hizmetAlani().length; } catch { /* veri dosyası okunamadı */ }
  return {
    model: "bolge",
    bonusAlanlari: b.length,
    hizmetAlaniParca: alan,
    surum: yukle().surum,
    // Uydurma değil ama ÖLÇÜM de değil: gerçek bisiklet yolu geometrisi
    // üzerinde örneklenmiş alma noktaları. Sayısı /health'te görünsün ki
    // sıfıra düştüğünde (veri dosyası okunamadı) sessiz kalmasın.
    almaNoktasi: (() => { try { return serbestBisikletler().length; } catch { return null; } })(),
    dusukGuven: b.filter((x) => x.guven === "dusuk").length,
  };
}

module.exports = { birakmaNoktalari, geofencingZones, hizmetAlani, serbestBisikletler, getStatus };
