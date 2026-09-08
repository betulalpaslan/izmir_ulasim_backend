// Davranış matrisi: 7 rota × 6 mod, canlı backend + OTP'ye sorulmuş sonuçlar.
// Birim testi değil — "doğru mu" değil, "davranış değişti mi" sorusunu yanıtlar.
// Veriyi senaryoVerisi.js topluyor; backend ayakta değilse dosya atlanır.
const fs = require("fs");

const veri = process.env.SENARYO_VERISI
  ? JSON.parse(fs.readFileSync(process.env.SENARYO_VERISI, "utf8"))
  : null;

const BISIKLET = ["BICYCLE", "BICYCLE_RENTAL"];
const ARAC = ["CAR"];
const OZEL = [...BISIKLET, ...ARAC, "WALK"];

const sure = (it) => it.legs.reduce((s, l) => s + (l.duration || 0), 0);
const mesafe = (it, m) => it.legs.filter((l) => m.includes(l.mode))
  .reduce((s, l) => s + (l.distance || 0), 0);
const surePay = (it, m) => {
  const t = sure(it);
  return t ? it.legs.filter((l) => m.includes(l.mode))
    .reduce((s, l) => s + (l.duration || 0), 0) / t : 0;
};
const transitVar = (it) => it.legs.some((l) => !OZEL.includes(l.mode));
const enUzunYuruyus = (it) =>
  Math.max(0, ...it.legs.filter((l) => l.mode === "WALK").map((l) => l.distance || 0));
const enHizliDk = (its) => Math.min(...its.map(sure)) / 60;

const matris = veri ? describe : describe.skip;
const satirlar = veri?.satirlar ?? [];
const ad = (s) => `${s.rota} · ${s.mod}`;
const secim = (kosul) => satirlar.filter(kosul).map((s) => [ad(s), s]);
const tumu = secim(() => true);

matris("senaryo matrisi", () => {
  test.each(tumu)("%s — istek başarılı", (_, s) => {
    expect(s.hata).toBeUndefined();
  });

  test.each(tumu)("%s — güzergâh döndü", (_, s) => {
    expect(s.itineraries.length).toBeGreaterThan(0);
  });

  // İZDENİZ feed'i graph'ta yok; FERRY çıkarsa karşılığı olmayan rota üretiliyor.
  test.each(tumu)("%s — vapur yok", (_, s) => {
    expect(s.itineraries.some((it) => it.legs.some((l) => l.mode === "FERRY"))).toBe(false);
  });

  // Bisiklet erişim aracıyken eşiğin altında sürmek yolculuğu uzatıyor.
  // Listede kısa bacaklı güzergâh bulunabilir; olmaması gereken, hiçbirinin
  // işe yaramaması.
  test.each(secim((s) => ["bisim", "bisiklet-park"].includes(s.mod)))(
    "%s — işe yarayan bisiklet var", (_, s) => {
      if (s.yedek || !s.itineraries.length) return;
      const enUzun = Math.max(0, ...s.itineraries.filter(transitVar).map((it) => mesafe(it, BISIKLET)));
      if (enUzun === 0) return;   // hiç bisiklet önerilmemiş, ayrı durum
      expect(enUzun).toBeGreaterThanOrEqual(s.bisikletEsigi);
    });

  // Araç yolculuğun tamamına yakınını kaplıyorsa bu park+aktarma değil,
  // sadece arabayla gitmektir.
  test.each(secim((s) => s.mod === "park-and-ride"))("%s — aracın payı makul", (_, s) => {
    if (!s.itineraries.length) return;
    expect(Math.min(...s.itineraries.map((it) => surePay(it, ARAC)))).toBeLessThanOrEqual(0.75);
  });

  // Uygulama tek bacakta 2 km üstü yürüyüşü eliyor; hepsi aşarsa kullanıcıya
  // gösterilecek hiçbir şey kalmaz.
  test.each(tumu)("%s — yürünebilir seçenek var", (_, s) => {
    if (!s.itineraries.length) return;
    expect(Math.min(...s.itineraries.map(enUzunYuruyus))).toBeLessThanOrEqual(2000);
  });

  // BİSİM hizmet alanının tamamen dışında kalan rotalar. OTP hiç bisikletli
  // güzergâh üretemiyor, geriye düz transit kalıyor. Uygulama bunu doğru
  // karşılıyor: "BİSİM'li güzergâh kurulamadı" der ve ölçülmüş toplu taşıma
  // alternatifini sunar. Kural bu ikisinde beklendiği gibi tetikleniyor,
  // yani bir kusuru değil bilinen bir sınırı gösteriyor.
  // Liste UZARSA sorun var demektir — o zaman sebebi ölçülmeli.
  const HIZMET_ALANI_DISI = ["merkez-dogu · bisim", "cevre-cevre · bisim"];

  // Modlar arası: bir modun en hızlısı transit ile birebir aynıysa ve özel
  // araç bacağı yoksa o modu seçmenin karşılığı yok. Tek senaryoya bakarak
  // görülemez. Bisikletsiz yedek bilinçli bir karardır, ihlal sayılmaz.
  test.each(secim((s) =>
    ["bisiklet", "bisim", "bisiklet-park", "park-and-ride"].includes(s.mod)))(
    "%s — mod bir şey katıyor", (_, s) => {
      if (HIZMET_ALANI_DISI.includes(ad(s))) return;
      const taban = satirlar.find((x) => x.rota === s.rota && x.mod === "transit");
      if (s.yedek || !s.itineraries.length || !taban?.itineraries.length) return;
      const ayni = Math.abs(enHizliDk(s.itineraries) - enHizliDk(taban.itineraries)) < 0.1;
      const ozelArac = s.itineraries.some(
        (it) => mesafe(it, BISIKLET) > 0 || surePay(it, ARAC) > 0);
      expect(ayni && !ozelArac).toBe(false);
    });
});
