// Senaryo matrisinin verisini jest başlamadan önce toplar.
//
// Neden burada: matris canlı backend + OTP'ye 42 istek atıyor ve eşikleri
// mobil uygulamanın ESM kaynağından okuyor. Jest'in VM'i dinamik import'a
// izin vermiyor; globalSetup ise sıradan Node, ikisi de burada serbest.
// Test dosyası yalnız hazır sonucu okuyup doğruluyor.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const config = require("../config");
const TANIM = require("./senaryolar.json");

const API = `http://localhost:${config.PORT ?? 3000}`;
const UTILS = process.env.MOBIL_UTILS
  || path.join(__dirname, "..", "..", "izmir_ulasim", "utils");

async function ayaktaMi() {
  try {
    const r = await fetch(`${API}/health/ready`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function planla(rota, mod) {
  const govde = {
    from: TANIM.noktalar[rota.from],
    to: TANIM.noktalar[rota.to],
    profile: mod.profile,
    dateTime: TANIM.varsayilanKalkis,
  };
  if (mod.bikeType) govde.bikeType = mod.bikeType;
  const r = await fetch(`${API}/get-route`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(govde),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

module.exports = async () => {
  process.env.SENARYO_VERISI = "";
  if (!(await ayaktaMi())) return;

  // Eşikler uygulamadan okunur, burada yeniden yazılmaz.
  const puanlama = await import(pathToFileURL(path.join(UTILS, "routeScoring.js")).href);

  const satirlar = [];
  for (const rota of TANIM.rotalar) {
    for (const mod of TANIM.modlar) {
      const satir = { rota: rota.id, mod: mod.id, itineraries: [], yedek: false };
      try {
        const d = await planla(rota, mod);
        satir.itineraries = d.itineraries || [];
        satir.yedek = !!d.bisikletsizYedek;
      } catch (e) {
        satir.hata = e.message;
      }
      satir.bisikletEsigi =
        puanlama.BIKE_LEG_MIN[puanlama.resolveProfileKey(mod.profile, mod.bikeType)] ?? null;
      satirlar.push(satir);
    }
  }

  const hedef = path.join(os.tmpdir(), "izmir-senaryo-sonuc.json");
  fs.writeFileSync(hedef, JSON.stringify({ kalkis: TANIM.varsayilanKalkis, satirlar }), "utf8");
  process.env.SENARYO_VERISI = hedef;
};
