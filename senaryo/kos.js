#!/usr/bin/env node
// Senaryo koşucusu — ayakta bir backend + OTP ister.
//   node senaryo/kos.js            → tüm senaryolar
//   node senaryo/kos.js korfez     → id'sinde "korfez" geçenler
const path = require("path");
const veri = require("./senaryolar.json");
const { kurallar, listeKurallari, ARAC_MODLARI, TRANSIT_DISI, transitBacaklari, sure, YURUYUS_TAVANI_SN } = require("./kurallar");

// Uygulamanın puanlama katmanı. Süit "OTP ne döndürdü"yü değil "KULLANICI NE
// GÖRÜYOR"u ölçmeli: en ağır arızamız (63 dk'lık güzergâhın ⭐Önerilen olması)
// yalnız sıralamadan SONRA ortaya çıkıyordu.  Üretmek: node senaryo/derle.js
// Paket HER KOŞUDA yeniden üretilir. Elle üretmek unutuluyordu ve sonucu
// sinsiydi: puanlama kuralı değiştirilip süit koşuluyor, süit eski paketi
// ölçüyor, "düzeldi" sanılıyordu. Kaynak mobil repo, üretim ucuz.
try { require("child_process").execFileSync(process.execPath, [path.join(__dirname, "derle.js")], { stdio: "inherit" }); }
catch { console.error("Puanlama paketi üretilemedi."); process.exit(1); }
require("./routeScoring.bundle.js");
const RS = globalThis.RS;

const API = process.env.API_URL || "http://localhost:3000";
// Uygulamadaki WALK_LEG_TARGET ile aynı sayılar (izmir_ulasim/utils/routeScoring.js).
const YURUYUS_HEDEFI = {
  transit: 2000, bicycle: 600, bicycle_rent: 1200,
  bicycle_park: 1500, car: Infinity, park_and_ride: 1500,
};

async function planla(n1, n2, mod) {
  const r = await fetch(`${API}/get-route`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: { lat: n1.lat, lon: n1.lon }, to: { lat: n2.lat, lon: n2.lon },
      profile: mod.profile, bikeType: mod.bikeType, dateTime: veri.zaman,
    }),
  });
  if (!r.ok) return { itineraries: [], hata: `HTTP ${r.status}` };
  return r.json();
}

const imza = (it) => it.legs.map((l) => l.mode).join(">") + "|" + Math.round(sure(it.legs) / 60);

(async () => {
  const suzgec = process.argv[2];
  const secili = veri.senaryolar.filter((s) => !suzgec || s.id.includes(suzgec));
  const bulgular = [];
  const satirlar = [];

  for (const sen of secili) {
    const n1 = veri.noktalar[sen.from], n2 = veri.noktalar[sen.to];
    // Düz toplu taşıma her senaryoda taban çizgisi: diğer modlar buna göre yargılanır.
    const taban = await planla(n1, n2, veri.modlar.transit);
    const tabanSure = taban.itineraries?.length
      ? Math.min(...taban.itineraries.map((it) => sure(it.legs))) : null;

    for (const [modAnahtari, mod] of Object.entries(veri.modlar)) {
      const sonuc = await planla(n1, n2, mod);
      let its = sonuc.itineraries || [];
      // Uygulamanın yaptığının AYNISI (hooks/useRouteSearch.js): mod
      // saflığı. Bisiklet modlarında araçsız güzergâh gösterilmez.
      const ARANAN = {
        bicycle_rent: (l) => l.mode === "BICYCLE_RENTAL",
        bicycle_park: (l) => l.mode === "BICYCLE" || l.mode === "BICYCLE_RENTAL",
      };
      const puanKey = modAnahtari;
      if (ARANAN[puanKey]) its = its.filter((it) => it.legs.some(ARANAN[puanKey]));
      const tekil = new Set(its.map(imza));
      const aracli = its.filter((it) =>
        it.legs.some((l) => ARAC_MODLARI.includes(l.mode))).length;
      const enIyi = its.length ? Math.min(...its.map((it) => sure(it.legs))) : null;

      const yerel = [];
      for (const it of its) {
        for (const k of kurallar) {
          const d = k.denetle({ modAnahtari, legs: it.legs, yuruyusHedefi: YURUYUS_HEDEFI[modAnahtari] });
          if (d) yerel.push({ kod: k.kod, ad: k.ad, detay: d });
        }
      }
      // Gösterim katmanının çıktısı — kurallar buna da bakmalı.
      const siralıOn = its.length ? RS.rankItineraries(its, puanKey) : [];
      const hatKalibi = new Set(siralıOn.map((r) => r.itin.legs
        .map((l) => (l.route ? `${l.mode}:${l.route.shortName || l.route.longName || ""}` : l.mode))
        .join(">"))).size;

      for (const k of listeKurallari) {
        const d = k.denetle({
          modAnahtari, enIyiSure: enIyi, transitEnIyiSure: tabanSure,
          aracliSayi: aracli, toplamSayi: its.length, tekilSayi: tekil.size,
          gosterilenSayi: siralıOn.length, hatKalibi,
        });
        if (d) yerel.push({ kod: k.kod, ad: k.ad, detay: d });
      }
      // Aynı kod birden çok güzergâhta çıkarsa bir kez say, kaç kez olduğunu yaz.
      const ozet = new Map();
      for (const b of yerel) {
        if (!ozet.has(b.kod)) ozet.set(b.kod, { ...b, adet: 0 });
        ozet.get(b.kod).adet++;
      }
      for (const b of ozet.values()) bulgular.push({ senaryo: sen.id, mod: modAnahtari, ...b });

      // ── Sıralama sonrası: kullanıcının gerçekten göreceği liste ──
      let onerilenDk = null, onerilenAracli = null, gosterilen = 0;
      if (its.length) {
        const siralı = RS.rankItineraries(its, puanKey);
        gosterilen = siralı.length;
        const ilk = siralı[0]?.itin;
        if (ilk) {
          onerilenDk = sure(ilk.legs) / 60;
          onerilenAracli = ilk.legs.some((l) => ARAC_MODLARI.includes(l.mode));
        }
        // K7 — MOD İÇİ karşılaştırma. Taban düz transit DEĞİL, aynı modun
        // gösterilen en hızlı güzergâhıdır: kullanıcı modu zaten seçmiş,
        // soru "o modun seçenekleri içinde en mantıklısı mı önde".
        const tol = RS.ONERI_TOLERANSI[puanKey];
        const enHizliGosterilen = Math.min(...siralı.map((r) => sure(r.itin.legs))) / 60;
        if (tol && onerilenDk && onerilenDk > enHizliGosterilen * tol) {
          bulgular.push({
            senaryo: sen.id, mod: modAnahtari, kod: "K7",
            ad: "Önerilen, mod içindeki en hızlıdan sapıyor", adet: 1,
            detay: `Önerilen ${onerilenDk.toFixed(1)} dk, mod içi en hızlı ${enHizliGosterilen.toFixed(1)} dk (tolerans ${tol}x)`,
          });
        }

        // K9 — modun amacı KOMBİNASYON. Önerilen salt araç (transit yok)
        // iken daha hızlı bir araç+transit güzergâhı gösteriliyorsa, öneri
        // modun isteğini karşılamıyor demektir.
        const kombinasyonVar = siralı.filter((r) =>
          r.itin.legs.some((l) => ARAC_MODLARI.includes(l.mode)) &&
          r.itin.legs.some((l) => !TRANSIT_DISI.includes(l.mode)));
        const ilkKombinasyon = ilk && ilk.legs.some((l) => !TRANSIT_DISI.includes(l.mode));
        if (RS.MOD_AMACI[modAnahtari] && ilk && !ilkKombinasyon && kombinasyonVar.length) {
          const enHizliKomb = Math.min(...kombinasyonVar.map((r) => sure(r.itin.legs))) / 60;
          if (enHizliKomb < onerilenDk) {
            bulgular.push({
              senaryo: sen.id, mod: modAnahtari, kod: "K9",
              ad: "Önerilen salt araç, daha hızlı araç+transit varken", adet: 1,
              detay: `Önerilen ${onerilenDk.toFixed(1)} dk (transitsiz), araç+transit ${enHizliKomb.toFixed(1)} dk`,
            });
          }
        }
        // K11 — SERT KURAL. Yürüyüş tavanını aşan bir güzergâh gösterim
        // katmanından geçtiyse eleme çalışmıyor demektir. K10 ham çıktıda
        // bulgu verebilir (OTP öyle güzergâhlar üretir, bu normaldir);
        // burada bulgu çıkması ARIZADIR.
        for (const r of siralı) {
          const en = Math.max(0, ...r.itin.legs.filter((l) => l.mode === "WALK").map((l) => l.duration || 0));
          if (en > YURUYUS_TAVANI_SN) {
            bulgular.push({
              senaryo: sen.id, mod: modAnahtari, kod: "K11",
              ad: "GÖSTERİLEN güzergâhta 20 dk üstü yürüyüş", adet: 1,
              detay: `tek bacakta ${Math.round(en / 60)} dk — eleme çalışmıyor`,
            });
            break;
          }
        }

        // K8: mod seçildi, sıralamadan sonra o modun aracı ekranda yok.
        if (RS.MOD_AMACI[modAnahtari] && ilk && !onerilenAracli) {
          bulgular.push({
            senaryo: sen.id, mod: modAnahtari, kod: "K8",
            ad: "Önerilen kartta seçilen modun aracı yok", adet: 1,
            detay: `${gosterilen} güzergâh gösteriliyor, ilkinde araç yok`,
          });
        }
      }

      satirlar.push({
        senaryo: sen.id, mod: modAnahtari, rota: its.length, tekil: tekil.size,
        dk: enIyi ? (enIyi / 60).toFixed(0) : "—",
        goster: gosterilen,
        oner: onerilenDk ? onerilenDk.toFixed(0) : "—",
        yedek: sonuc.bisikletsizYedek ? "E" : "",
        kodlar: [...ozet.keys()].sort().join(","),
      });
    }
  }

  console.log("\n" + "═".repeat(78));
  console.log("SENARYO SONUÇLARI   (Pazartesi 08:00)");
  console.log("═".repeat(78));
  console.log("senaryo".padEnd(18) + "mod".padEnd(16) + "rota tekil   dk göst öner yedek");
  console.log("─".repeat(78));
  let sonSenaryo = null;
  for (const s of satirlar) {
    const ad = s.senaryo === sonSenaryo ? "" : s.senaryo;
    sonSenaryo = s.senaryo;
    console.log(
      ad.padEnd(18) + s.mod.padEnd(16) +
      String(s.rota).padStart(4) + String(s.tekil).padStart(6) +
      String(s.dk).padStart(5) + String(s.goster).padStart(5) +
      String(s.oner).padStart(5) + s.yedek.padStart(4)
    );
  }

  console.log("\n" + "═".repeat(78));
  console.log("BULGULAR");
  console.log("═".repeat(78));
  const kodBazli = new Map();
  for (const b of bulgular) {
    if (!kodBazli.has(b.kod)) kodBazli.set(b.kod, []);
    kodBazli.get(b.kod).push(b);
  }
  for (const kod of [...kodBazli.keys()].sort()) {
    const liste = kodBazli.get(kod);
    console.log(`\n${kod} — ${liste[0].ad}  (${liste.length} yerde)`);
    for (const b of liste) console.log(`   ${b.senaryo.padEnd(18)}${b.mod.padEnd(16)}${b.detay}`);
  }
  console.log(`\nToplam bulgu: ${bulgular.length} / ${satirlar.length} mod-senaryo`);
  process.exitCode = bulgular.length ? 1 : 0;
})();
