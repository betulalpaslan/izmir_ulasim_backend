const axios = require("axios");
const config = require("../config");
const stopIndex = require("./StopIndexService");

// ─── Adres araması ─────────────────────────────────────────────────────
// Photon önce, Nominatim yedek. İkisi de OSM verisi kullanır ama Photon
// yazarken arama (autocomplete) için tasarlanmıştır ve hız sınırı gevşektir;
// Nominatim resmi kullanım şartlarında saniyede 1 istek ister — bu yüzden
// yalnızca Photon boş dönerse çağrılır.
//
// Uygulama bu iki servisi doğrudan çağırıyordu. Nominatim'in hız sınırı
// IP başınadır: taşınmadan önce sınır her kullanıcının cihazına ayrı
// uygulanıyordu, taşındıktan sonra tek IP'ye — bu yüzden burada sıralı
// çağrı ve kısa cache önemli.

// DİKKAT — kutu sırası Overpass'takinden FARKLI.
//   Overpass:          güney,batı,kuzey,doğu  → 38.2,26.8,38.6,27.5
//   Photon/Nominatim:  batı,güney,doğu,kuzey  → 26.5,38.2,27.5,38.7
// Aynı şehir, iki ayrı konvansiyon. Kutu da biraz geniştir: adres araması
// il sınırının hemen dışındaki yerleşimleri de bulabilmeli.
const GEOCODE_BBOX = { bati: 26.5, guney: 38.2, dogu: 27.5, kuzey: 38.7 };
const MERKEZ = { lat: 38.42, lon: 27.14 }; // sonuçları İzmir'e yakınlığa göre önceler

// Kaç sonuç istenir. 4 çok azdı: tekrarlar (aynı yerin istasyon/durak/bina
// kayıtları) elendikten sonra elde 1-2 satır kalıyordu.
const LIMIT = 8;
const MIN_UZUNLUK = 2; // "ko" → Konak. 3 harf şartı bunu engelliyordu.

const CACHE_TTL = config.TTL.GEOCODE;
const CACHE_MAX = 200;
const cache = new Map();

function cacheOku(anahtar) {
  const kayit = cache.get(anahtar);
  if (!kayit) return null;
  if (Date.now() - kayit.zaman > CACHE_TTL) {
    cache.delete(anahtar);
    return null;
  }
  return kayit.sonuc;
}

function cacheYaz(anahtar, sonuc) {
  // En eski kaydı at — Map ekleme sırasını korur.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(anahtar, { zaman: Date.now(), sonuc });
}

// DİKKAT: lang parametresi GÖNDERİLMEZ. Photon yalnızca default/de/en/fr
// destekler; "lang=tr" 400 döndürür. Uygulama tam olarak bunu yapıyordu, yani
// Photon hiç çalışmıyor ve HER arama sessizce Nominatim'e düşüyordu —
// "Photon önce, Nominatim yedek" tasarımı kâğıt üzerinde kalmıştı.
// Parametresiz hâli OSM'nin name etiketini kullanır: Türkiye'de zaten Türkçe.
// ─── Türkçe karakter normalizasyonu ───────────────────────────────────
// Photon'un indeksi ASCII'ye katlanmış: "güzel" HİÇBİR sonuç döndürmezken
// "guzel" Güzelbahçe, Güzelyalı, Güzelyurt'u bulur. Türkçe klavyeyle yazan
// kullanıcı bu yüzden boş liste görüyordu — aramanın en görünür kusuru buydu.
// Sorgu ASCII'ye çevrilir; DÖNEN isimler Türkçe kalır, onlara dokunulmaz.
const TR_ASCII = { ç: "c", Ç: "C", ğ: "g", Ğ: "G", ı: "i", İ: "I", ö: "o", Ö: "O", ş: "s", Ş: "S", ü: "u", Ü: "U" };

function asciiye(text) {
  return String(text).replace(/[çÇğĞıİöÖşŞüÜ]/g, (h) => TR_ASCII[h]);
}

// Sonuç türüne göre öncelik. Photon kendi "importance" sırasını verir ama
// arama kutusunda bir yer adı ararken önce YERLEŞİM beklenir: "als" yazan
// kullanıcı Alsancak semtini arıyordur, Alsancak Gar'ın çatı poligonunu değil.
//
// Bu tablo artık YEDEK ölçüttür. Asıl sıralama ulaşım çevresine bakar
// (StopIndexService): bir ulaşım uygulamasında noktanın değeri, çevresindeki
// durak yoğunluğudur — tür etiketi bunun dolaylı ve hatalı bir tahminiydi.
// Tür önceliği yalnızca durak indeksi hazır değilken (OTP kapalıyken) kullanılır.
const TUR_ONCELIGI = { city: 0, district: 1, locality: 2, county: 3, street: 5, house: 6, other: 7 };

function turSirasi(ozellik) {
  return TUR_ONCELIGI[ozellik?.type] ?? 4;
}

async function fetchPhoton(text) {
  const url =
    `${config.PHOTON_URL}?q=${encodeURIComponent(asciiye(text))}&limit=${LIMIT}` +
    `&lat=${MERKEZ.lat}&lon=${MERKEZ.lon}` +
    `&bbox=${GEOCODE_BBOX.bati},${GEOCODE_BBOX.guney},${GEOCODE_BBOX.dogu},${GEOCODE_BBOX.kuzey}`;
  const res = await axios.get(url, { timeout: config.TIMEOUT.GEOCODE, headers: { "User-Agent": config.USER_AGENT } });
  return (res.data?.features || [])
    .map((f, i) => {
      const p = f.properties || {};
      const isimParcalari  = [p.name, p.street, p.housenumber].filter(Boolean);
      const detayParcalari = [p.district || p.county, p.city || p.state].filter(Boolean);
      return {
        place_id: `ph_${p.osm_id || i}`,
        lat: String(f.geometry.coordinates[1]),
        lon: String(f.geometry.coordinates[0]),
        display_name: [...isimParcalari, ...detayParcalari].join(", "),
        _sira: turSirasi(p),
      };
    })
    // Sıralama: önce ULAŞIM ÇEVRESİ (en yakın durak + yakındaki durak sayısı),
    // indeks hazır değilse tür önceliği. Ölçülen örnek — "Karşıyaka":
    //   ilçe sınırı centroid'i  en yakın durak 188 m, 300 m içinde  2 durak
    //   sahildeki merkez        en yakın durak  59 m, 300 m içinde 10 durak
    // Kullanıcı ilkini seçtiğinde dağlık bir noktaya yönleniyor ve rota çıkmıyordu.
    .map((r) => {
      const skor = stopIndex.yakinlikSkoru(parseFloat(r.lat), parseFloat(r.lon));
      return { ...r, _skor: skor };
    })
    .sort((a, b) => {
      const ikisiDeOlculdu = a._skor != null && b._skor != null;
      if (ikisiDeOlculdu && Math.abs(a._skor - b._skor) > 0.01) return a._skor - b._skor;
      return a._sira - b._sira;   // ölçülemeyenlerde ve beraberlikte tür önceliği
    })
    .map(({ _sira, _skor, ...r }) => r);
}

async function fetchNominatim(text) {
  const url =
    `${config.NOMINATIM_URL}?q=${encodeURIComponent(text)}&format=json&limit=${LIMIT}` +
    `&viewbox=${GEOCODE_BBOX.bati},${GEOCODE_BBOX.guney},${GEOCODE_BBOX.dogu},${GEOCODE_BBOX.kuzey}` +
    `&accept-language=tr`;
  const res = await axios.get(url, { timeout: config.TIMEOUT.GEOCODE, headers: { "User-Agent": config.USER_AGENT } });
  return (res.data || []).map((item) => ({
    place_id: `nm_${item.place_id}`,
    lat: item.lat,
    lon: item.lon,
    display_name: item.display_name,
  }));
}

// Aynı yer OSM'de birden çok kayıtla durur: "Alsancak Gar" hem railway=station,
// hem tram_stop, hem building=roof olarak gelir ve listeyi doldurur. ~200 m
// yakınlıktaki kayıtlar tek sonuç sayılır — ilk gelen (en öncelikli tür) kalır.
function tekrarlariEle(sonuclar) {
  const gorulen = [];
  return sonuclar.filter((r) => {
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    const cokYakin = gorulen.some((s) => Math.abs(s.lat - lat) < 0.002 && Math.abs(s.lon - lon) < 0.002);
    if (!cokYakin) gorulen.push({ lat, lon });
    return !cokYakin;
  });
}

async function searchAddress(text) {
  const sorgu = String(text || "").trim();
  if (sorgu.length < MIN_UZUNLUK) return [];

  const anahtar = sorgu.toLocaleLowerCase("tr");
  const onbellek = cacheOku(anahtar);
  if (onbellek) return onbellek;

  // Durak indeksi ilk aramada kurulur, sonra bellekte kalır. Hazır değilse
  // sıralama tür önceliğine düşer — arama yine çalışır.
  await stopIndex.yukle();

  let sonuc = [];
  try {
    sonuc = await fetchPhoton(sorgu);
  } catch (err) {
    console.warn("Geocoding: Photon başarısız:", err.message);
  }

  if (sonuc.length === 0) {
    try {
      sonuc = await fetchNominatim(sorgu);
    } catch (err) {
      console.warn("Geocoding: Nominatim de başarısız:", err.message);
      // İkisi de düştüyse hatayı yut ve boş liste dön: adres araması
      // çalışmasa bile kullanıcı haritadan nokta seçerek rota kurabilir.
    }
  }

  const temiz = tekrarlariEle(sonuc).slice(0, 6);
  cacheYaz(anahtar, temiz);
  return temiz;
}

module.exports = { searchAddress, fetchPhoton, fetchNominatim, asciiye, tekrarlariEle, GEOCODE_BBOX, MERKEZ, MIN_UZUNLUK, LIMIT };
