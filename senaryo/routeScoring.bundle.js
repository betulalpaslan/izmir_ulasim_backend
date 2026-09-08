/* OTOMATİK ÜRETİLDİ — elle düzenleme.
   Kaynak: D:\Mures\izmir_ulasim\utils
   Yeniden üretmek: node senaryo/derle.js */
(function (global) {
"use strict";
/* ── polyline.js ── */
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}
/* ── geo.js ── */
// Coğrafi mesafe ve izdüşüm yardımcıları.
// Tüm fonksiyonlar saftır — harita/cihaz bağımlılığı yoktur, doğrudan test edilebilir.

const EARTH_RADIUS_M = 6371000;
const DEG_TO_RAD = Math.PI / 180;

function haversineMeters(p1, p2) {
  const dLat = (p2.latitude - p1.latitude) * DEG_TO_RAD;
  const dLon = (p2.longitude - p1.longitude) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.latitude * DEG_TO_RAD) *
      Math.cos(p2.latitude * DEG_TO_RAD) *
      Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Bir koordinat dizisinin toplam uzunluğu (metre).
function pathLengthMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i]);
  return total;
}

// Küçük ölçeklerde (birkaç km) yeterli doğrulukta düzlemsel izdüşüm için
// enlem/boylamı yerel metre düzlemine çevirir.
function toLocalMeters(point, originLat) {
  return {
    x: point.longitude * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(originLat * DEG_TO_RAD),
    y: point.latitude * DEG_TO_RAD * EARTH_RADIUS_M,
  };
}

// p noktasının a-b doğru parçası üzerindeki en yakın noktası.
// t: 0 = a, 1 = b. distance metre cinsindendir.
function projectOnSegment(p, a, b) {
  const originLat = a.latitude;
  const pm = toLocalMeters(p, originLat);
  const am = toLocalMeters(a, originLat);
  const bm = toLocalMeters(b, originLat);

  const dx = bm.x - am.x;
  const dy = bm.y - am.y;
  const lengthSq = dx * dx + dy * dy;

  // Sıfır uzunluklu parça: a'nın kendisine düşer.
  const t = lengthSq === 0
    ? 0
    : Math.max(0, Math.min(1, ((pm.x - am.x) * dx + (pm.y - am.y) * dy) / lengthSq));

  const point = {
    latitude: a.latitude + (b.latitude - a.latitude) * t,
    longitude: a.longitude + (b.longitude - a.longitude) * t,
  };
  return { point, t, distance: haversineMeters(p, point) };
}

// İki nokta arasındaki pusula yönü (0-360, kuzeyden saat yönünde).
function bearingDegrees(from, to) {
  const lat1 = from.latitude * DEG_TO_RAD;
  const lat2 = to.latitude * DEG_TO_RAD;
  const dLon = (to.longitude - from.longitude) * DEG_TO_RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG_TO_RAD + 360) % 360;
}

// Mesafeyi kullanıcıya gösterilecek biçime çevirir: 850 m / 1,2 km
function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  // Önce yuvarla: 999 m "1000 m" değil "1,0 km" olarak gösterilmeli
  const rounded = Math.round(meters / 10) * 10;
  if (rounded < 1000) return `${rounded} m`;
  return `${(meters / 1000).toFixed(1).replace(".", ",")} km`;
}

// Süreyi gösterilecek biçime çevirir: 45 sn / 12 dk / 1 sa 5 dk
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} sn`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} dk`;
  return `${Math.floor(minutes / 60)} sa ${minutes % 60} dk`;
}

/* ── routeScoring.js ── */


const MODE_STYLE = {
  WALK:           { color: "#8b8aa8", icon: "walk",  label: "Yürüyüş" },
  BUS:            { color: "#8b5cf6", icon: "bus",   label: "Otobüs" },
  // RAIL = İZBAN banliyö hattı, SUBWAY = İzmir Metrosu. Aynı ikonu paylaşırlar,
  // bu yüzden renkleri ayrı tutulur; aksi hâlde kart şeridinde ayırt edilemezler.
  RAIL:           { color: "#ec4899", icon: "train", label: "Banliyö" },
  SUBWAY:         { color: "#22a6f0", icon: "train", label: "Metro" },
  TRAM:           { color: "#f59e0b", icon: "tram",  label: "Tramvay" },
  BICYCLE:        { color: "#22c55e", icon: "bike",  label: "Bisiklet" },
  // BİSİM kendi bisikletinden ayrı bir ton: kart şeridinde hangisinin
  // kiralık olduğu renkten okunsun.
  BICYCLE_RENTAL: { color: "#10b981", icon: "bike",  label: "BİSİM" },
  CAR:            { color: "#fb7a3c", icon: "car",   label: "Araba" },
};

const NON_TRANSIT_MODES = ["WALK", "BICYCLE", "BICYCLE_RENTAL", "CAR"];

const CARBON_G_PER_KM = {
  CAR: 150, BUS: 80, RAIL: 41, SUBWAY: 41, TRAM: 30,
  WALK: 0, BICYCLE: 0, BICYCLE_RENTAL: 0,
};
const SCORING = {
  
  transit:       { durationMin: 1, walkKm: 7,  transferPts: 10, overTargetKm: 45, uzunBacakPts: 15 },

  bicycle:       { durationMin: 1, walkKm: 2,  transferPts:  3, overTargetKm: 15, bikeKm: 1, uzunBacakPts: 15 },
  // BİSİM kiralama: istasyona yürüyüş önemli, transit aktarması da sayılır.
  //
  // bikeKm — pedal çevirmenin zahmet cezası. Ölçüm olmadan konmadı;
  // Konak → Karşıyaka'da skor bileşenlerine ayrıldığında şu çıktı:
  //     63.3 dk saf bisiklet   : 63.3 + yürüyüş 0.0 + aşım 0.0 = 63.3
  //     55.1 dk BİSİM + RAIL   : 55.1 + yürüyüş 8.6 + aşım 1.2 = 65.0
  // Multimodal güzergâh 8.2 DAKİKA daha hızlı olduğu hâlde 1.7 puanla
  // kaybediyordu. Sebep asimetri: 1723 m yürüyüşe 8.6 puan yazılıyor, ama
  // 14.8 km pedal çevirmek bedava sayılıyordu. Yürüyüş zahmetliyse bisiklet
  // de zahmetlidir; ikisi de süreye ek bir isteksizlik taşır.
  //
  // Bu bir CEZA'dır, eski `bikeKmOdul` gibi bir ödül değil: 0'ın altına
  // inemez, dolayısıyla hiçbir güzergâh km biriktirerek zirveye çıkamaz.
  bicycle_rent:  { durationMin: 1, walkKm: 5,  transferPts:  5, overTargetKm: 25, bikeKm: 1, uzunBacakPts: 15 },
  // Bisiklet park + transit: park sonrası yürüyüş kritik, aktarma da ağır.
  bicycle_park:  { durationMin: 1, walkKm: 8,  transferPts:  8, overTargetKm: 40, bikeKm: 1, uzunBacakPts: 15 },
  // Araba: sadece süre, yürüyüş yok
  car:           { durationMin: 1, walkKm: 0,  transferPts:  0, overTargetKm:  0, uzunBacakPts: 0 },
  // Park & Ride: yürüyüş orta ağırlık, aktarma önemli
  park_and_ride: { durationMin: 1, walkKm: 6,  transferPts:  8, overTargetKm: 35, uzunBacakPts: 15 },
};

// ─── Mod amacı ─────────────────────────────────────────────────────────
// Sert eleme YALNIZ tek bir soruya aittir: "bu güzergâh, kullanıcının seçtiği
// modun işini görüyor mu?" Geri kalan her şey (uzun yürüyüş, yavaşlık) sert
// eşik değil CEZA'dır — çünkü sert eşik uçlarda saçmalıyor.
//
// Bunun bedeli ölçüldü. Konak → Karşıyaka, "BİSİM + transit":
//   63.3 dk  saf bisiklet 14854 m                → ⭐ Önerilen olarak gösterildi
//   32.5 dk  bisiklet yok                        → En Hızlı
//   55.1 dk  BİSİM 2358 m + RAIL                 → ELENDİ
// Elenen üçüncüsü tam olarak kullanıcının istediği güzergâhtı ("bisikletle
// gidebildiğin kadar git, sonra transit"). Eleme sebebi: en uzun yürüyüş
// bacağı 1250 m, eşik 1200 m — 50 METRE. Zirveye çıkan 63 dakikalık saf
// sürüş ise eski `bikeKmOdul` ödülünün eseriydi: ödül bisiklet km'siyle
// doğrusal artıyor ve üstten sınırsız olduğu için yeterince uzun her sürüş
// her şeyi eziyordu.
//
// Ödül kaldırıldı. Ceza alttan 0'la sınırlıdır; hiçbir güzergâh "ödül
// biriktirerek" saçmalığa ulaşamaz.
// BİSİM sürüşünün yolculuk içindeki asgari payı.
//
// Ölçüm — Asmaaltı → Nergiz civarı, Pzt 08:00, "BİSİM + aktarma":
//   OTOBÜS 13dk > METRO 20dk > TREN 13dk > YÜRÜME 3dk > BİSİM 4dk / 972 m
// 60 dakikalık bir yolculuğun sonunda 972 metre için bisikleti bul,
// uygulamayı aç, QR okut, kilidi aç. Mevcut BIKE_LEG_MIN (500 m) bunu
// geçiriyordu.
//
// Zahmet ağırlıklı ALMA tarafındadır: BİSİM dockless, bırakırken yuva
// aranmaz ve bisiklet kilitlenmez — sürüş uygulamadan bitirilip bisiklet
// hizmet alanı içinde bırakılır.
//
// SÜRE eşiği değil ORAN eşiği: itiraz "4 dakika az" değil, "o kadar yoldan
// sonra 4 dakika" idi. Kısa bir yolculukta 5 dakikalık BİSİM gayet meşru;
// aynı 5 dakika 40 dakikalık yolculukta gürültü. Ölçülen 22 kartın oranları
// %6.7 ile %49 arasındaydı; %15 sınırı en alttaki dördünü eliyor.
//
// YALNIZ BİSİM'e uygulanır. Oradaki sorun süre değil ZAHMET: bisikleti bul,
// uygulamayı aç, QR okut. 60 dakikalık bir yolculuğun sonunda 972 metre için
// bu yapılmaz, o sürüş yolculuğu birkaç dakika kısaltsa bile.
const BISIKLET_ASGARI_PAY = 0.15;

// Eski ad — dışarıda bu sabiti bekleyen kod olabilir.
const BISIM_ASGARI_PAY = BISIKLET_ASGARI_PAY;

// KENDİ BİSİKLETİNDE ÖLÇÜT: KAYIP TAVANI.
//
// Önce oran eşiği vardı, yanlış şeyi ölçüyordu. Sonra "en az 3 dakika
// kazandırmalı" kuralına geçildi — o da yanlış tarafa kaçtı: bisikleti
// yanında olan biri yarışa çıkmıyor. Ölçümdeki uç örnek Konak → Bornova'da
// bisikletli güzergâh yolculuğu 0.6 DAKİKA uzatıyordu ve mod tamamen
// kapanıyordu; kullanıcıya "36 saniye yüzünden bisiklete binemezsin"
// demek anlamsız.
//
// Kendi bisikletinde aranacak araç, QR, kilit açma, iade yok. Süre tek
// değer de değil: hareket, ücretsizlik, beklememe, aktarma belirsizliğinin
// olmaması. Bu yüzden ölçüt kazanç değil KAYIP TAVANI: bisiklet yolculuğu
// bir miktar uzatabilir, yeter ki uzatma katlanılır olsun.
//
// TAVAN 15 DAKİKA. Ölçülen on senaryoda bisikletin bisikletsize göre farkı:
//
//   +23.0  uzak-kuzey          +3.1  korfez-karsi
//   +10.5  merkez-dogu         +3.1  kuzey-dogu
//    +9.5  kuzey-merkez        +1.4  guney-merkez
//    +9.2  narlidere-cigli     +0.8  guneybati-merkez
//    +9.1  uzak-guney          -9.6  sahil-guneybati
//
// Eski 3 dakika eşiği alttaki dördünü (+1.4, +0.8 ve ölçüm sonrası eklenen
// -0.6, -6.2 gibi küçük kayıplar) eliyordu. 15 dakika tavanıyla bunların
// hepsi geçer, -9.6'lık sahil-guneybati da geçer; eleme yalnız bisikletin
// yolculuğu gerçekten çekilmez hale getirdiği durumda kalır.
//
// Sıfır tavan (yani "hiç uzatmasın") kuralı eski haline döndürür; sınırsız
// olması ise modu kuralsız bırakır — 40 dakika uzatan bir güzergâhı
// "bisikletim + aktarma" diye sunmak yine yalan olur.
//
// Taban çizgisi backend'den geliyor (services/OtpService.js, ayrı bir
// yürüyüşlü sorgu) ve her güzergâha iliştirilmiş halde: itin.bisikletsizEnIyiSn.
// BİLİNMİYORSA ELEME YAPILMAZ — taban sorgusu düştüyse kullanıcıyı
// cezalandırmak yanlış olur.
const BISIKLET_AZAMI_KAYIP_SN = 15 * 60;

// P+R'de transitin araca göre asgari oranı. Gerekçesi ve ölçümü aşağıda,
// MOD_AMACI.park_and_ride'ın üstünde.
const PR_TRANSIT_ASGARI_ORAN = 0.3;

const MOD_AMACI = {
  bicycle_rent: {
    aciklama: "BİSİM seçildi — sürüş yolculuğun anlamlı bir payı olmalı",
    gorur: (o) =>
      o.bikeMeters >= (BIKE_LEG_MIN.bicycle_rent ?? 0) &&
      o.bikeSaniye >= o.duration * BISIKLET_ASGARI_PAY,
  },
  bicycle_park: {
    aciklama: "Bisikletim + aktarma seçildi — bisiklet yolculuğu aşırı uzatmamalı",
    gorur: (o) =>
      o.bikeMeters >= (BIKE_LEG_MIN.bicycle_park ?? 0) &&
      (o.bisikletsizEnIyiSn == null ||
        o.duration <= o.bisikletsizEnIyiSn + BISIKLET_AZAMI_KAYIP_SN),
  },
  // "Sadece bisiklet" modu ölçüldüğünde 8 güzergâhın 7'sinde HİÇ bisiklet
  // yoktu — düz transit rotalarıydı, yani mod kullanıcıya yalan söylüyordu.
  bicycle: {
    aciklama: "Sadece bisiklet seçildi — bisikletsiz güzergâh bu modda anlamsız",
    gorur: (o) => o.bikeMeters > 0,
  },
  // Park & Ride ölçümü: 10 senaryonun 6'sında araç 13–29 km, transit 0.3–1.8 km.
  // Bu bir "park et ve devam et" yolculuğu değil, araba yolculuğudur.
  //
  // ESKİ KURAL `carMeters >= 2000` DE İSTİYORDU ve o yarı sahte negatif
  // üretiyordu. Yukarıdaki ölçüm araç-domine vakalarını anlatıyor; araç TABANI
  // hiç ölçülmemiş, simetri olsun diye konmuştu. Bedeli — Karşıyaka → Bornova,
  // Pzt 08:00, beş güzergâh:
  //
  //   [1] 29 dk | araç 13.9 km → BORNOVA KATLI    | transit  0.6 km
  //   [2] 55 dk | araç  1.1 km → KARŞIYAKA İSKELE | transit 10.9 km
  //   [3] 53 dk | araç  1.1 km → KARŞIYAKA İSKELE | transit 14.2 km
  //   [4] 58 dk | araç  1.1 km → KARŞIYAKA İSKELE | transit  8.6 km
  //   [5] 61 dk | araç  1.1 km → KARŞIYAKA İSKELE | transit 11.6 km
  //
  // [2]–[5] tam olarak Park & Ride'ın kendisi: kısa bir sürüşle otoparka git,
  // gerisini transitle yap. Dördü de "araç 2 km'den kısa" diye eleniyordu ve
  // kullanıcı boş ekran görüyordu. Kısa sürüş kusur değil, modun iyi
  // çalıştığının işaretidir.
  //
  // Doğru soru "araba ne kadar uzun" değil, YOLCULUĞU KİM TAŞIYOR. Oran
  // kendini ölçekler ve mutlak bir tabana ihtiyaç bırakmaz.
  //
  // EŞİK NEDEN 0.3. Önce `transit >= araç` (oran 1.0) denendi ve boş satırı
  // 5'ten 4'e indirdi — ama DOLU satırlara da zarar verdi: Alsancak → Balçova'da
  // 33 dakikalık gerçek bir P+R (9.0 km araç + 4.3 km transit) elenip öneri
  // 51 dakikaya çıktı, Narlıdere → Çiğli'de bir güzergâh 14.6'ya karşı 14.4 km
  // ile, yani 200 METRE farkla düştü. Bıçak sırtıydı.
  //
  // transit≥2km olan 30 güzergâhın transit/araç oranı sıralandığında dağılım
  // alttan ayrık çıktı:
  //
  //   0.08  uzak-kuzey     araç 28.8 km, transit  2.3 km
  //   0.17  kuzey-merkez   araç 13.7 km, transit  2.3 km
  //   ──── boşluk 0.22 ────
  //   0.38  sahil-guneybati araç 9.0 km, transit  3.5 km
  //   0.48  sahil-guneybati araç 9.0 km, transit  4.3 km   ← 33 dk'lık kart
  //   ──── boşluk 0.50 ────
  //   0.99 … 69.86  (kalan 25 güzergâh)
  //
  // Alttaki ikisi 28.8 ve 13.7 km sürüp 2.3 km transit yapıyor — kuralın
  // hedeflediği araba yolculuğu tam olarak bu. Üstündeki her şey gerçek karma
  // yolculuk. 0.17 ile 0.38 arasındaki HER eşik aynı sonucu verir; 0.3
  // boşluğun ortasıdır.
  //
  // Sonuç: boş satır 5'ten 4'e iner (kuzey-dogu ve guney-merkez açılır,
  // uzak-kuzey kapanır) ve dolu satırlarda hiçbir hızlı kart kaybolmaz.
  park_and_ride: {
    aciklama: "Park & Ride seçildi — yolculuğu transit taşımalı, araba erişim aracı olmalı",
    gorur: (o) =>
      o.transitMeters >= 2000 &&
      o.transitMeters >= o.carMeters * PR_TRANSIT_ASGARI_ORAN,
  },
};

// ─── Öneri sınırı ──────────────────────────────────────────────────────
// "Önerilen" kart, gösterilen en hızlı güzergâhtan bu orandan fazla yavaş
// olamaz. Puanlama sıralamayı yapar; bu sınır yalnız EN ÜSTTEKİNİ bağlar.
//
// Niçin gerekli: cezalar süreye eklenen ayrı terimler ve hiçbiri süreyle
// orantılı değil. Yeterince ceza birikince, çok daha yavaş bir güzergâh
// zirveye çıkabiliyor. Ölçüldü — Bostanlı → Konak, DÜZ TOPLU TAŞIMA:
//   58.6 dk  WALK>BUS>WALK              58.6 + yürüyüş  4.3 + aktarma  0.0 = 62.9  ← Önerilen
//   45.9 dk  WALK>RAIL>WALK>SUBWAY>WALK 45.9 + yürüyüş 11.0 + aktarma 10.0 = 66.9
// 12.7 dakika daha hızlı güzergâh, 1.5 km yürüyüş + 1 aktarma için yazılan
// 21 puanla geriye düşüyordu. Bisikletle hiç ilgisi yok; katsayılar
// birikince her modda olabilir.
//
// Bu sınır katsayıları düzeltmez, HASARI SINIRLAR: hangi ceza yanlış
// kalibre olursa olsun kullanıcıya önerilen şey belirli bir yavaşlığın
// ötesine geçemez. Senaryo süiti (K7) aynı sayıları kullanır.
const ONERI_TOLERANSI = {
  transit:       1.20,
  // Araba yolculuğunun amacı hız; sapmaya en az tolerans burada.
  park_and_ride: 1.15,
  bicycle_park:  1.20,
  // Bisiklet modlarında "biraz daha uzun ama daha çok bisiklet" makul bir
  // tercih olabilir; tolerans biraz geniş.
  bicycle:       1.25,
  bicycle_rent:  1.25,
  car:           1.10,
};

// ─── Yürüyüş tavanı ────────────────────────────────────────────────────
// TEK BİR yürüyüş bacağı bu süreyi aşarsa güzergâh HİÇBİR MODDA gösterilmez.
// Bu ürün kararıdır, kalibrasyon değil: mesafe/hız/eğim ne olursa olsun
// kimse bir yolculuğun ortasında 20 dakikadan uzun yürümek istemiyor.
//
// Neden SÜRE, neden MESAFE değil: eski tavan 5000 m'ydi ve yalnız uçları
// yakalıyordu. Ölçüm — Narlıdere → Çiğli, Pzt 08:00:
//   düz toplu taşıma  → önerilen kartın İLK bacağı 1267 m / 19 dk
//   BİSİM             → tek kartın ilk bacağı     2088 m / 28 dk
// İkisi de 5000 m'nin altında olduğu için geçiyordu. Yürüyüş süresi arazi
// ve yol ağına göre mesafeden bağımsız değişiyor; kullanıcının hissettiği
// büyüklük dakikadır, metre değil.
//
// Toplam yürüyüşe tavan konmuyor — bilerek. Aynı ölçümde toplam yürüyüşler
// 26–45 dk arasındaydı ve toplama 20 dk sınırı koymak o yolculukta kartların
// TAMAMINI eliyordu. Toplam yürüyüş skorda `walkKm` cezasıyla zaten
// ağırlıklandırılıyor; asıl dayanılmaz olan tek seferde uzun yürümektir.
const YURUYUS_BACAK_TAVANI_SN = 20 * 60;

// Geriye dönük uyumluluk: dışarıda bu sabiti bekleyen kod olabilir. Artık
// eleme ölçütü değil — eleme YURUYUS_BACAK_TAVANI_SN üzerinden yapılıyor.
const MUTLAK_YURUYUS_TAVANI = 5000;

// Bisiklet bacağının anlamlı sayılması için gereken en kısa mesafe (metre).
//
// Sorun ölçüldü: "Park + Aktarma" modunda OTP 282 metrelik bir bisiklet
// bacağı öneriyordu (Konak → Konak Metro), ardından metro+tren. O 282 metre
// yürüyerek ~3.4 dakika; bisikletle park dahil ~3.7 dakika. Yani bisiklet
// gerçek sürede daha yavaş ve üstüne kilit açma/kilitleme külfeti getiriyor.
//
// OTP tarafında park maliyetini gerçekçi yapmak bunu ELEMEDİ, çünkü rota
// süre bakımından gerçekten en hızlısıydı (38.7 dk, diğerleri 48+). Sorun
// optimalliğin ölçüsünde değil AMAÇTA: bu modu seçen kişi bisikleti anlamlı
// bir mesafe için kullanmak ister. Bu yüzden karar bizim katmanımızda.
//
// Yalnız transit İÇEREN rotalara uygulanır: bisiklet o rotada bir "erişim
// aracı"dır. Transit yoksa bisiklet zaten yolculuğun kendisidir ve kısa
// olması meşrudur (500 m öteye gitmek isteyen biri).
const BIKE_LEG_MIN = {
  bicycle_rent: 500,   // BİSİM: QR okut, kilidi aç, sür, bırak
  bicycle_park: 800,   // kendi bisikletin: yer bul, kilitle, geri gel
};

// Tek bir yürüyüş bacağı için kabul edilen maksimum mesafe (metre)
const WALK_LEG_TARGET = {
  transit:       2000,
  bicycle:        600, // bisiklet varken uzun yürüyüş anlamsız
  // 1200 m: OTP çoğu zaman en yakın istasyonu seçmiyor (Konak'ta 249 m'deki
  // istasyon yerine 1049 m'dekini kullanıyor, yol mesafesi 1150 m). 1000 m
  // eşiğinde Konak→Karşıyaka'nın BİSİM rotalarının TAMAMI eleniyordu.
  bicycle_rent:  1200,
  bicycle_park:  1500,
  car:           Infinity,
  park_and_ride: 1500,
};

// Bisiklet profilinin artık İKİ modu var: BİSİM + aktarma (bicycle_rent) ve
// kendi bisikletin + aktarma (bicycle_park). Tek başına bisiklet sürüşü
// modu kaldırıldı (bkz. backend services/OtpService.js buildModesInput).
//
// bikeType null geldiğinde bicycle_park'a düşülür — backend de aynı şeyi
// yapıyor. İki taraf ayrı düşerse kullanıcı bir moda göre üretilmiş
// güzergâhı başka bir modun katsayılarıyla puanlanmış görürdü.
function resolveProfileKey(profile, bikeType) {
  if (profile === "bicycle") {
    if (bikeType === "RENT") return "bicycle_rent";
    return "bicycle_park";
  }
  return profile ?? "transit";
}

function calcLegDistanceMeters(leg) {
  if (typeof leg.distance === "number" && leg.distance > 0) return leg.distance;
  const pts = leg.legGeometry?.points ? decodePolyline(leg.legGeometry.points) : [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += haversineMeters(pts[i - 1], pts[i]);
  return total;
}

function calcCarbonGrams(legs) {
  return legs.reduce((sum, leg) => {
    const gPerKm = CARBON_G_PER_KM[leg.mode] ?? 0;
    return sum + gPerKm * (calcLegDistanceMeters(leg) / 1000);
  }, 0);
}

// Güzergâh başına ölçüm + skor. `rankItineraries` ve `modBosSebebi` AYNI
// sayılara bakmak zorunda: biri neyin elendiğine, diğeri niçin elendiğine
// karar veriyor. İkinci bir kopya tutmak kaçınılmaz olarak ayrışır — bu
// depoda bir kez oldu (web arayüzünün kendi puanlama kopyası aylarca eski
// eşiklerle çalıştı, bkz. senaryo/derle.js'in başındaki not).
function puanla(itineraries, profileKey) {
  const w = SCORING[profileKey] || SCORING.transit;
  const maxWalk = WALK_LEG_TARGET[profileKey] ?? 2000;
  const minBike = BIKE_LEG_MIN[profileKey] ?? 0;

  return itineraries
    .map((itin) => {
      const walkLegs = itin.legs.filter((l) => l.mode === "WALK");
      const walkDistances = walkLegs.map(calcLegDistanceMeters);
      const maxWalkSec = walkLegs.length
        ? Math.max(...walkLegs.map((l) => l.duration || 0)) : 0;
      const transitLegs = itin.legs.filter((l) => !NON_TRANSIT_MODES.includes(l.mode));
      const total = walkDistances.reduce((s, d) => s + d, 0);
      const maxLeg = walkDistances.length ? Math.max(...walkDistances) : 0;
      const overTarget = Math.max(0, maxLeg - maxWalk);
      const duration = itin.duration || itin.legs.reduce((s, l) => s + (l.duration || 0), 0);
      const transfers = Math.max(0, transitLegs.length - 1);
      // Bisikletle katedilen mesafe — yalnız ödül tanımlı profillerde hesaplanır.
      const bisikletBacaklari = itin.legs
        .filter((l) => l.mode === "BICYCLE" || l.mode === "BICYCLE_RENTAL");
      const bikeMeters = bisikletBacaklari.reduce((s, l) => s + calcLegDistanceMeters(l), 0);
      // Süre de gerekiyor: BİSİM'in "zahmete değer mi" ölçütü orandır ve
      // oran mesafeyle değil süreyle kurulur (bkz. BISIM_ASGARI_PAY).
      const bikeSaniye = bisikletBacaklari.reduce((s, l) => s + (l.duration || 0), 0);
      const carMeters = itin.legs
        .filter((l) => l.mode === "CAR")
        .reduce((s, l) => s + calcLegDistanceMeters(l), 0);
      const transitMeters = transitLegs.reduce((s, l) => s + calcLegDistanceMeters(l), 0);

      // Bisiklet burada bir erişim aracı ve o işi görmeyecek kadar kısa.
      const bisikletAnlamsiz =
        minBike > 0 && transitLegs.length > 0 && bikeMeters > 0 && bikeMeters < minBike;

      // Seçilen modun işini görüyor mu? Tek sert eleme ölçütü budur.
      const amac = MOD_AMACI[profileKey];
      // Taban çizgisi güzergâha backend tarafından iliştirilir; böylece
      // çağıranın (mobil, web demo, web arayüzü) ekstra bir şey geçirmesi
      // gerekmiyor ve üçü de aynı kuralı otomatik alıyor.
      const bisikletsizEnIyiSn = itin.bisikletsizEnIyiSn ?? null;
      // Aynı ölçüm, nötr adıyla: artık P+R de istiyor (eleme için değil,
      // çıkış teklifi için). Eski ad bisiklet modlarında dolu geldiği için
      // yedek olarak okunuyor.
      const duzTransitEnIyiSn = itin.duzTransitEnIyiSn ?? bisikletsizEnIyiSn;
      const amacaUygun = amac
        ? amac.gorur({ bikeMeters, bikeSaniye, carMeters, transitMeters, duration, bisikletsizEnIyiSn })
        : true;
      // Hiçbir modda kabul edilemez yürüyüş: tek bacakta 20 dakikadan uzun.
      const yuruyusSacma = maxWalkSec > YURUYUS_BACAK_TAVANI_SN;
      // Tek bacakta yürüyüş, TAVANA yaklaştıkça hızlanarak cezalanır.
      //
      // Doğrusal ceza tavanın hemen altını korumuyordu: 19 dakikalık bir bacak
      // tavana takılmadan geçiyor ve birkaç dakikalık süre avantajıyla listenin
      // başına çıkabiliyordu. Karesel terim aynı farkı üstte çok daha pahalı
      // yapar — oran tavanın kesridir, yani 1.0 tam tavandır:
      //   5 dk → 0.06·k   10 dk → 0.25·k   15 dk → 0.56·k   19 dk → 0.90·k
      //
      // overTargetKm'den farkı BİRİM ve REFERANS: o MODUN konfor hedefine
      // (metre) göre ölçer, bu HERKESİN tavanına (dakika) göre. Aynı şeyi iki
      // kez saymazlar; tavanın süre tabanlı olması da ölçümle seçilmişti
      // (bkz. YURUYUS_BACAK_TAVANI_SN'nin üstündeki not).
      const tavanOrani = maxWalkSec / YURUYUS_BACAK_TAVANI_SN;
      const score =
        (duration / 60) * w.durationMin +
        (total / 1000) * w.walkKm +
        transfers * w.transferPts +
        (overTarget / 1000) * w.overTargetKm +
        tavanOrani * tavanOrani * (w.uzunBacakPts ?? 0) +
        (bikeMeters / 1000) * (w.bikeKm ?? 0);
      return {
        itin,
        walk: {
          total, maxLeg, maxWalkSec, overTarget, transfers, duration,
          bikeMeters, bikeSaniye, carMeters, transitMeters,
          bisikletAnlamsiz, amacaUygun, yuruyusSacma, duzTransitEnIyiSn,
        },
        score,
      };
    })
    .sort((a, b) => a.score - b.score);
}

function rankItineraries(itineraries, profileKey) {
  const scored = puanla(itineraries, profileKey);

  // ── Eleme: iki gerekçe, İKİ FARKLI SONUÇ ────────────────────────────
  //
  // Bu ikisi eskiden tek süzgeçte toplanıyordu ve ikisi de aynı sonuca —
  // boş ekrana — çıkıyordu. Oysa farklı türden şeyler:
  //
  //   MOD AMACI bir VAAT'tir. "BİSİM + aktarma" seçen kullanıcıya BİSİM'siz
  //   bir kart göstermek vaadi bozar; doğru yanıt vaadin tutulamadığını
  //   söylemektir. Bu ölçümle alınmış bir karardır ve DEĞİŞMİYOR.
  //
  //   YÜRÜYÜŞ TAVANI bir TERCİH sınırıdır, fizik değil. Bazı yolculuklarda
  //   20 dakikanın altında yürüyen güzergâh gerçekten yoktur. Orada boş
  //   ekran kullanıcıya yardım etmiyor: yürümek zorunlu olduğunda kural
  //   "gösterme" değil "en az yürüteni göster ve zorunlu olduğunu söyle"
  //   olmalı.
  //
  // WALK_LEG_TARGET burada ELEMİYOR; skorda `overTargetKm` cezası olarak
  // yaşıyor. Sert eşik olduğunda 1250 m'lik bacak 1200 m sınırına 50 metre
  // takılıp kullanıcının tam istediği güzergâhı siliyordu.
  const amaciGoren = scored.filter((r) => r.walk.amacaUygun && !r.walk.bisikletAnlamsiz);

  // KATMAN 1 — tavana da uyanlar. Varsa yalnız bunlar gösterilir; bu,
  // değişiklikten önceki davranışın birebir aynısıdır.
  const tavanaUyan = amaciGoren.filter((r) => !r.walk.yuruyusSacma);
  if (tavanaUyan.length > 0) {
    return oneriSinirinaUydur(ayniHattiTekilleştir(tavanaUyan), profileKey);
  }

  // KATMAN 2 — mod işini görüyor ama tavanın altında yürüyen tek güzergâh
  // yok. Sıra `score`'dan gelir: yukarıdaki karesel ceza uzun bacağı zaten
  // geriye itiyor, ikinci bir sıralama kuralı koymak aynı işi iki ayrı
  // mekanizmaya bölerdi.
  //
  // oneriSinirinaUydur BURADA UYGULANMAZ: o, listenin başını SÜREYE göre
  // düzeltiyor ve az yürüteni öne alma amacını bozardı.
  if (amaciGoren.length > 0) {
    return ayniHattiTekilleştir(amaciGoren).map((r) => ({ ...r, yuruyusZorunlu: true }));
  }

  // Mod amacı hiçbir adayı geçirmedi. Son çare kartı YOK — arayüz sebebini
  // yazar ve diğer modlar bir dokunuş uzakta (bkz. modBosSebebi).
  return [];
}

// ─── Liste boş kaldığında: NİÇİN? ──────────────────────────────────────
// `rankItineraries` boş dönerse mod bu yolculukta işini göremiyor demektir.
// Bu meşru bir sonuç ama tek başına çıkmaz sokak: kullanıcı boş bir ekran ve
// genel bir cümle görüyor, sebebi bilmediği için aynı aramayı tekrarlıyordu.
//
// Burada sebep ÖLÇÜLMÜŞ sayılarla söylenir ve varsa çıkış teklifinin süresi
// döndürülür. Sayı yoksa (taban sorgusu düştüyse) `alternatifSn` null kalır
// ve arayüz teklifi hiç göstermez — uydurmaz.
//
// Dönen: { kod, mesaj, alternatifSn }
function modBosSebebi(itineraries, profileKey) {
  const bos = { kod: "bilinmiyor", mesaj: null, alternatifSn: null };
  if (!itineraries?.length) return bos;

  const scored = puanla(itineraries, profileKey);
  const alternatifSn = scored[0].walk.duzTransitEnIyiSn ?? null;
  const dk = (sn) => (sn / 60).toFixed(1).replace(".0", "");
  const km = (m) => (m / 1000).toFixed(1);

  if (profileKey === "park_and_ride") {
    // Yolculuğun kendisi kuralın transit tabanından kısaysa mod YAPISAL olarak
    // uygulanamaz — "işe yaramadı" demek yanlış olur, hiçbir eşik bunu
    // değiştiremez. Uçlar ilk bacağın çıkışı ve son bacağın varışı.
    const ilk = itineraries[0].legs[0]?.from;
    const son = itineraries[0].legs[itineraries[0].legs.length - 1]?.to;
    // haversineMeters {latitude, longitude} alır; OTP bacakları lat/lon
    // veriyor, çevirmek gerekiyor.
    const kusUcusu =
      ilk?.lat != null && son?.lat != null
        ? haversineMeters(
            { latitude: ilk.lat, longitude: ilk.lon },
            { latitude: son.lat, longitude: son.lon }
          )
        : null;
    if (kusUcusu != null && Number.isFinite(kusUcusu) && kusUcusu < 2000) {
      return {
        kod: "kisa-mesafe",
        mesaj: `Bu mesafe için Park & Ride anlamlı değil — yolculuk zaten ${km(kusUcusu)} km.`,
        alternatifSn,
      };
    }
    // Aracın yolculuğu yuttuğu durum: en çok transit yapan adayın sayıları
    // gösterilir, çünkü kullanıcıya "en iyi ihtimalle bu" demek gerekiyor.
    const enIyi = scored.reduce((a, b) =>
      b.walk.transitMeters > a.walk.transitMeters ? b : a);
    return {
      kod: "arac-domine",
      mesaj: `Araç ${km(enIyi.walk.carMeters)} km, toplu taşıma ${km(enIyi.walk.transitMeters)} km — ` +
             "bu bir araba yolculuğu, park + aktarma değil.",
      alternatifSn,
    };
  }

  if (profileKey === "bicycle_park") {
    const esik = BIKE_LEG_MIN.bicycle_park ?? 0;
    const enUzunBisiklet = Math.max(...scored.map((r) => r.walk.bikeMeters));
    if (enUzunBisiklet < esik) {
      return {
        kod: "bisiklet-kisa",
        mesaj: `En uzun bisiklet bacağı ${Math.round(enUzunBisiklet)} m (eşik ${esik} m) — ` +
               "bu kadar kısa bir sürüş için bisikleti çıkarmaya değmez.",
        alternatifSn,
      };
    }
    // Kazanç: bisikletsiz en iyiye göre ne kadar erken varıyoruz.
    const taban = scored[0].walk.duzTransitEnIyiSn;
    if (taban != null) {
      const kazanc = taban - Math.min(...scored.map((r) => r.walk.duration));
      // Artık yalnız TAVANI AŞAN uzatma eler. Küçük kayıplar mod açıkken
      // gösterilir, dolayısıyla buraya ancak gerçekten uzun bir uzatmayla
      // gelinir; sayıyı ve sınırı birlikte söylemek gerekiyor.
      if (kazanc < -BISIKLET_AZAMI_KAYIP_SN) {
        return { kod: "bisiklet-yavas",
                 mesaj: `Bisiklet bu yolculuğu ${dk(-kazanc)} dk uzatıyor ` +
                        `(kabul sınırı ${dk(BISIKLET_AZAMI_KAYIP_SN)} dk).`, alternatifSn };
      }
      // Buraya düşmek elemenin kazanç ölçütünden GELMEDİĞİ anlamına gelir.
      return { ...bos, kod: "bisiklet-katkisiz", alternatifSn };
    }
    return { ...bos, kod: "bisiklet-katkisiz", alternatifSn };
  }

  if (profileKey === "bicycle_rent") {
    const esik = BIKE_LEG_MIN.bicycle_rent ?? 0;
    const enUzun = Math.max(...scored.map((r) => r.walk.bikeMeters));
    if (enUzun < esik) {
      return {
        kod: "bisim-kisa",
        mesaj: `En uzun BİSİM bacağı ${Math.round(enUzun)} m (eşik ${esik} m) — ` +
               "bu kadar kısa bir sürüş için bisiklet almaya değmez.",
        alternatifSn,
      };
    }
    const enIyiPay = Math.max(...scored.map((r) =>
      r.walk.duration ? r.walk.bikeSaniye / r.walk.duration : 0));
    return {
      kod: "bisim-payi-dusuk",
      mesaj: `BİSİM sürüşü yolculuğun yalnız %${Math.round(enIyiPay * 100)}'i ` +
             `(eşik %${Math.round(BISIKLET_ASGARI_PAY * 100)}) — o kadar yoldan sonra ` +
             "bisiklet aramaya değmiyor.",
      alternatifSn,
    };
  }

  return { ...bos, alternatifSn };
}

// Aynı hattın ardışık kalkışlarını teke indirir.
//
// Ölçüldü — Konak → Bornova, düz toplu taşıma: dönen 10 güzergâhın 10'u da
// M1 metrosuydu, yalnız kalkış saatleri farklıydı (08:06, 08:07, 08:16,
// 08:17, 08:26 …). Kullanıcı aynı kartı on kez görüyordu.
//
// Bu OTP'nin hatası değil: o pencere içindeki her kalkışı döndürüyor ve
// Konak→Bornova için M1'den başka makul hat gerçekten yok. Karar gösterim
// katmanına ait — kullanıcıya "aynı metro, 10 dakika sonra" ayrı bir seçenek
// değildir. En iyi puanlı olan (yani en erken varan) tutulur.
//
// İmza YALNIZ transit bacaklarından kurulur: hat kimliği + binilen durak.
//
// İki incelik var, ikisi de testle yakalandı:
//  • Transit İÇERMEYEN güzergâhlar hiç tekilleştirilmez. İki ayrı bisiklet
//    rotasının mod dizisi de "WALK>BICYCLE>WALK"tır; onları aynı saymak
//    gerçek seçenekleri siler. Ortada "hat" yoksa "aynı hattın başka
//    kalkışı" da yoktur.
//  • Binilen durak imzaya girer: aynı hatta farklı duraktan binmek (ör.
//    bisikletle daha ileri gidip sonraki istasyondan binmek) ayrı bir
//    seçenektir, kalkış saati farkı değildir.
function hatImzasi(itin) {
  const transitBacaklar = itin.legs.filter((l) => l.route);
  if (transitBacaklar.length === 0) return null;   // tekilleştirmeye konu değil
  return transitBacaklar
    .map((l) => {
      const hat = l.route.shortName || l.route.longName || "";
      const durak = l.from?.stop?.gtfsId || l.from?.name || "";
      return `${l.mode}:${hat}@${durak}`;
    })
    .join(">");
}

function ayniHattiTekilleştir(ranked) {
  const gorulen = new Set();
  return ranked.filter((r) => {
    const k = hatImzasi(r.itin);
    if (k === null) return true;                   // transitsiz: her zaman kalır
    if (gorulen.has(k)) return false;
    gorulen.add(k);
    return true;
  });
}

// Sıralanmış listenin BAŞINI öneri sınırına uydurur: en üstteki güzergâh,
// listedeki en hızlıdan ONERI_TOLERANSI katından fazla yavaşsa, sınırı
// sağlayan en iyi puanlı güzergâh öne alınır. Geri kalan sıra korunur —
// amaç listeyi yeniden dizmek değil, "Önerilen" etiketini bağlamak.
function oneriSinirinaUydur(ranked, profileKey) {
  const tol = ONERI_TOLERANSI[profileKey];
  if (!tol || ranked.length < 2) return ranked;

  const sureler = ranked.map((r) => r.walk.duration);
  const enHizli = Math.min(...sureler);
  if (sureler[0] <= enHizli * tol) return ranked;

  const uygunIndeks = ranked.findIndex((r) => r.walk.duration <= enHizli * tol);
  if (uygunIndeks <= 0) return ranked;
  const yeni = ranked.slice();
  const [secilen] = yeni.splice(uygunIndeks, 1);
  yeni.unshift(secilen);
  return yeni;
}

// ─── Aday etiketleri ───────────────────────────────────────────────────
// Her etiket bir ÖLÇÜ'dür ve ölçünün en iyisini işaret eder. Etiket yalnız
// o ölçü adaylar arasında GERÇEKTEN DEĞİŞİYORSA gösterilir.
//
// Eskiden hangi modda hangi etiketin olacağı elle yazılıydı ve bu tablo
// hata kaynağıydı: "Çevreci" bisiklet modlarında unutulmuştu, oysa ölçüldü
// ki en ayırt edici etiket orada — bicycle_rent 4/4, bicycle_park 6/7
// senaryoda Önerilen'den farklı bir güzergâh gösteriyordu.
//
// Artık liste tek: eleme ölçümle yapılıyor. Bir modda aktarma hep 0 ise
// "Az Aktarma" kendiliğinden çıkmaz.
//
// "EN UCUZ" KALDIRILDI. Ücret bilgisi kartta durmaya devam ediyor; kaldırılan
// yalnız "bu güzergâh en ucuzu" ETİKETİ ve webdeki aynı adlı sıralama
// seçeneği. Etiketin dayandığı hesap eksikti: yalnız toplu taşıma ücretini
// sayıyor, BİSİM kiralama bedelini ve P+R'de otopark ücretini hiç görmüyordu
// — yani bisiklet ve araba modlarında "en ucuz" dediği şey ölçülmemiş bir
// iddiaydı. Tarifeler modellenirse ölçümle geri getirilebilir.
const ADAY_OLCULERI = [
  { tag: "Önerilen",   tagColor: "#60a5fa", olcu: null },   // sıralamanın birincisi
  { tag: "En Hızlı",   tagColor: "#f59e0b", olcu: (c) => c.walk.duration },
  { tag: "Az Aktarma", tagColor: "#a78bfa", olcu: (c) => c.walk.transfers },
  { tag: "Çevreci",    tagColor: "#34d399", olcu: (c) => c.carbon },
];

// Geriye dönük uyumluluk: dışarıda CANDIDATE_DEFS bekleyen kod olabilir.
const CANDIDATE_DEFS = Object.fromEntries(
  ["transit", "bicycle", "bicycle_rent", "bicycle_park", "car", "park_and_ride"]
    .map((k) => [k, ADAY_OLCULERI])
);

// Kaç benzersiz rota kartı gösterileceği — etiketli adaylar + ekstra seçenekler
const MAX_ROUTES = {
  transit:       5,
  bicycle:       3,
  bicycle_rent:  4,
  bicycle_park:  4,
  car:           2,
  park_and_ride: 4,
};

// Ekstra rotalar için kısa etiket: transit hattı adları yoksa doğrudan mod
function routeScenarioLabel(itin) {
  const names = itin.legs
    .filter((l) => !NON_TRANSIT_MODES.includes(l.mode) && l.route?.shortName)
    .map((l) => l.route.shortName);
  if (names.length > 0) {
    const unique = [...new Set(names)].slice(0, 2);
    const text = unique.join("+");
    return text.length > 9 ? text.slice(0, 8) + "…" : text;
  }
  const directLeg = itin.legs.find((l) => ["BICYCLE", "BICYCLE_RENTAL", "CAR"].includes(l.mode));
  return directLeg ? (MODE_STYLE[directLeg.mode]?.label ?? directLeg.mode) : "Rota";
}

// Dedup key: süre + yürüyüş + kullanılan transit hatlar — farklı hatlar ayrı kart olur
function candidateKey(itin, walk) {
  const lines = itin.legs
    .filter((l) => !NON_TRANSIT_MODES.includes(l.mode))
    .map((l) => l.route?.shortName || "")
    .join(",");
  return `${Math.round(walk.duration)}_${Math.round(walk.total)}_${lines}`;
}

// Ücret parametreleri KALDIRILDI: tek kullanıcıları "En Ucuz" etiketiydi.
// Kartta gösterilen ücreti buildRouteResult hesaplıyor, o hâlâ tarifeyi alıyor.
function selectCandidates(ranked, profileKey) {
  // `ucret` burada hesaplanıyordu; tek tüketicisi "En Ucuz" etiketiydi ve o
  // kaldırıldı (bkz. ADAY_OLCULERI). Kartta gösterilen ücret buradan değil
  // buildRouteResult'tan geliyor, o yerinde duruyor.
  const withCarbon = ranked.map((r) => ({
    ...r,
    carbon: calcCarbonGrams(r.itin.legs),
  }));
  const maxRoutes = MAX_ROUTES[profileKey] ?? 5;

  // Ölçüsü adaylar arasında değişmeyen etiket bilgi taşımaz — gösterilmez.
  const defs = ADAY_OLCULERI.filter(({ olcu }) => {
    if (!olcu) return true;                       // "Önerilen" her zaman var
    const degerler = withCarbon.map(olcu);
    return Math.min(...degerler) !== Math.max(...degerler);
  });

  const result = [];
  const seen = new Map();          // candidateKey → kart

  // 1. Etiketli adaylar (Önerilen, Az Aktarma, vb.)
  //
  // Bir güzergâh birden çok üstünlüğe sahip olabilir; o zaman etiket
  // DÜŞÜRÜLMEZ, kartın üstüne EKLENİR. Eskiden ikinci etiket `seen`
  // kümesine takılıp tamamen atılıyordu ve kullanıcı bilgiyi kaybediyordu.
  //
  // Ölçüldü — 60 mod-senaryoda etiketlerin kaçında göründüğü:
  //   Önerilen 60/60,  Az Aktarma 14/60,  Çevreci 10/60,  En Hızlı 6/60
  // "En Hızlı" 60 senaryonun yalnız 6'sında görünüyordu. Rota listede
  // duruyordu; kaybolan şey onun aynı zamanda en hızlısı OLDUĞU bilgisiydi.
  for (const { tag, tagColor, olcu } of defs) {
    const candidate = olcu
      ? [...withCarbon].sort((a, b) => olcu(a) - olcu(b))[0]
      : withCarbon[0];
    if (!candidate) continue;
    const key = candidateKey(candidate.itin, candidate.walk);
    const mevcut = seen.get(key);
    if (mevcut) {
      if (!mevcut.etiketler.includes(tag)) mevcut.etiketler.push(tag);
      continue;
    }
    const kart = { ...candidate, tag, tagColor, etiketler: [tag] };
    seen.set(key, kart);
    result.push(kart);
  }

  // 2. Kalan slotları sıralı rotalarla doldur (gri etiket + hat adı)
  for (const candidate of withCarbon) {
    if (result.length >= maxRoutes) break;
    const key = candidateKey(candidate.itin, candidate.walk);
    if (seen.has(key)) continue;
    const etiket = routeScenarioLabel(candidate.itin);
    const kart = { ...candidate, tag: etiket, tagColor: "#64748b", etiketler: [etiket] };
    seen.set(key, kart);
    result.push(kart);
  }

  return result;
}

// ─── ÜCRET: TARİFELER ──────────────────────────────────────────────────
// TARİFE TEK YERDE. Aynı rakamlar daha önce üç yerde ayrı ayrı yazılıydı
// (mobil SettingsScreen, mobil OnBoardingScreen, web index.html) ve
// birbirini tutmuyordu: onboarding "Yetişkin 25,00 ₺" derken ayarlar aynı
// bilete 35,00 ₺ diyordu. Tarife veridir, arayüz değil — üç ekran da
// buradan okur.
//
// İzmirim Kart'ta 90 dakika içindeki aktarmalar tek ücrete dahildir.
// Kredi/banka kartında aktarma hakkı yoktur, her biniş ayrı ücretlenir —
// `perBoarding` bunu ayırt eder.
const BILET_TARIFESI = [
  { id: "tam",        ad: "Tam",                 base: 35,   perBoarding: false, aciklama: "İzmirim Kart · 90 dk aktarma dahil" },
  { id: "genc",       ad: "Genç Kart (Öğrenci)", base: 17.5, perBoarding: false, aciklama: "7-25 yaş · 90 dk aktarma dahil" },
  { id: "ogretmen",   ad: "Öğretmen Kartı",      base: 23.5, perBoarding: false, aciklama: "İzmirim Kart · 90 dk aktarma dahil" },
  { id: "yas60",      ad: "60 Yaş Kartı",        base: 29,   perBoarding: false, aciklama: "İzmirim Kart · 90 dk aktarma dahil" },
  { id: "kredikarti", ad: "Kredi / Banka Kartı", base: 39,   perBoarding: true,  aciklama: "Her binişte ayrı ücret · aktarma hakkı yok" },
];

const VARSAYILAN_BILET = "tam";

function biletTarifesi(id) {
  return BILET_TARIFESI.find((b) => b.id === id) || BILET_TARIFESI[0];
}

// BİSİM — Standart Bisiklet.
//
// Açılış bloğu ilk 5 dakikayı KAPSAR, üstüne eklenmez: 5 dakika 10,00 TL,
// 6. dakika 11,50 TL. Yayımlanan "1 saat 92,50 TL" bunu doğruluyor
// (10 + 55 × 1,50 = 92,50); açılış bedelinin üstüne 60 dakika daha
// sayılsaydı 100,00 TL çıkardı.
const BISIM_TARIFESI = {
  acilisDakika: 5,
  acilisUcreti: 10,
  dakikaUcreti: 1.5,
  // Kiralamada karttan çekilen ön provizyon. Yolculuğun MALİYETİ DEĞİL:
  // bloke edilir ve iade edilir. Bu yüzden toplama girmiyor, ayrı bir not
  // olarak taşınıyor — toplama eklemek 10 dakikalık bir sürüşü dört katı
  // pahalı gösterirdi.
  provizyon: 47.5,
};

// Başlanan dakika ücretlendirilir (Math.ceil): kiralama sistemleri
// dakikanın altını bölmez.
function calcBisimFare(saniye) {
  if (!saniye || saniye <= 0) return 0;
  const dk = Math.ceil(saniye / 60);
  const { acilisDakika, acilisUcreti, dakikaUcreti } = BISIM_TARIFESI;
  if (dk <= acilisDakika) return acilisUcreti;
  return acilisUcreti + (dk - acilisDakika) * dakikaUcreti;
}

// Kuruş kalıntısını temizler: 1,5 × 3 gibi çarpımlar kayan noktada
// 4.499999999999999 üretebiliyor.
function kurusYuvarla(tutar) {
  return Math.round(tutar * 100) / 100;
}

// Ekranda gösterilecek biçim — Türkçe ondalık ayracı virgül, tam sayı
// tutarlarda kuruş yazılmaz (35 ₺, 17,50 ₺).
function ucretYazi(tutar) {
  const v = kurusYuvarla(tutar);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(".", ",");
}

// Toplu taşıma bileti.
// Kredi/banka kartı: 90 dk aktarma hakkı yok → her biniş ayrı ücret
// İzmirim Kart: 90 dk içinde aktarmalar dahil → yolculuk başı sabit ücret
function calcJourneyFare(transitLegCount, fareBase, farePerBoarding) {
  if (transitLegCount === 0) return 0;
  return farePerBoarding ? transitLegCount * fareBase : fareBase;
}

function buildRouteResult(candidate, fareBase, farePerBoarding, profileKey) {
  const { itin, walk, tag, tagColor, carbon, etiketler, yuruyusZorunlu } = candidate;

  // Park noktası: ardından transit/yürüyüş gelen vehicle leg'in varışı.
  //
  // ARACIN GERİ DÖNMEDİĞİNDEN emin olunmalı. Bisiklet artık metroya/
  // tramvaya/İZBAN'a BİNDİRİLEBİLİYOR (bkz. backend buildModesInput); öyle
  // bir güzergâhta bisiklet bacağı transitten sonra yeniden başlar, yani
  // hiçbir yere park edilmemiştir. Bu kontrol olmadan haritaya kullanıcının
  // uğramayacağı bir "park noktası" pini konuyordu.
  const PARKING_MODES = ["CAR", "BICYCLE", "BICYCLE_RENTAL"];
  const parkingLegIdx = itin.legs.findIndex(
    (l, i) =>
      PARKING_MODES.includes(l.mode) &&
      l.to?.lat != null &&
      l.to?.lon != null &&
      i < itin.legs.length - 1 &&
      !itin.legs.slice(i + 1).some((sonraki) => PARKING_MODES.includes(sonraki.mode))
  );
  const parkingPoint =
    parkingLegIdx !== -1
      ? {
          lat: itin.legs[parkingLegIdx].to.lat,
          lon: itin.legs[parkingLegIdx].to.lon,
          name: itin.legs[parkingLegIdx].to.name || "Otopark",
        }
      : null;

  const legs = itin.legs.map((leg) => {
    const style = MODE_STYLE[leg.mode] || MODE_STYLE.WALK;
    return {
      mode: leg.mode,
      from: leg.from?.name || "Başlangıç",
      to: leg.to?.name || "Varış",
      duration: leg.duration || 0,
      color: style.color,
      icon: style.icon,
      label: style.label,
      routeName: leg.route?.shortName || null,
      // Mesafe OTP'nin kendi değerinden gelir; yoksa çizim noktalarından hesaplanır.
      // Toplam mesafe, yürüyüş payı ve bacak listesindeki "x km" aynı kaynağı kullanır.
      distanceMeters: calcLegDistanceMeters(leg),
      coords: leg.legGeometry?.points ? decodePolyline(leg.legGeometry.points) : [],
    };
  });

  const totalDuration = legs.reduce((s, l) => s + l.duration, 0);
  const totalDistance = legs.reduce((s, l) => s + l.distanceMeters, 0);
  const walkDistance = legs
    .filter((l) => l.mode === "WALK")
    .reduce((s, l) => s + l.distanceMeters, 0);

  const transitLegs = legs.filter((l) => !NON_TRANSIT_MODES.includes(l.mode));

  // ÜCRET İKİ KALEMDİR. Toplu taşıma bileti BİSİM kiralamasını kapsamıyor;
  // kart eskiden yalnız bileti yazdığı için BİSİM modunda gösterilen rakam
  // gerçeğin altındaydı — 40 dakikalık bir sürüşte 35,00 TL yazıyordu,
  // gerçekte 35,00 + 62,50 = 97,50 TL.
  const bisimSaniye = legs
    .filter((l) => l.mode === "BICYCLE_RENTAL")
    .reduce((s, l) => s + l.duration, 0);
  const bisimUcreti  = calcBisimFare(bisimSaniye);
  const biletUcreti  = calcJourneyFare(transitLegs.length, fareBase, farePerBoarding);

  const maxWalk = WALK_LEG_TARGET[profileKey] ?? 2000;
  // İki ayrı uyarı, iki ayrı şey. "Hedefin üstünde" bir konfor notudur;
  // "zorunlu" ise kuralın istisnaya düştüğünü söyler — kullanıcı 20 dakikadan
  // uzun yürüyen bir kart görüyorsa bunun neden gösterildiğini bilmeli, yoksa
  // tavanın sessizce kaldırıldığını sanır.
  const walkWarning = yuruyusZorunlu
    ? `Bu yolculukta tek seferde en az ${Math.round(walk.maxWalkSec / 60)} dk yürümek ` +
      "gerekiyor — daha az yürüten güzergâh yok."
    : walk.maxLeg > maxWalk
      ? `Bu rotada tek seferde ${(walk.maxLeg / 1000).toFixed(1)} km yürüyüş var.`
      : null;

  return {
    // Kartın KİMLİĞİ. Liste sırası bir kimlik değil: rota kartlarına
    // "süreye göre sırala" gibi bir seçenek eklendiği gün `key={i}` açık
    // duran kartı yanlış rotanın üstünde bırakırdı — React elemanı
    // sırasıyla tanıyor. Aynı anahtar zaten adayları teklemek için
    // üretiliyordu.
    kimlik: candidateKey(itin, walk),
    legs,
    totalDuration,
    transfers: Math.max(0, transitLegs.length - 1),
    totalDistance: (totalDistance / 1000).toFixed(1),
    walkDistance: (walkDistance / 1000).toFixed(1),
    walkWarning,
    // Arayüz bunu liste düzeyinde de kullanır (bkz. hooks/useRouteSearch.js):
    // TÜM kartlar zorunluysa listenin başına ayrı bir bilgi satırı yazılır.
    yuruyusZorunlu: !!yuruyusZorunlu,
    cost: kurusYuvarla(biletUcreti + bisimUcreti),
    // Kalemler ayrı taşınıyor: arayüz "35,00 + BİSİM 62,50" diye dökebilsin,
    // toplamı yeniden hesaplamak zorunda kalmasın.
    ucretDetay: {
      bilet: kurusYuvarla(biletUcreti),
      bisim: kurusYuvarla(bisimUcreti),
      bisimDakika: bisimSaniye > 0 ? Math.ceil(bisimSaniye / 60) : 0,
      // Provizyon toplama DAHİL DEĞİL (bkz. BISIM_TARIFESI); yalnız BİSİM
      // içeren yolculukta gösterilir.
      provizyon: bisimSaniye > 0 ? BISIM_TARIFESI.provizyon : 0,
    },
    tag,
    tagColor,
    carbonGrams: Math.round(carbon),
    // Bu güzergâhın sahip olduğu TÜM üstünlükler. `tag` birincil olandır;
    // arayüz kalanları ikincil rozet olarak gösterir.
    etiketler: etiketler || [tag],
    parkingPoint,
  };
}

/* ── routeInstructions.js ── */
const TRANSIT_MODES = ["BUS", "RAIL", "SUBWAY", "TRAM"];   // vapur yok — bkz. routeScoring
const BISIKLET_MODLARI = ["BICYCLE", "BICYCLE_RENTAL"];

const YER_DEGIL = new Set(["from", "to", "unknown", "Başlangıç", "Varış", "BİSİM bisikleti"]);

function yer(ad) {
  const t = String(ad ?? "").trim();
  return !t || YER_DEGIL.has(t) ? null : t;
}

const dk = (leg) => `${Math.max(1, Math.round((leg.duration || 0) / 60))} dk`;

// Yolculuğun UÇLARI dışarıdan verilir. Sebep: OTP'ye gönderilen uç etiketleri
// "Başlangıç"/"Varış" (bkz. backend OtpService.js planConnection) ve `yer()`
// onları yer adı saymıyor — haklı olarak, çünkü yer adı değiller. Sonuç, son
// adımın "Varışa yürü" demesiydi: kullanıcının aradığı "Karşıyaka İskele"
// ekranda hiç geçmiyordu. Uçları bilen tek katman arayüz (kullanıcının
// yazdığı/seçtiği ad orada), o yüzden buraya parametreyle iner.
// Bacağın İKİ UCU, adlarıyla. Ayrı durmasının sebebi: arayüzler adımı iki
// ayrı biçimde gösteriyor — biri eylem cümlesi ("Poligon durağına yürü"),
// öbürü akış satırı ("Konak Meydanı → Poligon"). İkisi de aynı ad çözümüne
// dayanmalı, yoksa aynı bacak iki yerde iki başka yer adıyla görünür.
function legUclari(leg, legs = null, index = -1, uclar = {}) {
  const liste = Array.isArray(legs) ? legs : [];
  const i = index >= 0 ? index : liste.indexOf(leg);
  // Uç adı yalnız İLK bacağın kalkışına ve SON bacağın varışına düşer;
  // aradaki bacakların uçları gerçek durak adlarıdır, onlara dokunulmaz.
  const sonMu = i >= 0 ? i === liste.length - 1 : false;
  return {
    nereden: yer(leg.from) || (i === 0 ? yer(uclar.baslangic) : null),
    nereye: yer(leg.to) || (sonMu ? yer(uclar.varis) : null),
  };
}

// Adım metni + çözülmüş uçlar. `nereden`/`nereye` dönmesi bilerek: arayüz
// "şuradan şuraya" satırını kendi uydurmasın, uç adlarını buradan alsın.
function getLegInstruction(leg, legs = null, index = -1, uclar = {}) {
  const uc = legUclari(leg, legs, index, uclar);
  return { ...adimMetni(leg, legs, index, uc), ...uc };
}

function adimMetni(leg, legs, index, uc) {
  const liste = Array.isArray(legs) ? legs : [];
  const i = index >= 0 ? index : liste.indexOf(leg);
  const sonraki = i >= 0 ? liste[i + 1] : undefined;
  const sonMu = i >= 0 ? i === liste.length - 1 : false;
  const { nereden, nereye } = uc;

  if (leg.mode === "WALK") {
    if (sonraki && TRANSIT_MODES.includes(sonraki.mode)) {
      return { title: nereye ? `${nereye} durağına yürü` : "Durağa yürü", detail: `${dk(leg)} yürüyüş` };
    }
    if (sonraki && sonraki.mode === "BICYCLE_RENTAL") {
      return { title: "Bisikletin yanına yürü", detail: `${dk(leg)} yürüyüş` };
    }
    if (sonMu || !sonraki) {
      return { title: nereye ? `${nereye} noktasına yürü` : "Varışa yürü", detail: `${dk(leg)} yürüyüş · son adım` };
    }
    return { title: nereye ? `${nereye} noktasına yürü` : "Yürü", detail: `${dk(leg)} yürüyüş` };
  }

  if (TRANSIT_MODES.includes(leg.mode)) {
    const hat = leg.routeName
      ? `${leg.routeName} hattına`
      : leg.label ? `${leg.label} hattına` : "Araca";
    const bin = nereden ? `${hat} ${nereden} durağından bin` : `${hat} bin`;
    const inis = nereye ? `${nereye} durağında in` : "Son durakta in";
    const oncedenBisiklet = liste.slice(0, i).some((l) => BISIKLET_MODLARI.includes(l.mode));
    const sonradanBisiklet = liste.slice(i + 1).some((l) => BISIKLET_MODLARI.includes(l.mode));
    const bisikletYanimda = oncedenBisiklet && sonradanBisiklet;
    return { title: bin, detail: bisikletYanimda ? `${inis} · bisikletin yanında` : inis };
  }

  if (leg.mode === "BICYCLE_RENTAL") {
    if (sonMu || !sonraki) {
      return { title: "Bisikletle varışa git", detail: `${dk(leg)} sürüş · hizmet alanı içinde bırak` };
    }
    if (TRANSIT_MODES.includes(sonraki.mode)) {
      return {
        title: nereye ? `Bisikletle ${nereye} durağına git` : "Bisikletle durağa git",
        detail: `${dk(leg)} sürüş · bisikleti burada bırak`,
      };
    }
    return { title: "Bisikletle devam et", detail: `${dk(leg)} sürüş` };
  }

  if (leg.mode === "BICYCLE") {
    if (sonMu || !sonraki) {
      return { title: "Bisikletle varışa git", detail: `${dk(leg)} sürüş · son adım` };
    }
    if (TRANSIT_MODES.includes(sonraki.mode)) {
      const yanindaGotururuyor = liste.slice(i + 1).some((l) => BISIKLET_MODLARI.includes(l.mode));
      return {
        title: nereye ? `Bisikletle ${nereye} istasyonuna git` : "Bisikletle istasyona git",
        detail: yanindaGotururuyor
          ? `${dk(leg)} sürüş · bisikleti yanına al`
          : `${dk(leg)} sürüş · bisikleti burada kilitle`,
      };
    }
    return { title: nereye ? `Bisikletle ${nereye} noktasına git` : "Bisikletle devam et", detail: `${dk(leg)} sürüş` };
  }

  if (leg.mode === "CAR") {
    return {
      title: nereye ? `${nereye} otoparkına sür` : "Otoparka sür",
      detail: `${dk(leg)} sürüş · aracı burada bırak`,
    };
  }

  return { title: nereye ? `${nereye} noktasına devam et` : "Devam et", detail: dk(leg) };
}

// ─── Kartın tek satırlık güzergâh özeti ────────────────────────────────
// Kullanıcı bildirimi: "yolculuk görünüyor ama nereden nereye gidileceği
// anlaşılmıyor". Kapalı kartta yalnız süre, mesafe ve mod ikonları vardı;
// hangi duraktan binilip nerede inileceği ancak kart AÇILINCA görülüyordu.
//
// Zincir, yolculuğun kırılma noktalarını verir: binilen durak, aktarma
// durakları ve inilen durak.
//
// Transit yoksa (saf bisiklet/araba/yürüyüş) zincir BOŞTUR — uçları
// tekrarlamaz. Kırılma noktası olmayan bir yolculukta söylenecek tek şey
// zaten uçlardır ve onları listenin başlığı söylüyor; aynı iki adı bir de
// kartın içine yazmak bilgi eklemiyor, satır ekliyordu.
function guzergahZinciri(legs) {
  const liste = Array.isArray(legs) ? legs : [];
  const transit = liste.filter((l) => TRANSIT_MODES.includes(l.mode));
  if (transit.length === 0) return [];

  const noktalar = [];
  transit.forEach((l, i) => {
    noktalar.push(yer(l.from) || "Durak");
    if (i === transit.length - 1) noktalar.push(yer(l.to) || "Son durak");
  });
  // Aynı durakta aktarmada iniş ve biniş adı aynıdır; iki kez yazmak
  // zincirde olmayan bir adım varmış izlenimi veriyor.
  return noktalar.filter((ad, i) => ad !== noktalar[i - 1]);
}

global.RS = { SCORING, WALK_LEG_TARGET, BIKE_LEG_MIN, MOD_AMACI, MUTLAK_YURUYUS_TAVANI, YURUYUS_BACAK_TAVANI_SN, BISIKLET_ASGARI_PAY, MODE_STYLE, NON_TRANSIT_MODES, resolveProfileKey, calcLegDistanceMeters, rankItineraries, selectCandidates, buildRouteResult, getLegInstruction, guzergahZinciri, CANDIDATE_DEFS, ADAY_OLCULERI, MAX_ROUTES, calcCarbonGrams, candidateKey, calcJourneyFare, ONERI_TOLERANSI, oneriSinirinaUydur, ayniHattiTekilleştir, decodePolyline };
})(typeof window !== "undefined" ? window : globalThis);
