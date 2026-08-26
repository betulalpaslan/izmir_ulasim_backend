const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const axios = require("axios");
const { fetchBisim, getRawStations, mapToStation } = require("../services/BikeShareService");

const OTP_PORT = process.env.OTP_PORT || 8080;
const OTP_URL = `http://localhost:${OTP_PORT}/otp/gtfs/v1`;

const router = express.Router();

router.get("/stations", asyncHandler(async (req, res) => {
  try {
    const data = await fetchBisim();
    const stations = getRawStations(data).map(mapToStation);
    res.json({ stations, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("BİSİM fetch hatası:", err.message);
    res.status(502).json({ error: "BİSİM istasyon verisi alınamıyor." });
  }
}));

router.get(["/gbfs", "/gbfs.json"], (req, res) => {
  const proto = req.get("x-forwarded-proto") || req.protocol;
  const base = `${proto}://${req.get("host")}/bisim`;
  res.json({
    last_updated: Math.floor(Date.now() / 1000),
    ttl: 60,
    version: "2.3",
    data: {
      en: {
        feeds: [
          { name: "system_information", url: `${base}/gbfs/system_information` },
          { name: "station_information", url: `${base}/gbfs/station_information` },
          { name: "station_status",      url: `${base}/gbfs/station_status` },
        ],
      },
    },
  });
});

router.get("/gbfs/system_information", (req, res) => {
  res.json({
    last_updated: Math.floor(Date.now() / 1000),
    ttl: 3600,
    version: "2.3",
    data: {
      system_id:  "bisim-izmir",
      language:   "tr",
      name:       "BİSİM - İzmir Bisiklet Paylaşım Sistemi",
      short_name: "BİSİM",
      operator:   "İZULAŞ A.Ş.",
      timezone:   "Europe/Istanbul",
      url:        "https://www.izmir.bel.tr",
    },
  });
});

router.get("/gbfs/station_information", asyncHandler(async (req, res) => {
  try {
    const data = await fetchBisim();
    // Kapasite mapToStation tarafından zenginleştirilir (OSM etiketi +
    // 2025-07 anlık görüntüsü). Bilinmiyorsa alan hiç gönderilmez —
    // GBFS'te capacity isteğe bağlıdır ve uydurma "10" yazmak yanıltıcıdır.
    const stations = getRawStations(data).map(mapToStation).map((st) => {
      const out = {
        station_id: String(st.id),
        name:       st.name,
        lat:        st.lat,
        lon:        st.lon,
      };
      if (st.capacity) out.capacity = st.capacity;
      return out;
    });
    console.log(`GBFS station_information: ${stations.length} istasyon gönderildi`);
    res.json({ last_updated: Math.floor(Date.now() / 1000), ttl: 3600, version: "2.3", data: { stations } });
  } catch {
    res.status(502).json({ error: "BİSİM istasyon verisi alınamıyor." });
  }
}));

router.get("/gbfs/station_status", asyncHandler(async (req, res) => {
  try {
    const data = await fetchBisim();
    // BİSİM'in gerçek zamanlı verisi 2025-07-23'ten beri hiçbir kaynakta
    // yayınlanmıyor (belediye API'si yanıt vermiyor, açık veri portalından
    // kaldırıldı, BİSİM'in kendi harita servisi kapalı).
    //
    // is_renting/is_returning bilerek false bırakılmıştır: true yazmak OTP'ye
    // "bu istasyondan bisiklet alınabilir" demek olur ve kullanıcı elinde
    // olmayan bir bisiklete göre planlanmış rota görür. Doluluk uydurmak
    // yerine kiralama rotası üretilmemesi tercih edilmiştir.
    // Canlı kaynak yeniden yayına girerse burası gerçek sayılarla doldurulur.
    const stations = getRawStations(data).map((e) => ({
      station_id:          String(e.id),
      num_bikes_available: 0,
      num_docks_available: 0,
      is_installed:        true,
      is_renting:          false,
      is_returning:        false,
      last_reported:       Math.floor(Date.now() / 1000),
    }));
    res.json({ last_updated: Math.floor(Date.now() / 1000), ttl: 60, version: "2.3", data: { stations } });
  } catch {
    res.status(502).json({ error: "BİSİM istasyon verisi alınamıyor." });
  }
}));

// OTP'nin BİSİM istasyonlarını yükleyip yüklemediğini kontrol eder
router.get("/otp-check", asyncHandler(async (req, res) => {
  const query = `{
    vehicleRentalStations {
      stationId
      name
      lat
      lon
      allowPickupNow
      allowDropoffNow
      rentalNetwork { networkId }
    }
  }`;
  try {
    const response = await axios.post(OTP_URL, { query }, { timeout: 8000 });
    const stations = response.data?.data?.vehicleRentalStations || [];
    res.json({
      count: stations.length,
      sample: stations.slice(0, 3),
      errors: response.data?.errors || null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// BICYCLE_RENTAL testi — OtpService ile aynı değişken formatı kullanır (inline enum'dan kaçınır)
router.get("/otp-rental-test", asyncHandler(async (req, res) => {
  // Konak Metro BİSİM (38.416539, 27.127547) → Alsancak Garı BİSİM (38.4399489, 27.147847)
  const query = `
    query Plan($dateTime: OffsetDateTime!, $modes: PlanModesInput) {
      planConnection(
        origin: { label: "from", location: { coordinate: { latitude: 38.416539, longitude: 27.127547 } } }
        destination: { label: "to", location: { coordinate: { latitude: 38.4399489, longitude: 27.147847 } } }
        dateTime: { earliestDeparture: $dateTime }
        first: 5
        modes: $modes
      ) {
        edges { node { legs { mode from { name lat lon } to { name lat lon } duration } } }
        routingErrors { code description }
      }
    }
  `;
  const modes = {
    direct: ["BICYCLE_RENTAL", "WALK"],
    transit: { access: ["BICYCLE_RENTAL", "WALK"], egress: ["BICYCLE_RENTAL", "WALK"], transfer: ["WALK"], transit: [{ mode: "BUS" }, { mode: "TRAM" }] }
  };
  try {
    const response = await axios.post(OTP_URL, { query, variables: { dateTime: new Date().toISOString(), modes } }, { timeout: 15000 });
    const conn = response.data?.data?.planConnection;
    res.json({
      itineraryCount: conn?.edges?.length || 0,
      modes: (conn?.edges || []).map((e) => e.node.legs.map((l) => l.mode)),
      legs: (conn?.edges || []).slice(0, 2).map((e) => e.node.legs),
      routingErrors: conn?.routingErrors || [],
      graphqlErrors: response.data?.errors || null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// PlanPreferencesInput içindeki alanları göster
router.get("/otp-schema", asyncHandler(async (req, res) => {
  const query = `{
    __type(name: "PlanPreferencesInput") {
      inputFields {
        name
        type { name kind ofType { name kind inputFields { name } } }
      }
    }
  }`;
  try {
    const response = await axios.post(OTP_URL, { query }, { timeout: 8000 });
    res.json({
      fields: response.data?.data?.__type?.inputFields || [],
      errors: response.data?.errors || null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

module.exports = router;
