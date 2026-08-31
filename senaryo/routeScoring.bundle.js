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
// OTP'den gelen ham güzergâhları puanlar, sıralar, etiketler ve arayüzün
// beklediği rota nesnesine dönüştürür.
// Tamamen saf fonksiyonlardır — React veya ağ bağımlılığı yoktur.
// VAPUR YOK: İzmir GTFS feed'inde vapur seferi bulunmuyor (route_type=4 hiç
// geçmiyor), backend de FERRY modunu OTP'ye hiç istemiyor. Karşılığı olmayan
// bir mod için stil tutmak yanıltıcıydı. Feed geldiğinde geri eklenir.
const MODE_STYLE = {
  WALK:           { color: "#7a8299", icon: "walk",  label: "Yürüyüş" },
  BUS:            { color: "#f97316", icon: "bus",   label: "Otobüs" },
  // RAIL = İZBAN banliyö hattı, SUBWAY = İzmir Metrosu. Aynı ikonu paylaşırlar,
  // bu yüzden renkleri ayrı tutulur; aksi hâlde kart şeridinde ayırt edilemezler.
  RAIL:           { color: "#4f46e5", icon: "train", label: "Banliyö" },
  SUBWAY:         { color: "#60a5fa", icon: "train", label: "Metro" },
  TRAM:           { color: "#a78bfa", icon: "tram",  label: "Tramvay" },
  BICYCLE:        { color: "#4ade80", icon: "bike",  label: "Bisiklet" },
  BICYCLE_RENTAL: { color: "#4ade80", icon: "bike",  label: "BİSİM" },
  CAR:            { color: "#f97316", icon: "car",   label: "Araba" },
};

const NON_TRANSIT_MODES = ["WALK", "BICYCLE", "BICYCLE_RENTAL", "CAR"];

const CARBON_G_PER_KM = {
  CAR: 150, BUS: 80, RAIL: 41, SUBWAY: 41, TRAM: 30,
  WALK: 0, BICYCLE: 0, BICYCLE_RENTAL: 0,
};

// Skor katsayıları — her mod kendi önceliğini yansıtır
const SCORING = {
  // Toplu taşıma: aktarma çok maliyetli (bekleme + yürüyüş), yürüyüş da ağır
  transit:       { durationMin: 1, walkKm: 7,  transferPts: 10, overTargetKm: 45 },
  // ESKİ MOD — resolveProfileKey artık bu anahtarı hiç üretmiyor (bisikletin
  // iki modu da aktarmalı). Tablolardan silinmedi: dışarıdan "bicycle"
  // geçiren bir çağrı katsayısız kalıp sessizce transit ağırlıklarına
  // düşerdi. Yeni bir şey eklerken burayı örnek almayın.
  bicycle:       { durationMin: 1, walkKm: 2,  transferPts:  3, overTargetKm: 15, bikeKm: 1 },
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
  bicycle_rent:  { durationMin: 1, walkKm: 5,  transferPts:  5, overTargetKm: 25, bikeKm: 1 },
  // Bisiklet park + transit: park sonrası yürüyüş kritik, aktarma da ağır.
  bicycle_park:  { durationMin: 1, walkKm: 8,  transferPts:  8, overTargetKm: 40, bikeKm: 1 },
  // Araba: sadece süre, yürüyüş yok
  car:           { durationMin: 1, walkKm: 0,  transferPts:  0, overTargetKm:  0 },
  // Park & Ride: yürüyüş orta ağırlık, aktarma önemli
  park_and_ride: { durationMin: 1, walkKm: 6,  transferPts:  8, overTargetKm: 35 },
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

// KENDİ BİSİKLETİNDE ÖLÇÜT FARKLI: kazanç.
//
// Oran eşiği burada yanlış şeyi ölçüyordu. Bisikletin zaten yanındadır,
// aranacak bir araç ve iade edilecek bir kiralama yoktur; tek soru "bu sürüş
// beni daha erken vardırıyor mu". Ölçüldü — Narlıdere → Çiğli:
//   72 dk  bisiklet 6 dk → M1 direkt      (bisiklet payı %8)
//   81 dk  bisikletsiz en iyi
// Bisiklet 9 DAKİKA kazandırıyor ama %15 kuralına takılıp eleniyordu ve mod
// saflığı geldiğinden beri yedeği de olmadığı için kullanıcı boş ekran
// görüyordu.
//
// Ters yön de aynı ölçüyle yakalanıyor — asıl derdimiz oydu (Konak →
// Bornova): 282 metrelik bisiklet bacağı yolculuğu 6.2 dakika UZATIYORDU.
// Kazanç negatif olduğu için elenir.
//
// EŞİK NEDEN 3 DAKİKA. On senaryoda bisikletin bisikletsize göre en iyi
// kazancı ölçüldü ve dağılım ÇİFT TEPELİ çıktı:
//
//   +23.0  uzak-kuzey          +3.1  korfez-karsi
//   +10.5  merkez-dogu         +3.1  kuzey-dogu
//    +9.5  kuzey-merkez        +1.4  guney-merkez
//    +9.2  narlidere-cigli     +0.8  guneybati-merkez
//    +9.1  uzak-guney          -9.6  sahil-guneybati
//
// Ya 9 dakikanın üstünde, ya 3 dakikanın altında; arada hiçbir şey yok.
// Bu yüzden 4 ile 8 arasındaki HER eşik aynı sonucu veriyor (5 senaryo) —
// tek gerçek karar noktası 3 dakika. Orada Konak → Karşıyaka (32 dk
// bisikletsiz, 29 dk bisikletli, 14 km sürüş) ve Karşıyaka → Bornova geri
// geliyor; ikisi de "bisiklet işe yaramıyor" denecek yolculuklar değil.
//
// 0'a indirilemez: 0.8 ve 1.4 dakikalık kazançlar ölçüm gürültüsü kadar ve
// bisikleti çıkarmayı haklı çıkarmıyor.
//
// Taban çizgisi backend'den geliyor (services/OtpService.js, ayrı bir
// yürüyüşlü sorgu) ve her güzergâha iliştirilmiş halde: itin.bisikletsizEnIyiSn.
// BİLİNMİYORSA ELEME YAPILMAZ — taban sorgusu düştüyse kullanıcıyı
// cezalandırmak yanlış olur.
const BISIKLET_ASGARI_KAZANC_SN = 3 * 60;

const MOD_AMACI = {
  bicycle_rent: {
    aciklama: "BİSİM seçildi — sürüş yolculuğun anlamlı bir payı olmalı",
    gorur: (o) =>
      o.bikeMeters >= (BIKE_LEG_MIN.bicycle_rent ?? 0) &&
      o.bikeSaniye >= o.duration * BISIKLET_ASGARI_PAY,
  },
  bicycle_park: {
    aciklama: "Bisikletim + aktarma seçildi — bisiklet yolculuğu belirgin kısaltmalı",
    gorur: (o) =>
      o.bikeMeters >= (BIKE_LEG_MIN.bicycle_park ?? 0) &&
      (o.bisikletsizEnIyiSn == null ||
        o.duration <= o.bisikletsizEnIyiSn - BISIKLET_ASGARI_KAZANC_SN),
  },
  // "Sadece bisiklet" modu ölçüldüğünde 8 güzergâhın 7'sinde HİÇ bisiklet
  // yoktu — düz transit rotalarıydı, yani mod kullanıcıya yalan söylüyordu.
  bicycle: {
    aciklama: "Sadece bisiklet seçildi — bisikletsiz güzergâh bu modda anlamsız",
    gorur: (o) => o.bikeMeters > 0,
  },
  // Park & Ride ölçümü: 10 senaryonun 6'sında araç 13–29 km, transit 0.3–1.8 km.
  // Bu bir "park et ve devam et" yolculuğu değil, araba yolculuğudur.
  park_and_ride: {
    aciklama: "Park & Ride seçildi — hem araç hem transit anlamlı olmalı",
    gorur: (o) => o.carMeters >= 2000 && o.transitMeters >= 2000,
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

function rankItineraries(itineraries, profileKey) {
  const w = SCORING[profileKey] || SCORING.transit;
  const maxWalk = WALK_LEG_TARGET[profileKey] ?? 2000;
  const minBike = BIKE_LEG_MIN[profileKey] ?? 0;

  const scored = itineraries
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
      const amacaUygun = amac
        ? amac.gorur({ bikeMeters, bikeSaniye, carMeters, transitMeters, duration, bisikletsizEnIyiSn })
        : true;
      // Hiçbir modda kabul edilemez yürüyüş: tek bacakta 20 dakikadan uzun.
      const yuruyusSacma = maxWalkSec > YURUYUS_BACAK_TAVANI_SN;
      const score =
        (duration / 60) * w.durationMin +
        (total / 1000) * w.walkKm +
        transfers * w.transferPts +
        (overTarget / 1000) * w.overTargetKm +
        (bikeMeters / 1000) * (w.bikeKm ?? 0);
      return {
        itin,
        walk: {
          total, maxLeg, maxWalkSec, overTarget, transfers, duration,
          bikeMeters, bikeSaniye, carMeters, transitMeters,
          bisikletAnlamsiz, amacaUygun, yuruyusSacma,
        },
        score,
      };
    })
    .sort((a, b) => a.score - b.score);

  // Sert eleme yalnız iki gerekçeyle: güzergâh seçilen modun işini görmüyor,
  // ya da hiçbir modda savunulamayacak kadar çok yürütüyor.
  //
  // WALK_LEG_TARGET burada ARTIK ELEMİYOR; skorda `overTargetKm` cezası
  // olarak yaşıyor. Sert eşik olduğunda 1250 m'lik bacak 1200 m sınırına
  // 50 metre takılıp kullanıcının tam istediği güzergâhı siliyordu.
  const filtered = scored.filter(
    (r) => r.walk.amacaUygun && !r.walk.bisikletAnlamsiz && !r.walk.yuruyusSacma
  );
  if (filtered.length > 0) return oneriSinirinaUydur(ayniHattiTekilleştir(filtered), profileKey);

  // ── Geriye hiçbir şey kalmadıysa ──
  //
  // MOD_AMACI tanımlı modlarda (bisiklet ve P+R) SON ÇARE KARTI YOK.
  // Eskiden burada "boş ekran gösterme" diye en iyi aday tek başına
  // döndürülüyordu ve bu, kuralı sessizce geçersiz kılıyordu: "BİSİM +
  // Aktarma" seçen kullanıcı, elenmiş olan 4 dakikalık BİSİM güzergâhını
  // yine görüyordu — üstelik alternatifsiz.
  //
  // Mod seçimi bir vaattir. Tutulamıyorsa doğru yanıt, vaadi karşılamayan
  // bir kartı yine göstermek değil, tutulamadığını söylemektir; arayüz
  // sebebini yazar ve diğer modlar bir dokunuş uzakta
  // (bkz. hooks/useRouteSearch.js).
  //
  // Amacı olmayan modlarda (düz transit, araba) eski davranış korunur:
  // orada eleme yalnız yürüyüş tavanından gelir ve gösterilecek en iyi
  // aday hâlâ o modun işini görüyordur.
  if (MOD_AMACI[profileKey]) return [];
  return scored.filter((r) => !r.walk.yuruyusSacma).slice(0, 1);
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
// senaryoda Önerilen'den farklı bir güzergâh gösteriyordu. "En Ucuz" ise
// hiçbir modda yoktu; transit'te 9/9 ayırt ediyor.
//
// Artık liste tek: eleme ölçümle yapılıyor. Bir modda aktarma hep 0 ise
// "Az Aktarma" kendiliğinden çıkmaz; ücret düz tarifeyse (İzmirim Kart,
// 90 dk aktarma dahil) "En Ucuz" kendiliğinden çıkmaz.
const ADAY_OLCULERI = [
  { tag: "Önerilen",   tagColor: "#60a5fa", olcu: null },   // sıralamanın birincisi
  { tag: "En Hızlı",   tagColor: "#f59e0b", olcu: (c) => c.walk.duration },
  { tag: "Az Aktarma", tagColor: "#a78bfa", olcu: (c) => c.walk.transfers },
  { tag: "En Ucuz",    tagColor: "#38bdf8", olcu: (c) => c.ucret },
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

function selectCandidates(ranked, profileKey, fareBase = 0, farePerBoarding = false) {
  const withCarbon = ranked.map((r) => ({
    ...r,
    carbon: calcCarbonGrams(r.itin.legs),
    // DİKKAT: BİSİM'in kendi kiralama ücreti bu hesapta YOK — yalnız toplu
    // taşıma ücreti sayılıyor. Bisiklet modlarında "En Ucuz" bu yüzden
    // eksik bilgiyle çalışır; BİSİM tarifesi modellenince buraya eklenmeli.
    ucret: calcJourneyFare(
      r.itin.legs.filter((l) => !NON_TRANSIT_MODES.includes(l.mode)).length,
      fareBase, farePerBoarding
    ),
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

// Yolculuk ücreti.
// Kredi/banka kartı: 90 dk aktarma hakkı yok → her biniş ayrı ücret
// İzmirim Kart: 90 dk içinde aktarmalar dahil → yolculuk başı sabit ücret
function calcJourneyFare(transitLegCount, fareBase, farePerBoarding) {
  if (transitLegCount === 0) return 0;
  return farePerBoarding ? transitLegCount * fareBase : fareBase;
}

function buildRouteResult(candidate, fareBase, farePerBoarding, profileKey) {
  const { itin, walk, tag, tagColor, carbon, etiketler } = candidate;

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
  const maxWalk = WALK_LEG_TARGET[profileKey] ?? 2000;
  const walkWarning =
    walk.maxLeg > maxWalk
      ? `Bu rotada tek seferde ${(walk.maxLeg / 1000).toFixed(1)} km yürüyüş var.`
      : null;

  return {
    legs,
    totalDuration,
    transfers: Math.max(0, transitLegs.length - 1),
    totalDistance: (totalDistance / 1000).toFixed(1),
    walkDistance: (walkDistance / 1000).toFixed(1),
    walkWarning,
    cost: Math.round(calcJourneyFare(transitLegs.length, fareBase, farePerBoarding)),
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
// Bacak metinleri. Kullanıcı burada bir VERİ SATIRI değil, YAPILACAK İŞ
// okumalı: "Alsancak Gar → Çiğli İtfaiye" değil, "912 hattına Alsancak
// Gar'dan bin · Çiğli İtfaiye'de in".
//
// Yer adları OTP'den geldiği gibi cümleye konamıyor. Üç tuzak var, üçü de
// ekranda görüldü:
//   • "from" / "to" — sorguya koyduğumuz etiketlerdi ve kartta
//     "from → Asmaaltı" diye çıkıyordu. Etiketler backend'de "Başlangıç" /
//     "Varış" olarak düzeltildi, ama ikisi de bir YER ADI değil; cümleye
//     konursa "Varış noktasına yürü" gibi boş bir metin çıkar.
//   • "unknown" — OTP'nin adsız düğüm karşılığı
//   • "BİSİM bisikleti" — serbest kiralık aracın adı; yer değil, araç
//
// Bacak tek başına yeterli bağlam taşımıyor, bu yüzden fonksiyon TÜM
// listeyi görüyor: bir yürüyüşün anlamı ardından geleni, bisikletin park
// edilip edilmediği ise transitten SONRA bisikletin devam edip etmediğini
// bilmeyi gerektiriyor.

const TRANSIT_MODES = ["BUS", "RAIL", "SUBWAY", "TRAM"];   // vapur yok — bkz. routeScoring
const BISIKLET_MODLARI = ["BICYCLE", "BICYCLE_RENTAL"];

const YER_DEGIL = new Set(["from", "to", "unknown", "Başlangıç", "Varış", "BİSİM bisikleti"]);

function yer(ad) {
  const t = String(ad ?? "").trim();
  return !t || YER_DEGIL.has(t) ? null : t;
}

const dk = (leg) => `${Math.max(1, Math.round((leg.duration || 0) / 60))} dk`;

function getLegInstruction(leg, legs = null, index = -1) {
  const liste = Array.isArray(legs) ? legs : [];
  const i = index >= 0 ? index : liste.indexOf(leg);
  const sonraki = i >= 0 ? liste[i + 1] : undefined;
  const sonMu = i >= 0 ? i === liste.length - 1 : false;

  const nereye = yer(leg.to);
  const nereden = yer(leg.from);

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
    // Hat numarası olmayan servisler var: İZBAN seferlerinin GTFS'te
    // short_name'i yok ve "Araca ... bin" diye çıkıyordu. O durumda modun
    // adı ("Banliyö", "Metro", "Tramvay") çok daha bilgilendirici.
    const hat = leg.routeName
      ? `${leg.routeName} hattına`
      : leg.label ? `${leg.label} hattına` : "Araca";
    const bin = nereden ? `${hat} ${nereden} durağından bin` : `${hat} bin`;
    const inis = nereye ? `${nereye} durağında in` : "Son durakta in";
    // Bisiklet bu araca BİNİYOR mu? Cevap ancak listeye bakınca verilebilir:
    // bisiklet bacağı transitten SONRA da devam ediyorsa bisiklet yanındadır.
    // Kullanıcının bilmesi gereken tam olarak bu — bırakacak mı, alacak mı.
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
      // Bisikleti park mı edecek, yanına mı alacak? Sonrasında yine bisiklet
      // bacağı varsa yanına alıyordur (metro, tramvay ve İZBAN'a bisiklet
      // binebiliyor — bkz. izmir_backend/docs/API.md).
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

global.RS = { SCORING, WALK_LEG_TARGET, BIKE_LEG_MIN, MOD_AMACI, MUTLAK_YURUYUS_TAVANI, YURUYUS_BACAK_TAVANI_SN, BISIKLET_ASGARI_PAY, MODE_STYLE, NON_TRANSIT_MODES, resolveProfileKey, calcLegDistanceMeters, rankItineraries, selectCandidates, buildRouteResult, getLegInstruction, CANDIDATE_DEFS, ADAY_OLCULERI, MAX_ROUTES, calcCarbonGrams, candidateKey, calcJourneyFare, ONERI_TOLERANSI, oneriSinirinaUydur, ayniHattiTekilleştir, decodePolyline };
})(typeof window !== "undefined" ? window : globalThis);
