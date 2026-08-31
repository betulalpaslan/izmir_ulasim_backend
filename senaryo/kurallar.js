const config = require("../config");

// ─── Güzergâh sağlığı kuralları ─────────────────────────────────────────
// Buradaki her kural, elle yakalanmış GERÇEK bir saçmalıktan doğdu. Kuralın
// üstündeki not o ölçümü tutar; sayı değiştirilecekse önce o ölçüm
// tekrarlanmalı.
//
// Hepsinin ortak şekli şu: ERİŞİM ARACI YERİNİ HAK ETMELİ. Bisiklet de araba
// da yolculuğa bir şey katmak için oradadır. Katmıyorsa — ister çok kısa
// kullanıldığı için, ister yolculuğu tamamen yuttuğu için — o güzergâh
// kullanıcıya gösterilmemeli.

const ARAC_MODLARI = ["BICYCLE", "BICYCLE_RENTAL", "CAR"];
const TRANSIT_DISI = ["WALK", "BICYCLE", "BICYCLE_RENTAL", "CAR", "LEG_SWITCH"];

const mesafe = (legs, modlar) =>
  legs.filter((l) => modlar.includes(l.mode)).reduce((s, l) => s + (l.distance || 0), 0);
const sure = (legs) => legs.reduce((s, l) => s + (l.duration || 0), 0);
const transitBacaklari = (legs) => legs.filter((l) => !TRANSIT_DISI.includes(l.mode));

// Erişim aracının anlamlı sayılması için gereken en kısa mesafe (m).
// Bisiklet eşikleri config'te; araba burada çünkü yalnız senaryo süiti
// kullanıyor (uygulama P+R'yi eleme yapmıyor — bu süitin bulgusu).
// Bisiklet eşikleri artık config'te değil uygulamada (routeScoring.js →
// BIKE_LEG_MIN); backend'in "bisikletsiz yedek" mekanizması kaldırıldığı
// için oradaki kopyalar da silindi. Süit uygulamanın puanlama paketini
// zaten yüklüyor, ama bu tablo kos.js'ten önce okunduğu için sayılar
// burada tekrarlanıyor. Uygulamadaki BIKE_LEG_MIN ile aynı kalmalı.
const ARAC_MIN_M = {
  bicycle_rent:  500,
  bicycle_park:  800,
  // 2 km: bundan kısa bir sürüş için arabayı çıkarıp park yeri aramak,
  // park süresinin (OTP'de 5 dk) tek başına yolculuğun büyük kısmı olması
  // demek. Ölçümle güncellenecek başlangıç değeri.
  park_and_ride: 2000,
};

// Transit tarafı bundan kısaysa yolculuk aslında "araba" yolculuğudur;
// son bir durak için P+R etiketi takmak kullanıcıyı yanıltır.
const TRANSIT_MIN_M = 2000;

// Tek bir yürüyüş bacağı için sert tavan (sn). Uygulamadaki
// YURUYUS_BACAK_TAVANI_SN ile aynı sayı olmalı (izmir_ulasim/utils/
// routeScoring.js) — biri değişirse diğeri de değişmeli.
const YURUYUS_TAVANI_SN = 20 * 60;

// Seçilen mod, düz toplu taşımadan bu orandan fazla yavaşsa öneri değil
// zarardır. Ölçüm: Konak → Bornova'da bisikletli 50.3 dk, düz transit
// 44.1 dk → %14 yavaş. Yedek sorgu bu yüzden eklendi.
const YAVASLIK_ORANI = 1.10;

// NOT: mod içi tolerans burada DEĞİL, uygulamanın puanlama modülünde
// (izmir_ulasim/utils/routeScoring.js → ONERI_TOLERANSI). Orada hem
// sıralamayı bağlıyor hem süitin ölçütü oluyor; iki kopya tutulursa
// ayrışırlar. kos.js onu RS üzerinden okur.

const kurallar = [
  {
    kod: "K1",
    ad: "erişim aracı çok kısa",
    // 282 m bisiklet (Konak→Bornova), 6 m bisiklet (Alsancak→Balçova).
    denetle({ modAnahtari, legs }) {
      const esik = ARAC_MIN_M[modAnahtari];
      if (!esik || transitBacaklari(legs).length === 0) return null;
      const m = mesafe(legs, ARAC_MODLARI);
      if (m > 0 && m < esik) return `araç yalnız ${Math.round(m)} m (eşik ${esik} m)`;
      return null;
    },
  },
  {
    kod: "K2",
    ad: "transit tarafı göstermelik",
    // Yolun tamamını sürüp son durakta transite binmek P+R değildir.
    denetle({ modAnahtari, legs }) {
      if (!ARAC_MIN_M[modAnahtari]) return null;
      const tl = transitBacaklari(legs);
      if (tl.length === 0) return null;
      const tm = tl.reduce((s, l) => s + (l.distance || 0), 0);
      const am = mesafe(legs, ARAC_MODLARI);
      if (tm < TRANSIT_MIN_M && am > tm)
        return `transit ${Math.round(tm)} m, araç ${Math.round(am)} m — bu bir araç yolculuğu`;
      return null;
    },
  },
  {
    kod: "K3",
    ad: "aşırı tek yürüyüş bacağı",
    denetle({ legs, yuruyusHedefi }) {
      const en = Math.max(0, ...legs.filter((l) => l.mode === "WALK").map((l) => l.distance || 0));
      if (en > yuruyusHedefi) return `tek bacakta ${Math.round(en)} m yürüyüş (hedef ${yuruyusHedefi} m)`;
      return null;
    },
  },
  {
    kod: "K10",
    ad: "20 dakikayı aşan yürüyüş bacağı",
    // K3'ten farkı: o bir HEDEF (mesafe, moda göre değişir, aşılırsa
    // cezalandırılır), bu bir TAVAN (süre, her modda aynı, aşılırsa
    // güzergâh gösterilmez). Ölçüm — Narlıdere → Çiğli, Pzt 08:00: düz
    // toplu taşımada önerilen kartın ilk bacağı 19 dk, BİSİM modunda
    // 28 dk'ydı; ikisi de eski 5000 m'lik mesafe tavanının altındaydı.
    //
    // Bu kural OTP'nin ham çıktısına da uygulanır: burada bulgu çıkması
    // beklenir ve normaldir — asıl soru, aynı güzergâhın sıralamadan sonra
    // KULLANICIYA gösterilip gösterilmediğidir (bkz. kos.js K11).
    denetle({ legs }) {
      const en = Math.max(0, ...legs.filter((l) => l.mode === "WALK").map((l) => l.duration || 0));
      if (en > YURUYUS_TAVANI_SN) return `tek bacakta ${Math.round(en / 60)} dk yürüyüş (tavan 20 dk)`;
      return null;
    },
  },
];

// Güzergâh listesinin tamamına bakan kurallar (tekil güzergâha değil).
const listeKurallari = [
  {
    kod: "K4",
    ad: "seçilen mod düz transitten yavaş",
    denetle({ enIyiSure, transitEnIyiSure }) {
      if (!enIyiSure || !transitEnIyiSure) return null;
      if (enIyiSure > transitEnIyiSure * YAVASLIK_ORANI)
        return `${(enIyiSure / 60).toFixed(1)} dk, düz transit ${(transitEnIyiSure / 60).toFixed(1)} dk`;
      return null;
    },
  },
  {
    kod: "K5",
    ad: "mod hiç görünmüyor",
    // Kullanıcı BİSİM seçti ama hiçbir sonuçta bisiklet yok — mod seçimi
    // kullanıcıya yalan söylüyor demektir.
    denetle({ modAnahtari, aracliSayi, toplamSayi }) {
      if (!ARAC_MIN_M[modAnahtari] || toplamSayi === 0) return null;
      if (aracliSayi === 0) return `${toplamSayi} güzergâhın hiçbirinde araç yok`;
      return null;
    },
  },
  {
    kod: "K6",
    ad: "kullanıcıya tek seçenek kalıyor",
    // ÖNCEKİ HÂLİ YANLIŞ ÖLÇÜYORDU: mod dizisi + süreyi imza sayıp aynı
    // hattın ardışık kalkışlarını "yineleme" ilan ediyordu. Ölçüldüğünde
    // (Konak → Bornova) o 10 güzergâhın kalkışları 08:06, 08:07, 08:16 …
    // diye farklıydı — yineleme değil tarifeydi.
    //
    // Asıl önemli olan şu: gösterim katmanı aynı hattı tekilleştirdikten
    // sonra kullanıcının elinde kaç GERÇEK seçenek kalıyor. Tek seçenek
    // meşru olabilir (Konak→Bornova için M1'den başka hat yok), o yüzden
    // bu bir hata değil bilgidir — ama görünür olmalı.
    denetle({ gosterilenSayi, hatKalibi }) {
      if (gosterilenSayi >= 1 && hatKalibi === 1)
        return `tek hat kalıbı — kullanıcının seçeneği yok`;
      return null;
    },
  },
];

module.exports = {
  kurallar, listeKurallari,
  ARAC_MODLARI, TRANSIT_DISI, ARAC_MIN_M, TRANSIT_MIN_M, YAVASLIK_ORANI,
  YURUYUS_TAVANI_SN,
  mesafe, sure, transitBacaklari,
};
