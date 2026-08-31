const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const config = require("../config");
const axios = require("axios");
const bolgeService = require("../services/BisimBolgeService");


// Bölgede yuva yoktur; bu değer yalnız OTP'nin "kullanılabilir" saymasını
// sağlamak için gönderilen nominal bir sayıdır, gerçek bir ölçüm değildir.
const BOLGE_NOMINAL_KAPASITE = 20;

const router = express.Router();

// Kullanıcıya dönük uç: bisikletin bırakılabileceği bölgeler.
// Eskiden istasyon listesiydi; BİSİM 2025-08'de sabit istasyonları kaldırdı.
router.get(["/stations", "/bolgeler"], (req, res) => {
  res.json({
    model: "bolge",
    bolgeler: bolgeService.birakmaNoktalari(),
    updatedAt: new Date().toISOString(),
  });
});

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
          { name: "system_information",  url: `${base}/gbfs/system_information` },
          { name: "station_information", url: `${base}/gbfs/station_information` },
          { name: "station_status",      url: `${base}/gbfs/station_status` },
          { name: "vehicle_types",       url: `${base}/gbfs/vehicle_types` },
          { name: "free_bike_status",    url: `${base}/gbfs/free_bike_status` },
          { name: "geofencing_zones",    url: `${base}/gbfs/geofencing_zones` },
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

// Bölgeler OTP'ye istasyon olarak sunulur: OTP'nin rotalama modeli bir
// alma/bırakma NOKTASI bekler, bölgenin merkezi o noktadır. Alanı ise
// geofencing_zones ile verilir.
router.get("/gbfs/station_information", (req, res) => {
  const stations = bolgeService.birakmaNoktalari().map((b) => ({
    station_id: b.id,
    name:       b.ad,
    lat:        b.lat,
    lon:        b.lon,
    // Bölgede yuva yoktur; kapasite kavramı da yoktur. Ama OTP alanı
    // olmayan istasyonu kullanılamaz sayıyor (ölçüldü), bu yüzden nominal
    // bir değer gönderilir. Kullanıcıya dönük /bisim/stations bu alanı
    // içermez — uydurma sayı ekranda görünmez.
    capacity:   BOLGE_NOMINAL_KAPASITE,
  }));
  res.json({ last_updated: Math.floor(Date.now() / 1000), ttl: 3600, version: "2.3", data: { stations } });
});

router.get("/gbfs/station_status", (req, res) => {
  // Bölge modelinde "doluluk" yoktur: bisiklet serbest dolaşır, bölge yalnız
  // bırakmaya izin verilen alandır. Dolayısıyla eskisi gibi canlı veri
  // beklemeye gerek yok — bölgenin açık olması işletmecinin tanımıdır.
  //
  // Eski model burada is_renting:false gönderiyordu (canlı doluluk yok diye).
  // Sonucu ölçüldü: OTP'deki 52 istasyonun tamamı allowPickupNow:false idi,
  // yani hiçbir rotada bisiklet çıkmıyordu.
  const stations = bolgeService.birakmaNoktalari().map((b) => ({
    station_id:          b.id,
    num_bikes_available: BOLGE_NOMINAL_KAPASITE,
    num_docks_available: BOLGE_NOMINAL_KAPASITE,
    is_installed:        true,
    is_renting:          true,
    is_returning:        true,
    last_reported:       Math.floor(Date.now() / 1000),
  }));
  res.json({ last_updated: Math.floor(Date.now() / 1000), ttl: 60, version: "2.3", data: { stations } });
});

// Araç türü. İKİ işi var:
//
//  1. AD. Bu feed olmadan OTP serbest araçlara kendi yer tutucusunu veriyor
//     ve rota kartında bacak "Default vehicle type" diye görünüyordu.
//  2. return_constraint: "free_floating" — dockless kuralın GBFS'teki
//     açık beyanı. Bırakma serbestliği geofencing bölgesinden de çıkıyor,
//     ama iki kaynak birbirini doğruluyor; biri kaybolursa diğeri tutar.
const ARAC_TURU = "bisim-bisiklet";

router.get("/gbfs/vehicle_types", (req, res) => {
  res.json({
    last_updated: Math.floor(Date.now() / 1000),
    ttl: 3600,
    version: "2.3",
    data: {
      vehicle_types: [{
        vehicle_type_id:   ARAC_TURU,
        form_factor:       "bicycle",
        propulsion_type:   "human",
        name:              "BİSİM bisikleti",
        return_constraint: "free_floating",
      }],
    },
  });
});

// Serbest dolaşan bisikletler. BİSİM'in gerçek modeli budur: bisiklet
// istasyona bağlı değil, hizmet alanı içinde her yere bırakılır.
//
// Bu uç OLMADAN OTP ağı istasyonlu sanıyor ve kiralamayı ancak bir
// istasyonda bitirebiliyordu. Ölçüm — Konak İskele → Alsancak Garı:
//   BİSİKLET 12 dk (Konak İskele → Alsancak Kordon) + YÜRÜME 17 dk / 1294 m
// Yani bisiklet en yakın istasyona bırakılıp kalan 1.3 km yürünüyordu.
//
// Konumların nereden geldiği ve neyin varsayım olduğu
// BisimBolgeService.serbestBisikletler'de yazılı — özeti: canlı bisiklet
// konumu yayınlanmıyor, noktalar GERÇEK bisiklet yolu geometrisi üzerinde
// 400 m'de bir örnekleniyor. Bu yüzden kullanıcıya gösterilmezler.
router.get("/gbfs/free_bike_status", (req, res) => {
  const simdi = Math.floor(Date.now() / 1000);
  res.json({
    last_updated: simdi,
    ttl: 60,
    version: "2.3",
    data: {
      bikes: bolgeService.serbestBisikletler().map((b) => ({
        bike_id:         b.bike_id,
        lat:             b.lat,
        lon:             b.lon,
        vehicle_type_id: ARAC_TURU,
        // OTP her ikisini de okur; true olan araç rotalamaya girmez.
        is_reserved:   false,
        is_disabled:   false,
        last_reported: simdi,
      })),
    },
  });
});

router.get("/gbfs/geofencing_zones", (req, res) => {
  res.json({
    last_updated: Math.floor(Date.now() / 1000),
    // ttl'i OTP birebir uyguluyor: 3600 verildiğinde bölge değişikliği bir
    // saat boyunca alınmıyordu. Bölgeler seyrek değişse de bu kadar uzun
    // körlük istenmez.
    ttl: 300,
    version: "2.3",
    data: { geofencing_zones: bolgeService.geofencingZones() },
  });
});

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
    const response = await axios.post(config.OTP_URL, { query }, { timeout: config.TIMEOUT.OTP_SORGU });
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
    const response = await axios.post(config.OTP_URL, { query, variables: { dateTime: new Date().toISOString(), modes } }, { timeout: config.TIMEOUT.OTP_PLAN });
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
    const response = await axios.post(config.OTP_URL, { query }, { timeout: config.TIMEOUT.OTP_SORGU });
    res.json({
      fields: response.data?.data?.__type?.inputFields || [],
      errors: response.data?.errors || null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

module.exports = router;
