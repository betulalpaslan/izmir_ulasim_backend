#!/usr/bin/env node
// Mobil uygulamanın puanlama modülünü klasik script'e derler.
//
// İKİ tüketicisi var ve ikisi de aynı paketi kullanmalı:
//   • senaryo süiti (node)                     — "kullanıcı ne görüyor"u ölçer
//   • izmir_ulasim/web_demo.html               — tarayıcıdaki deneme arayüzü
//   • multimodal_web/frontend/index (1).html   — web arayüzü
//
// İkincisi bir zamanlar puanlamanın KENDİ KOPYASINI taşıyordu ve kopya
// sessizce ayrıştı: uygulamada 20 dakikalık yürüyüş tavanı, mod saflığı ve
// yeni bacak metinleri varken demo hâlâ metre tabanlı eski eşiklerle
// çalışıyordu. Kullanıcı demoda 44 dakikalık yürüyüş bacağı görüyordu; hata
// uygulamada düzeltilmişti ama demo onu hiç görmedi. Tek kaynak: mobil repo.
// Sebep: süit "OTP ne döndürdü"yü değil "KULLANICI NE GÖRÜYOR"u ölçmeli.
// En ağır arızamız (63 dakikalık güzergâhın ⭐Önerilen olması) OTP çıktısında
// yoktu, yalnız sıralamadan sonra ortaya çıkıyordu.
//
// ÜRETİLEN DOSYA elle düzenlenmez. Tek doğruluk kaynağı mobil repodur.
const fs = require("fs");
const path = require("path");

const KAYNAK = process.env.MOBIL_UTILS
  || path.join(__dirname, "..", "..", "izmir_ulasim", "utils");
// Süit yanında bir kopya, demo yanında bir kopya. İkisi de üretilmiş
// dosyadır; elle düzenlenmez.
// Web arayüzü ayrı bir depoda; yolu ortam değişkeniyle geçersiz kılınabilir.
// O sayfa paketi <script src="routeScoring.bundle.js"> ile yüklüyor ve dosya
// ORADA YOKTU: 404 alıyor, tarayıcının önbelleğindeki eski kopyayla
// çalışıyordu. Sonuç, kullanıcının aylar önceki kurallarla üretilmiş
// güzergâhlar görmesiydi — 39 dakikalık yürüyüş bacağı dahil.
const WEB_FRONTEND = process.env.WEB_FRONTEND
  || path.join("D:", "multimodal_web", "frontend");

const HEDEFLER = [
  path.join(__dirname, "routeScoring.bundle.js"),
  path.join(KAYNAK, "..", "routeScoring.bundle.js"),
  path.join(WEB_FRONTEND, "routeScoring.bundle.js"),
].filter((h) => fs.existsSync(path.dirname(h)));

if (!fs.existsSync(KAYNAK)) {
  console.error(`Puanlama kaynağı bulunamadı: ${KAYNAK}`);
  console.error("MOBIL_UTILS ortam değişkeniyle yolu verebilirsin.");
  process.exit(1);
}

const temizle = (m) => m
  .replace(/^\s*import\s+.*?;\s*$/gm, "")
  .replace(/^export\s+(const|function|class|let)\s/gm, "$1 ")
  .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, "");

const parcalar = ["polyline.js", "geo.js", "routeScoring.js", "routeInstructions.js"]
  .map((d) => `/* ── ${d} ── */\n` + temizle(fs.readFileSync(path.join(KAYNAK, d), "utf8")));

const ADLAR = [
  "SCORING", "WALK_LEG_TARGET", "BIKE_LEG_MIN", "MOD_AMACI", "MUTLAK_YURUYUS_TAVANI",
  "YURUYUS_BACAK_TAVANI_SN", "BISIKLET_ASGARI_PAY", "MODE_STYLE",
  "NON_TRANSIT_MODES", "resolveProfileKey", "calcLegDistanceMeters",
  "rankItineraries", "selectCandidates", "buildRouteResult", "getLegInstruction",
  "CANDIDATE_DEFS", "ADAY_OLCULERI", "MAX_ROUTES", "calcCarbonGrams", "candidateKey",
  "calcJourneyFare", "ONERI_TOLERANSI", "oneriSinirinaUydur", "ayniHattiTekilleştir",
  "decodePolyline",
];

const cikti =
  `/* OTOMATİK ÜRETİLDİ — elle düzenleme.\n   Kaynak: ${KAYNAK}\n` +
  `   Yeniden üretmek: node senaryo/derle.js */\n` +
  "(function (global) {\n\"use strict\";\n" + parcalar.join("\n") +
  "\nglobal.RS = { " + ADLAR.join(", ") + " };\n" +
  "})(typeof window !== \"undefined\" ? window : globalThis);\n";

for (const h of HEDEFLER) fs.writeFileSync(h, cikti, "utf8");

const sahte = {};
new Function("window", cikti)(sahte);
const eksik = ADLAR.filter((k) => !(k in (sahte.RS || {})));
for (const h of HEDEFLER) console.log("  → " + h);
console.log(`derlendi: ${HEDEFLER.length} kopya (${Math.round(cikti.length / 1024)} KB), ` +
  `${Object.keys(sahte.RS || {}).length} ad` + (eksik.length ? `, EKSİK: ${eksik.join(", ")}` : ""));
process.exitCode = eksik.length ? 1 : 0;
