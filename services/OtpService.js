const axios = require("axios");

const config = require("../config");

function safeFloat(x) {
  const n = Number.parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

function buildTransitPreferences(modes) {
  const selected = new Set(Array.isArray(modes) ? modes : []);
  if (selected.size === 0) {
    return [{ mode: "BUS" }, { mode: "RAIL" }, { mode: "TRAM" }, { mode: "SUBWAY" }];
  }
  const out = [];
  if (selected.has("BUS"))   out.push({ mode: "BUS" });
  if (selected.has("TRAM"))  out.push({ mode: "TRAM" });
  if (selected.has("RAIL"))  { out.push({ mode: "RAIL" }); out.push({ mode: "SUBWAY" }); }
  if (out.length === 0) return [{ mode: "BUS" }, { mode: "RAIL" }, { mode: "TRAM" }, { mode: "SUBWAY" }];
  return out;
}

function buildModesInput(profile, bikeType, transitPrefs) {
  if (profile === "bicycle") {
    if (bikeType === "RENT") {
      // WALK, BICYCLE_RENTAL'ın yanında ZORUNLU. Kaldırmayı denemek OTP'den
      // şu hatayı aldı ve mod hiç sonuç döndürmedi:
      //   "For the time being, BIKE_RENTAL needs to be combined with WALK
      //    mode for the same leg."
      // Kiralık bisiklete yürüyerek gidilip yürüyerek bırakıldığı için OTP
      // ikisini tek bacak sayıyor. Bunun bedeli, bisiklet İÇERMEYEN
      // güzergâhların da dönmesi; onları uygulama katmanı eliyor
      // (hooks/useRouteSearch.js, profileKey === "bicycle_rent" süzgeci).
      return {
        transit: { access: ["BICYCLE_RENTAL", "WALK"], egress: ["BICYCLE_RENTAL", "WALK"], transfer: ["WALK"], transit: transitPrefs }
      };
    }
    // Bisikleti istasyonda bırak, yürüyerek devam et.
    // bikeType null gelirse bu dal çalışır: eski bir istemci "kendi
    // bisikletim" derken kaldırılmış olan doğrudan sürüş modunu
    // kastediyordu; ona boş yanıt yerine aktarmalı karşılığı verilir.
    return {
      transit: { access: ["BICYCLE_PARKING"], egress: ["WALK"], transfer: ["WALK"], transit: transitPrefs }
    };
  }
  if (profile === "car") {
    return { direct: ["CAR"] };
  }
  if (profile === "park_and_ride") {
    return {
      transit: { access: ["CAR_PARKING"], egress: ["WALK"], transfer: ["WALK"], transit: transitPrefs }
    };
  }
  return {
    transit: { access: ["WALK"], egress: ["WALK"], transfer: ["WALK"], transit: transitPrefs }
  };
}

// Kendi bisikletiyle iki AYRI güzergâh tipi mümkün ve OTP bunları tek
// sorguda kabul etmiyor:
//   BICYCLE:bisikleti YANINA AL, transite onunla bin
//   BICYCLE_PARKING:bisikleti istasyonda bırak, yürüyerek devam et
// İkisini aynı erişim listesine koymak denendi, OTP reddediyor:
//   "Bicycle can't be combined with other modes for the same leg:
//    [BIKE, BIKE_TO_PARK]"
// Bu yüzden iki sorgu atılır ve sonuçlar birleştirilir; hangisi daha iyiyse
// puanlama katmanı öne alır (izmir_ulasim/utils/routeScoring.js).

// Bisikletle transite binmek İzmir'de mümkün: metro, tramvay ve
// İZBAN bisiklet taşımaya izin veriyor. OTP bunu YALNIZ GTFS'te
// trips.bikes_allowed=1 olan seferlerde üretir; feed'de o alan operatöre
// göre değiştirildi (tools/gtfs-bisiklet-değisikligi.js). değişiklik uygulanmadan
// derlenmiş bir graph'ta bu sorgu sessizce boş döner — hata verilmez,
// seçenek hiç üretilmez.
// Kaynaklar ve ölçüm: docs/API.md, "GTFS bisiklet taşıma  değişikliği".
function buildModesInputs(profile, bikeType, transitPrefs) {
  if (profile === "bicycle" && bikeType !== "RENT") {
    return [
      // Bisiklet yanında: inerken ve aktarmada da yanında olacak.
      { transit: { access: ["BICYCLE"], egress: ["BICYCLE"], transfer: ["BICYCLE"], transit: transitPrefs } },
      buildModesInput(profile, bikeType, transitPrefs),
    ];
  }
  return [buildModesInput(profile, bikeType, transitPrefs)];
}

async function planRoute({ fromLat, fromLon, toLat, toLon, profile, modes, bikeType, numItineraries, dateTime: requestedDateTime }) {
  const first = Number.isInteger(numItineraries) ? numItineraries : 10;
  const parsed = requestedDateTime ? new Date(requestedDateTime) : null;
  const dateTime =
    parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
  const transitPrefs = buildTransitPreferences(modes);
  const modesInputs = buildModesInputs(profile, bikeType, transitPrefs);

  // OTP 2.8: CoordinateValue can't be passed as a variable — must be inlined
  const query = `
    query Plan(
      $dateTime: OffsetDateTime!,
      $first: Int!,
      $modes: PlanModesInput
    ) {
      planConnection(
        # Etiketler KULLANICIYA GÖRÜNÜR. OTP bunları yolculuğun ilk ve son
        # bacağının uç noktası adı olarak geri döndürür; "from"/"to" yazınca
        # rota kartında "from → Asmaaltı" gibi satırlar çıkıyordu.
        origin: {
          label: "Başlangıç"
          location: { coordinate: { latitude: ${fromLat}, longitude: ${fromLon} } }
        }
        destination: {
          label: "Varış"
          location: { coordinate: { latitude: ${toLat}, longitude: ${toLon} } }
        }
        dateTime: { earliestDeparture: $dateTime }
        first: $first
        modes: $modes
      ) {
        edges {
          node {
            legs {
              mode
              duration
              distance
              from { name lat lon stop { gtfsId } vehicleRentalStation { stationId } rentalVehicle { vehicleId } }
              to   { name lat lon stop { gtfsId } vehicleRentalStation { stationId } rentalVehicle { vehicleId } }
              route { shortName longName }
              legGeometry { points }
            }
          }
        }
        routingErrors { code description }
      }
    }
  `;

  async function sorgula(girdi) {
    const response = await axios.post(
      config.OTP_URL,
      { query, variables: { dateTime, first, modes: girdi } },
      { timeout: config.TIMEOUT.OTP_PLAN }
    );
    if (response.data?.errors?.length) {
      const err = new Error("OTP GraphQL hatası");
      err.otpErrors = response.data.errors;
      throw err;
    }
    const conn = response.data?.data?.planConnection;
    const hatalar = conn?.routingErrors || [];
    if (hatalar.length) console.warn("OTP routingErrors:", hatalar);
    const liste = (conn?.edges || []).map((e) => e.node).filter(Boolean).map((node) => ({
      ...node,
      legs: node.legs.map((leg) => {
        // OTP kiralık bisikleti de "BICYCLE" diye bildirir; kiralık olduğu
        // yalnız bacağın uçlarındaki araç/istasyon alanından anlaşılır.
  
        // İKİ ALAN DA BAKILMALI. BİSİM dockless modele geçince (bkz.
        // BisimBolgeService.serbestBisikletler) istasyon değil SERBEST ARAÇ
        // döndürülüyor ve o durumda `vehicleRentalStation` NULL geliyor,
        // araç `rentalVehicle` alanında. Yalnız istasyona bakıldığında
        // etiketleme sessizce başarısız oluyordu: bacak "BICYCLE" kalıyor,
        // uygulamanın BİSİM süzgeci (mode === "BICYCLE_RENTAL") hepsini
        // eliyor ve mod yine boş görünüyordu.
        const kiralik = (u) => u?.vehicleRentalStation || u?.rentalVehicle;
        if (leg.mode === "BICYCLE" && (kiralik(leg.from) || kiralik(leg.to))) {
          return { ...leg, mode: "BICYCLE_RENTAL" };
        }
        return leg;
      }),
    }));
    return { liste, hatalar };
  }

  // Aynı güzergâh iki sorgudan da dönebilir (ör. bisiklet hiç kullanılmayan
  // düz transit rotası). İmza mod dizisi + hat + süre.
  const imza = (it) => it.legs
    .map((l) => `${l.mode}:${l.route?.shortName || ""}:${Math.round((l.duration || 0) / 60)}`)
    .join(">");

  console.log("modesInputs:", JSON.stringify(modesInputs));

  // Sorgulardan biri düşerse diğerinin sonucu yine gösterilir; ikisi de
  // düşerse hata yukarı taşınır. Tek sorgu düştüğünde tüm isteği başarısız
  // saymak, çalışan seçeneği de kaybetmek olurdu.
  const sonuclar = await Promise.allSettled(modesInputs.map(sorgula));
  const basarili = sonuclar.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!basarili.length) throw sonuclar[0].reason;
  for (const r of sonuclar) {
    if (r.status === "rejected") console.warn("Bisiklet sorgularından biri düştü:", r.reason?.message);
  }

  const gorulen = new Set();
  let itineraries = basarili.flatMap((x) => x.liste).filter((it) => {
    const k = imza(it);
    if (gorulen.has(k)) return false;
    gorulen.add(k);
    return true;
  });
  let routingErrors = basarili.flatMap((x) => x.hatalar);

  let bisikletsizEnIyiSn = null;
  if (profile === "bicycle") {
    try {
      const taban = await sorgula({
        transit: { access: ["WALK"], egress: ["WALK"], transfer: ["WALK"], transit: transitPrefs },
      });
      const sureler = taban.liste.map((it) =>
        it.legs.reduce((t, l) => t + (l.duration || 0), 0));
      if (sureler.length) bisikletsizEnIyiSn = Math.min(...sureler);
    } catch (err) {
      console.warn("Bisikletsiz taban çizgisi alınamadı:", err.message);
    }
  }
  if (bisikletsizEnIyiSn != null) {
    itineraries = itineraries.map((it) => ({ ...it, bisikletsizEnIyiSn }));
  }

  return { itineraries, routingErrors, profile, bisikletsizEnIyiSn };
}

module.exports = {
  safeFloat,
  planRoute,
  buildModesInputs,
  // Saf yardımcılar — dışa açılmalarının tek sebebi test edilebilirlik.
  buildTransitPreferences,
  buildModesInput,
};
