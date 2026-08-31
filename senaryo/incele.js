#!/usr/bin/env node
// Tek senaryoyu derinlemesine açar: ne sorduk, ne döndü, hangi kural niçin
// tetiklendi, kullanıcı sonunda ne görecek.
//   node senaryo/incele.js korfez-karsi
//   node senaryo/incele.js korfez-karsi bicycle_rent     (tek mod)
const veri = require("./senaryolar.json");
const { kurallar, listeKurallari, ARAC_MODLARI, TRANSIT_DISI, sure } = require("./kurallar");

const API = process.env.API_URL || "http://localhost:3000";
const YURUYUS_HEDEFI = {
  transit: 2000, bicycle: 600, bicycle_rent: 1200,
  bicycle_park: 1500, car: Infinity, park_and_ride: 1500,
};

const dk = (sn) => (sn / 60).toFixed(1).padStart(6);
const m  = (x)  => String(Math.round(x || 0)).padStart(7);
const imza = (it) => it.legs.map((l) => l.mode).join(">") + "|" + Math.round(sure(it.legs) / 60);

async function planla(n1, n2, mod) {
  const r = await fetch(`${API}/get-route`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: { lat: n1.lat, lon: n1.lon }, to: { lat: n2.lat, lon: n2.lon },
      profile: mod.profile, bikeType: mod.bikeType, dateTime: veri.zaman,
    }),
  });
  return r.ok ? r.json() : { itineraries: [], hata: `HTTP ${r.status}` };
}

(async () => {
  const id = process.argv[2] || veri.senaryolar[0].id;
  const tekMod = process.argv[3];
  const sen = veri.senaryolar.find((s) => s.id === id);
  if (!sen) { console.log("senaryo yok:", id); process.exit(1); }
  const n1 = veri.noktalar[sen.from], n2 = veri.noktalar[sen.to];

  console.log("╔" + "═".repeat(74) + "╗");
  console.log("║ SENARYO: " + sen.id.padEnd(64) + "║");
  console.log("╚" + "═".repeat(74) + "╝");
  console.log(`  ${n1.ad}  →  ${n2.ad}`);
  console.log(`  ${n1.lat}, ${n1.lon}   →   ${n2.lat}, ${n2.lon}`);
  console.log(`  kalkış: ${veri.zaman}`);
  console.log(`  niçin bu senaryo: ${sen.not}`);

  const taban = await planla(n1, n2, veri.modlar.transit);
  const tabanSure = taban.itineraries?.length
    ? Math.min(...taban.itineraries.map((it) => sure(it.legs))) : null;
  console.log(`\n  TABAN ÇİZGİSİ (düz toplu taşıma): ${tabanSure ? (tabanSure/60).toFixed(1) + " dk" : "yok"}`);
  console.log("  Diğer modlar buna göre yargılanır — bir mod bundan yavaşsa öneri değil zarardır.");

  const modlar = tekMod ? { [tekMod]: veri.modlar[tekMod] } : veri.modlar;

  for (const [anahtar, mod] of Object.entries(modlar)) {
    const sonuc = await planla(n1, n2, mod);
    const its = sonuc.itineraries || [];
    console.log("\n" + "─".repeat(76));
    console.log(`MOD: ${mod.etiket}   [${anahtar}]`);
    console.log("─".repeat(76));
    console.log(`  istek: profile=${mod.profile} bikeType=${mod.bikeType ?? "—"}`
      + (sonuc.bisikletsizYedek ? "   ⚠ bisikletsiz yedek sorgu devreye girdi" : ""));

    if (!its.length) { console.log("  güzergâh yok."); continue; }

    // Tekilleştirilmiş liste — OTP aynı yolculuğu defalarca döndürüyor.
    const gorulen = new Map();
    for (const it of its) if (!gorulen.has(imza(it))) gorulen.set(imza(it), it);
    console.log(`  dönen güzergâh: ${its.length}   tekil: ${gorulen.size}`);
    console.log();
    console.log("     süre(dk)  araç(m)  transit(m)  yürüyüş(m)  bacaklar");

    for (const it of gorulen.values()) {
      const ar = it.legs.filter((l) => ARAC_MODLARI.includes(l.mode)).reduce((s,l)=>s+(l.distance||0),0);
      const tr = it.legs.filter((l) => !TRANSIT_DISI.includes(l.mode)).reduce((s,l)=>s+(l.distance||0),0);
      const yu = it.legs.filter((l) => l.mode === "WALK").reduce((s,l)=>s+(l.distance||0),0);
      console.log(`    ${dk(sure(it.legs))} ${m(ar)} ${m(tr)}    ${m(yu)}    ${it.legs.map(l=>l.mode).join(" > ")}`);
    }

    // En iyi güzergâhın bacak dökümü — sayıların nereden geldiğini gösterir.
    const enIyi = [...gorulen.values()].sort((a,b) => sure(a.legs) - sure(b.legs))[0];
    console.log(`\n  en hızlı güzergâhın bacakları:`);
    for (const l of enIyi.legs) {
      const ad = [(l.from?.name || "").slice(0,22), (l.to?.name || "").slice(0,22)].join(" → ");
      console.log(`    ${l.mode.padEnd(16)} ${dk(l.duration||0)} dk ${m(l.distance)} m   ${ad}`);
    }

    // Kurallar
    const bulgu = new Map();
    for (const it of gorulen.values())
      for (const k of kurallar) {
        const d = k.denetle({ modAnahtari: anahtar, legs: it.legs, yuruyusHedefi: YURUYUS_HEDEFI[anahtar] });
        if (d && !bulgu.has(k.kod)) bulgu.set(k.kod, `${k.kod} ${k.ad}: ${d}`);
      }
    for (const k of listeKurallari) {
      const d = k.denetle({
        modAnahtari: anahtar,
        enIyiSure: Math.min(...its.map((it) => sure(it.legs))),
        transitEnIyiSure: tabanSure,
        aracliSayi: its.filter((it) => it.legs.some((l) => ARAC_MODLARI.includes(l.mode))).length,
        toplamSayi: its.length, tekilSayi: gorulen.size,
      });
      if (d) bulgu.set(k.kod, `${k.kod} ${k.ad}: ${d}`);
    }
    console.log(`\n  kurallar: ${bulgu.size ? "" : "temiz ✓"}`);
    for (const s of bulgu.values()) console.log(`    ✗ ${s}`);
  }
})();
