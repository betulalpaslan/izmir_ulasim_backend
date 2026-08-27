// Tek yapılandırma noktası.
//
// Buradan önce OTP_URL beş ayrı dosyada aynı iki satırla yeniden
// tanımlanıyordu, TTL'ler ve timeout'lar bulundukları yere gömülü sihirli
// sayılardı, İZELMAN adresi servisin içindeydi. Hiçbiri tek başına hata
// değildi; sorun, birini değiştirmek gerektiğinde diğerlerinin sessizce
// eski kalmasıydı.
//
// Ortam değişkeni kabul eden değerler açıkça process.env okur; gerisi sabit.

const PORT = 3000; // start.sh'ın hazırlık yoklaması da bu portu bekler
const OTP_PORT = Number(process.env.OTP_PORT) || 8080;

module.exports = {
  PORT,
  OTP_PORT,

  // OTP'nin GraphQL ucu. Aynı konteynerde yaşadıkları için localhost.
  OTP_URL: `http://localhost:${OTP_PORT}/otp/gtfs/v1`,

  // Dış veri kaynakları
  IZELMAN_PARK_URL: "https://openapi.izmir.bel.tr/api/ibb/izum/otoparklar",
  PHOTON_URL:       "https://photon.komoot.io/api/",
  NOMINATIM_URL:    "https://nominatim.openstreetmap.org/search",

  // Nominatim kullanım şartları tanımlayıcı bir User-Agent ister.
  USER_AGENT: "IzmirUlasimBackend/1.0",

  // ─── Süreler (ms) ────────────────────────────────────────────────────
  TTL: {
    // İZELMAN doluluk verisi anlıktır; 1 dakika hem tazeliği korur hem
    // OTP'nin dakikada bir çeken updater'ını kaynağa yüklemez.
    PARKING: 60 * 1000,
    // İstasyon/otopark KONUMLARI nadiren değişir — doluluk değil, konum.
    OVERPASS: 24 * 60 * 60 * 1000,
    // Aynı harfleri yazan kullanıcılar aynı sorguyu tekrarlar.
    GEOCODE: 5 * 60 * 1000,
  },

  // Tüm Overpass mirror'ları düştüğünde her istekte üçünü birden denemek,
  // her isteğe timeout kadar gecikme ekler. Bu süre boyunca stale cache verilir.
  OVERPASS_BACKOFF: 6 * 60 * 60 * 1000,

  TIMEOUT: {
    IZELMAN:  8000,
    OVERPASS: 8000,
    // way + `out center` sorgusu düğüm sorgusundan belirgin yavaş.
    OVERPASS_AGIR: 15000,
    GEOCODE:  6000,
    // OTP plan sorgusu en uzun süren çağrı; istemci tarafı 25 sn bekler.
    OTP_PLAN: 15000,
    OTP_SORGU: 10000,
    // Sağlık ucu yavaş olursa izleme aracı zaman aşımını "servis öldü" diye
    // raporlar — bu yüzden kısa.
    OTP_SAGLIK: 3000,
  },
};
