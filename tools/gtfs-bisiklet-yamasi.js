#!/usr/bin/env node
// GTFS bisiklet taşıma yaması.
//
//   node tools/gtfs-bisiklet-yamasi.js <gtfs-dizini>
//   node tools/gtfs-bisiklet-yamasi.js <gtfs-dizini> --denetle
//
// NİYE VAR. OTP "bisikleti yanına alıp transite binmek" güzergâhını YALNIZ
// GTFS'teki trips.bikes_allowed=1 olan seferlerde üretir. İzmir feed'inde bu
// alan kullanılamaz durumda:
//
//   ESHOT otobüs : 21.302 sefer "izinli", 46.095 "bilgi yok" — üstelik 406
//                  hattın 119'unda AYNI hat hem 0 hem 1 sefer taşıyor
//                  (hat 42: 531 izinli, 38 bilgi yok). Bisiklet otobüse ya
//                  sığar ya sığmaz, sefere göre değişmez: bu veri değil gürültü.
//   Tramvay      : alan boş
//   İZBAN        : alan boş
//   Metro        : sütun hiç yok
//
// Yani gerçekten bisiklet binebilen üç sistemde HİÇ veri yok, binemeyen
// otobüste "izinli" yazıyor — tam ters.
//
// GERÇEK DURUM (kaynaklar):
//   metro   → İZMİR METRO A.Ş. açık verisi "Bisikletli Giriş Sayıları"
//             (acikveri.bizizmir.com, kaynak c774b611-0be0-4021-ba4c-8bec8cc7201d):
//             2020'den beri aylık kayıt, 2026'nın 7 ayında 58.123 giriş,
//             temmuzda günde ~320. Kesin izinli ve artıyor.
//   tramvay → İzmir Tramvayı kuralı: ek ücret ödemeden bisiklet, katlanabilir
//             bisiklet, elektrikli bisiklet ve scooter taşınabilir
//             (motosiklet ebadında/ağırlığında ve üç tekerlekli olanlar hariç).
//   İZBAN   → aynı şekilde izinli.
//   ESHOT   → izin verildiğine dair kaynak yok; bisikletli giriş verisi de yok.
//
// BU YAMA FEED HER TAZELENDİĞİNDE YENİDEN UYGULANMALI ve ardından graph
// yeniden derlenmeli:
//   java -Xmx3g -jar otp-shaded-2.8.1.jar --build --save <gtfs-dizini>
// Yamasız derlenen bir graph'ta bisikletle transite binme güzergâhı sessizce
// kaybolur; hata verilmez, sadece o seçenek hiç üretilmez.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// GTFS bikes_allowed: 1 = izinli, 2 = izinli değil. (0/boş = bilgi yok, ki
// OTP bunu "izinli değil" gibi ele alır — bu yüzden 0 bırakmak yetmiyor.)
const AJANS_IZNI = {
  ESHOT_1:   "2",
  TRAM_TRAM: "1",
  IZBAN_IZB: "1",
};
// Ajans kimliği taşımayan metro feed'i için varsayılan.
const METRO_FEED = "rail-metro-gtfs.zip";
const METRO_IZNI = "1";

function csvOku(metin) {
  const satirlar = metin.replace(/^﻿/, "").split(/\r?\n/).filter((x) => x.length);
  const basliklar = satirlar[0].split(",");
  return {
    basliklar,
    kayitlar: satirlar.slice(1).map((satir) => {
      const parcalar = satir.split(",");
      const o = {};
      basliklar.forEach((b, i) => { o[b] = parcalar[i] ?? ""; });
      return o;
    }),
  };
}

function csvYaz(basliklar, kayitlar) {
  return [basliklar.join(",")]
    .concat(kayitlar.map((k) => basliklar.map((b) => k[b] ?? "").join(",")))
    .join("\n") + "\n";
}

// Zip'e dokunmak için harici araç istemiyoruz; Node'un kendi zlib'i tek
// dosya değiştirmeye yetmiyor. PowerShell her Windows'ta var, Linux'ta
// (Railway) bu araç zaten çalıştırılmıyor — yama build makinesinde uygulanır.
function zipIcindenOku(zipYolu, dosya) {
  return execFileSync("powershell", ["-NoProfile", "-Command", `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [System.IO.Compression.ZipFile]::OpenRead('${zipYolu}')
    $e = $z.Entries | Where-Object { $_.FullName -eq '${dosya}' }
    $r = New-Object System.IO.StreamReader($e.Open())
    $r.ReadToEnd()
    $r.Close(); $z.Dispose()
  `], { maxBuffer: 512 * 1024 * 1024, encoding: "utf8" });
}

function zipIcineYaz(zipYolu, dosya, icerik) {
  const gecici = path.join(path.dirname(zipYolu), `.${path.basename(dosya)}.yama`);
  fs.writeFileSync(gecici, icerik);
  execFileSync("powershell", ["-NoProfile", "-Command", `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [System.IO.Compression.ZipFile]::Open('${zipYolu}', 'Update')
    $e = $z.Entries | Where-Object { $_.FullName -eq '${dosya}' }
    if ($e) { $e.Delete() }
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, '${gecici}', '${dosya}')
    $z.Dispose()
  `]);
  fs.unlinkSync(gecici);
}

function feedYamala(zipYolu, denetle) {
  const ad = path.basename(zipYolu);
  const trips = csvOku(zipIcindenOku(zipYolu, "trips.txt"));
  let ajans = {};
  if (ad !== METRO_FEED) {
    const routes = csvOku(zipIcindenOku(zipYolu, "routes.txt"));
    for (const r of routes.kayitlar) ajans[r.route_id] = r.agency_id;
  }

  if (!trips.basliklar.includes("bikes_allowed")) trips.basliklar.push("bikes_allowed");

  const sayac = {};
  let degisen = 0;
  for (const t of trips.kayitlar) {
    const hedef = ad === METRO_FEED ? METRO_IZNI : AJANS_IZNI[ajans[t.route_id]];
    if (hedef === undefined) continue;
    const anahtar = `${ad === METRO_FEED ? "METRO" : ajans[t.route_id]} → ${hedef}`;
    sayac[anahtar] = (sayac[anahtar] || 0) + 1;
    if (t.bikes_allowed !== hedef) degisen++;
    t.bikes_allowed = hedef;
  }

  console.log(`\n${ad}`);
  for (const [k, v] of Object.entries(sayac)) console.log(`  ${k.padEnd(20)} ${v} sefer`);
  console.log(`  değişecek sefer: ${degisen}`);

  if (denetle) return degisen;
  if (degisen === 0) { console.log("  (zaten güncel)"); return 0; }
  zipIcineYaz(zipYolu, "trips.txt", csvYaz(trips.basliklar, trips.kayitlar));
  console.log("  yazıldı");
  return degisen;
}

const dizin = process.argv[2];
const denetle = process.argv.includes("--denetle");
if (!dizin) {
  console.error("kullanım: node tools/gtfs-bisiklet-yamasi.js <gtfs-dizini> [--denetle]");
  process.exit(2);
}

const zipler = fs.readdirSync(dizin).filter((f) => f.endsWith(".zip"));
if (!zipler.length) { console.error(`${dizin} içinde .zip yok`); process.exit(1); }

let toplam = 0;
for (const z of zipler) toplam += feedYamala(path.join(dizin, z), denetle);

if (denetle) {
  console.log(`\nDenetim: ${toplam} sefer yamasız.`);
  process.exit(toplam ? 1 : 0);
}
console.log(`\nToplam ${toplam} sefer yamalandı. Graph'ı yeniden derlemeyi unutmayın:`);
console.log(`  java -Xmx3g -jar otp-shaded-2.8.1.jar --build --save ${dizin}`);
