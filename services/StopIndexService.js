const axios = require("axios");
const config = require("../config");

// ─── Durak indeksi ─────────────────────────────────────────────────────
// Adres arama sonuçlarını sıralamak için kullanılır: bir ulaşım uygulamasında
// bir noktanın değeri, çevresindeki ulaşım altyapısıdır.
//
// Önceki yaklaşım sonuçları OSM tür etiketine göre sıralıyordu (önce yerleşim,
// sonra sokak, en sonda bina). Bu dolaylı bir tahmindi ve yanlış sonuç verdi:
// "Karşıyaka" aramasında ilçe SINIRININ centroid'i (boundary=administrative)
// öne çıkıyor, kullanıcı onu seçiyor ve dağlık bir noktaya yönlendiriliyordu.
//
// Ölçüldüğünde fark açıktı:
//   ilçe sınırı centroid'i   en yakın durak 188 m,  300 m içinde  2 durak
//   sahildeki merkez         en yakın durak  59 m,  300 m içinde 10 durak
//
// Artık tahmin değil ölçüm: her aday koordinat için en yakın durak mesafesi ve
// yakın çevredeki durak sayısı hesaplanıp sıralamada kullanılıyor.

const HUCRE = 0.0045;          // ~500 m'lik ızgara hücresi
const YAKIN_YARICAP = 300;     // "yürüme mesafesi" sayılan çevre (m)
const R = 6371000, D = Math.PI / 180;

let izgara = null;             // Map<"i|j", [{lat, lon}]>
let durakSayisi = 0;
let yuklemeZamani = 0;
let yukleniyor = null;

function haversine(a, b) {
  const dLa = (b.lat - a.lat) * D, dLo = (b.lon - a.lon) * D;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

const anahtar = (lat, lon) => Math.floor(lat / HUCRE) + "|" + Math.floor(lon / HUCRE);

// Durakları OTP'den bir kez çeker. Konumlar graph ömrü boyunca sabit olduğu
// için yeniden çekmeye gerek yok; yalnız OTP yeniden başlarsa tazelenir.
async function yukle() {
  if (izgara) return izgara;
  if (yukleniyor) return yukleniyor;

  yukleniyor = (async () => {
    try {
      const res = await axios.post(
        config.OTP_URL,
        { query: "{ stops { lat lon } }" },
        { timeout: config.TIMEOUT.OTP_SORGU }
      );
      const liste = res.data?.data?.stops || [];
      const yeni = new Map();
      for (const s of liste) {
        if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
        const k = anahtar(s.lat, s.lon);
        if (!yeni.has(k)) yeni.set(k, []);
        yeni.get(k).push({ lat: s.lat, lon: s.lon });
      }
      izgara = yeni;
      durakSayisi = liste.length;
      yuklemeZamani = Date.now();
      console.log(`Durak indeksi: ${durakSayisi} durak, ${izgara.size} hücre`);
      return izgara;
    } catch (err) {
      // OTP hazır değilse arama yine çalışmalı — sıralama o istekte tür
      // önceliğine düşer, bir sonraki istekte yeniden denenir.
      console.warn("Durak indeksi kurulamadı:", err.message);
      return null;
    } finally {
      yukleniyor = null;
    }
  })();

  return yukleniyor;
}

// Bir koordinatın ulaşım çevresi. İndeks yoksa null döner (çağıran yedeğe düşer).
function cevre(lat, lon) {
  if (!izgara) return null;
  const ci = Math.floor(lat / HUCRE), cj = Math.floor(lon / HUCRE);
  const nokta = { lat, lon };
  let enYakin = Infinity, yakinSayi = 0;

  // 3×3 hücre yeterli: hücre ~500 m, aranan yarıçap 300 m.
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      for (const d of izgara.get((ci + a) + "|" + (cj + b)) || []) {
        const m = haversine(nokta, d);
        if (m < enYakin) enYakin = m;
        if (m <= YAKIN_YARICAP) yakinSayi++;
      }
    }
  }
  return { enYakin: Number.isFinite(enYakin) ? enYakin : null, yakinSayi };
}

// Sıralama skoru — KÜÇÜK olan önce gelir.
// İki bileşen: durağa yürüme mesafesi (asıl belirleyici) ve çevredeki durak
// sayısı (seçenek zenginliği, üst sınırı var ki tek bir aktarma merkezi
// her aramayı ele geçirmesin).
function yakinlikSkoru(lat, lon) {
  const c = cevre(lat, lon);
  if (!c || c.enYakin == null) return null;
  return c.enYakin / 100 - Math.min(c.yakinSayi, 12) * 0.5;
}

function getStatus() {
  return {
    hazir: !!izgara,
    duraklar: izgara ? durakSayisi : null,
    yasSec: izgara ? Math.floor((Date.now() - yuklemeZamani) / 1000) : null,
  };
}

module.exports = { yukle, cevre, yakinlikSkoru, getStatus, YAKIN_YARICAP };
