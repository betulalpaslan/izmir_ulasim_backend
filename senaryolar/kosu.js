// Senaryo koşucusu — 42 senaryoyu (7 rota × 6 mod) çalıştırıp davranış
// kurallarını denetler.
//
// Neden var: her düzeltmeyi tek tek elle ölçerken biri düzelirken diğerinin
// bozulduğunu ancak tesadüfen fark ediyorduk. Burada tüm matris tek komutla
// koşuyor ve kural ihlalleri listeleniyor.
//
// Bu bir birim testi DEĞİL: ayakta bir backend + OTP ister ve gerçek graph'a
// sorar. Amacı "doğru mu" değil, "davranış değişti mi" sorusunu yanıtlamak.
//
// Kullanım:  node senaryolar/kosu.js  [--json]  [--rota=korfez-karsi]  [--mod=bisim]

const fs = require("fs");
const path = require("path");
const config = require("../config");

const TANIM = JSON.parse(fs.readFileSync(path.join(__dirname, "senaryolar.json"), "utf8"));
const API = `http://localhost:${config.PORT ?? 3000}/get-route`;

const arg = (ad) => (process.argv.find((a) => a.startsWith(`--${ad}=`)) || "").split("=")[1];
const JSON_CIKTI = process.argv.includes("--json");

const BISIKLET = ["BICYCLE", "BICYCLE_RENTAL"];
const ARAC     = ["CAR"];
const YURUYUS  = ["WALK"];
const OZEL     = [...BISIKLET, ...ARAC, ...YURUYUS];

const sure   = (it) => it.legs.reduce((s, l) => s + (l.duration || 0), 0);
const mesafe = (it, modlar) => it.legs.filter((l) => modlar.includes(l.mode))
                                      .reduce((s, l) => s + (l.distance || 0), 0);
const surePay = (it, modlar) => {
  const t = sure(it);
  if (!t) return 0;
  return it.legs.filter((l) => modlar.includes(l.mode))
                .reduce((s, l) => s + (l.duration || 0), 0) / t;
};
const transitVar = (it) => it.legs.some((l) => !OZEL.includes(l.mode));
const enUzunYuruyus = (it) => Math.max(0, ...it.legs.filter((l) => l.mode === "WALK").map((l) => l.distance || 0));

// ─── Kurallar ──────────────────────────────────────────────────────────
// Her kural bir güzergâhı inceler ve ihlal varsa metin döndürür.
// Eşikler ölçümle belirlenmiştir; gerekçeleri config.js ve routeScoring.js'te.
// DİKKAT — kurallar TEK BİR güzergâhı değil, backend'in o senaryo için
// döndürdüğü LİSTEYİ denetler. Sebebi ilk koşuda görüldü: listede anlamsız
// bir güzergâhın BULUNMASI hata değil (uygulamadaki rankItineraries onu
// eliyor); hata, listede kullanılabilir HİÇBİR güzergâh olmamasıdır.
// Backend'in verdiği garanti budur, denetlenen de bu olmalı.
const KURALLAR = [
  {
    ad: "vapur yok",
    not: "İZDENİZ feed'i graph'ta yok; FERRY görünürse karşılığı olmayan rota üretiliyor demektir.",
    denetle: (its) => (its.some((it) => it.legs.some((l) => l.mode === "FERRY")) ? "FERRY bacağı var" : null),
  },
  {
    ad: "işe yarayan bisiklet var",
    not: "Bisiklet erişim aracıyken eşiğin altında sürmek yolculuğu uzatıyor (ölçüldü: 282 m → +6.2 dk). Listede kısa bacaklı güzergâh bulunabilir; olmaması gereken, hiçbirinin işe yaramaması.",
    modlar: ["bisim", "bisiklet-park"],
    denetle: (its, s) => {
      if (s.yedek) return null;                       // bisikletsiz yedek zaten devrede
      const esik = config.BISIKLET_ANLAMLI_MIN_M[s.mod.bikeType];
      const enUzun = Math.max(0, ...its.filter(transitVar).map((it) => mesafe(it, BISIKLET)));
      if (enUzun === 0) return null;                  // hiç bisiklet önerilmemiş, ayrı durum
      return enUzun < esik ? `en uzun bisiklet ${Math.round(enUzun)} m < ${esik} m, yedek de devrede değil` : null;
    },
  },
  {
    ad: "aracın payı makul",
    not: "Park & Ride'da araç yolculuğun tamamına yakınını kaplıyorsa bu park+aktarma değil, sadece arabayla gitmektir.",
    modlar: ["park-and-ride"],
    esik: 0.75,
    denetle: (its, s, kural) => {
      const enIyi = Math.min(...its.map((it) => surePay(it, ARAC)));
      return enIyi > kural.esik
        ? `en düşük araç payı bile %${Math.round(enIyi * 100)} > %${Math.round(kural.esik * 100)}` : null;
    },
  },
  {
    ad: "yürünebilir seçenek var",
    not: "Uygulama tek bacakta 2 km üstü yürüyüş içeren güzergâhı eliyor. Listedeki HER güzergâh bu sınırı aşıyorsa kullanıcıya gösterilecek hiçbir şey kalmaz.",
    denetle: (its) => {
      const enIyi = Math.min(...its.map(enUzunYuruyus));
      return enIyi > 2000 ? `en iyi güzergâhta bile tek yürüyüş ${Math.round(enIyi)} m` : null;
    },
  },
];

async function planla(s) {
  const govde = {
    from: { lat: s.from.lat, lon: s.from.lon },
    to:   { lat: s.to.lat,   lon: s.to.lon },
    profile: s.mod.profile,
    dateTime: TANIM.varsayilanKalkis,
  };
  if (s.mod.bikeType) govde.bikeType = s.mod.bikeType;
  const r = await fetch(API, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(govde),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

(async () => {
  const rotaSuz = arg("rota"), modSuz = arg("mod");
  const satirlar = [];

  for (const rota of TANIM.rotalar) {
    if (rotaSuz && rota.id !== rotaSuz) continue;
    for (const mod of TANIM.modlar) {
      if (modSuz && mod.id !== modSuz) continue;
      const s = { rota, mod, from: TANIM.noktalar[rota.from], to: TANIM.noktalar[rota.to] };
      const satir = { rota: rota.id, mod: mod.id, guzergah: 0, ihlaller: [] };
      try {
        const d = await planla(s);
        const its = d.itineraries || [];
        satir.guzergah = its.length;
        satir.yedek = !!d.bisikletsizYedek;
        if (its.length) {
          const enHizli = its.reduce((a, b) => (sure(a) <= sure(b) ? a : b));
          satir.enHizliDk = +(sure(enHizli) / 60).toFixed(1);
          satir.bisikletM = Math.round(Math.max(0, ...its.map((it) => mesafe(it, BISIKLET))));
          satir.aracPayi  = +Math.max(0, ...its.map((it) => surePay(it, ARAC))).toFixed(2);
        }
        if (its.length) {
          s.yedek = satir.yedek;
          for (const k of KURALLAR) {
            if (k.modlar && !k.modlar.includes(mod.id)) continue;
            const ihlal = k.denetle(its, s, k);
            if (ihlal) satir.ihlaller.push(`${k.ad}: ${ihlal}`);
          }
        }
      } catch (e) {
        satir.hata = e.message;
      }
      satirlar.push(satir);
    }
  }

  // ─── Modlar arası kural: "bu mod bir şey katıyor mu?" ────────────────
  // İlk koşuda 7 rotanın 7'sinde de bisiklet ve BİSİM modlarının en hızlı
  // güzergâhı, transit modunun en hızlısıyla BİREBİR aynı çıktı. Sebep
  // buildModesInput'ta: "bicycle" profilinde access ["WALK"], yani bisiklet
  // toplu taşımayla hiç birleştirilmiyor — yalnız ayrı bir "tamamı bisiklet"
  // seçeneği olarak ekleniyor. Kullanıcı o modu seçtiğinde eline transit
  // cevabı geçiyor. Bu, tek bir güzergâha bakarak görülemez; ancak modlar
  // karşılaştırılınca ortaya çıkar.
  const KARSILASTIRILAN = ["bisiklet", "bisim", "bisiklet-park", "park-and-ride"];
  for (const rota of new Set(satirlar.map((r) => r.rota))) {
    const taban = satirlar.find((r) => r.rota === rota && r.mod === "transit");
    if (!taban || taban.enHizliDk == null) continue;
    for (const r of satirlar.filter((x) => x.rota === rota && KARSILASTIRILAN.includes(x.mod))) {
      if (r.enHizliDk == null) continue;
      // Bisikletsiz yedek bilinçli bir karardır ve kullanıcıya etiketlenir;
      // transit cevabına düşmesi burada beklenen davranıştır, ihlal değil.
      if (r.yedek) continue;
      if (Math.abs(r.enHizliDk - taban.enHizliDk) < 0.1 && !r.bisikletM && !r.aracPayi) {
        r.ihlaller.push(`mod bir şey katmıyor: en hızlı güzergâh transit ile aynı (${taban.enHizliDk} dk) ve özel araç bacağı yok`);
      }
    }
  }

  if (JSON_CIKTI) { console.log(JSON.stringify({ satirlar }, null, 2)); return; }

  const g = (x, n) => String(x ?? "").padEnd(n);
  const s2 = (x, n) => String(x ?? "").padStart(n);
  console.log("SENARYO MATRİSİ — kalkış " + TANIM.varsayilanKalkis);
  console.log("");
  console.log(g("rota", 15) + g("mod", 15) + s2("rota#", 6) + s2("en hızlı", 10) + s2("bisiklet", 10) + s2("araç payı", 11) + "  durum");
  console.log("─".repeat(96));
  let ihlalSayisi = 0, hataSayisi = 0, bosSayisi = 0;
  for (const r of satirlar) {
    let durum = "ok";
    if (r.hata) { durum = "HATA: " + r.hata; hataSayisi++; }
    else if (r.ihlaller.length) { durum = r.ihlaller.join(" | "); ihlalSayisi++; }
    else if (r.guzergah === 0) { durum = "güzergâh yok"; bosSayisi++; }
    else if (r.yedek) durum = "ok (bisikletsiz yedek)";
    console.log(g(r.rota, 15) + g(r.mod, 15) + s2(r.guzergah, 6) +
      s2(r.enHizliDk != null ? r.enHizliDk + " dk" : "-", 10) +
      s2(r.bisikletM ? r.bisikletM + " m" : "-", 10) +
      s2(r.aracPayi ? "%" + Math.round(r.aracPayi * 100) : "-", 11) + "  " + durum);
  }
  console.log("─".repeat(96));
  console.log(`toplam ${satirlar.length} senaryo · ihlal ${ihlalSayisi} · güzergâh yok ${bosSayisi} · hata ${hataSayisi}`);
  process.exitCode = ihlalSayisi + hataSayisi > 0 ? 1 : 0;
})();
