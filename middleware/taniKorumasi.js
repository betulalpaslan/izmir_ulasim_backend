const crypto = require("crypto");

// Tanılama uçları (/otp-status, /bisim/otp-check, /bisim/otp-rental-test,
// /bisim/otp-schema) OTP'nin GraphQL şemasını, feed durumunu ve ham hata
// metinlerini döndürüyor; /otp-rental-test ayrıca her çağrıldığında OTP'ye
// gerçek bir plan sorgusu attırıyor. Herkese açık olmaları hem iç yapıyı
// gösteriyor hem de bedava yük bindiriyordu.
//
// Artık TANI_ANAHTARI ortam değişkeni tanımlı ve istek o anahtarı taşıyor
// olmalı. Anahtar yoksa uç YOKMUŞ gibi davranır (404): varlığını duyurmaz.
// Kullanım: TANI_ANAHTARI=... ortamda tanımlıyken
//   curl -H "x-tani-anahtari: ..." .../otp-status
//   curl ".../otp-status?anahtar=..."
function esitMi(gelen, beklenen) {
  const a = Buffer.from(String(gelen));
  const b = Buffer.from(String(beklenen));
  // timingSafeEqual eşit uzunluk ister; uzunluk farkı zaten eşitsizliktir.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function taniKorumasi(req, res, next) {
  const beklenen = process.env.TANI_ANAHTARI;
  const gelen = req.get("x-tani-anahtari") || req.query.anahtar;

  if (beklenen && gelen && esitMi(gelen, beklenen)) return next();

  res.status(404).json({ error: "Bilinmeyen uç nokta.", path: req.path });
}

module.exports = taniKorumasi;
