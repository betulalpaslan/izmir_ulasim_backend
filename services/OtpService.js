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
  if (selected.has("FERRY")) out.push({ mode: "FERRY" });
  if (out.length === 0) return [{ mode: "BUS" }, { mode: "RAIL" }, { mode: "TRAM" }, { mode: "SUBWAY" }];
  return out;
}

function buildModesInput(profile, bikeType, transitPrefs) {
  if (profile === "bicycle") {
    if (bikeType === "PARK") {
      return {
        transit: { access: ["BICYCLE_PARKING"], egress: ["WALK"], transfer: ["WALK"], transit: transitPrefs }
      };
    }
    if (bikeType === "RENT") {
      return {
        direct: ["BICYCLE_RENTAL", "WALK"],
        transit: { access: ["BICYCLE_RENTAL", "WALK"], egress: ["BICYCLE_RENTAL", "WALK"], transfer: ["WALK"], transit: transitPrefs }
      };
    }
    return {
      direct: ["BICYCLE"],
      transit: { access: ["WALK"], egress: ["WALK"], transfer: ["WALK"], transit: transitPrefs }
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

async function planRoute({ fromLat, fromLon, toLat, toLon, profile, modes, bikeType, numItineraries, dateTime: requestedDateTime }) {
  const first = Number.isInteger(numItineraries) ? numItineraries : 10;
  // İsteğe bağlı kalkış zamanı. Verilmezse "şimdi".
  // İleri tarihli sorgu, GTFS takvim penceresinin ne zaman bittiğini
  // ölçmeye de yarar: takvim dışı bir gün için sefer dönmez.
  const parsed = requestedDateTime ? new Date(requestedDateTime) : null;
  const dateTime =
    parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
  const transitPrefs = buildTransitPreferences(modes);
  const modesInput = buildModesInput(profile, bikeType, transitPrefs);

  // OTP 2.8: CoordinateValue can't be passed as a variable — must be inlined
  const query = `
    query Plan(
      $dateTime: OffsetDateTime!,
      $first: Int!,
      $modes: PlanModesInput
    ) {
      planConnection(
        origin: {
          label: "from"
          location: { coordinate: { latitude: ${fromLat}, longitude: ${fromLon} } }
        }
        destination: {
          label: "to"
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
              from { name lat lon stop { gtfsId } vehicleRentalStation { stationId } }
              to   { name lat lon stop { gtfsId } vehicleRentalStation { stationId } }
              route { shortName longName }
              legGeometry { points }
            }
          }
        }
        routingErrors { code description }
      }
    }
  `;

  console.log("modesInput:", JSON.stringify(modesInput, null, 2));

  const response = await axios.post(
    config.OTP_URL,
    { query, variables: { dateTime, first, modes: modesInput } },
    { timeout: config.TIMEOUT.OTP_PLAN }
  );

  if (response.data?.errors?.length) {
    const err = new Error("OTP GraphQL hatası");
    err.otpErrors = response.data.errors;
    throw err;
  }

  const conn = response.data?.data?.planConnection;
  const routingErrors = conn?.routingErrors || [];
  if (routingErrors.length) console.warn("OTP routingErrors:", routingErrors);

  const itineraries = (conn?.edges || []).map((e) => e.node).filter(Boolean).map((node) => ({
    ...node,
    legs: node.legs.map((leg) => {
      if (
        leg.mode === "BICYCLE" &&
        (leg.from?.vehicleRentalStation || leg.to?.vehicleRentalStation)
      ) {
        return { ...leg, mode: "BICYCLE_RENTAL" };
      }
      return leg;
    }),
  }));

  // Sıralama BİLEREK burada yapılmıyor. Güzergâhlar OTP'nin verdiği sırayla
  // döner; puanlama, eleme ve etiketleme uygulamadaki rankItineraries +
  // selectCandidates işidir (utils/routeScoring.js).
  //
  // Burada eskiden rankWithTopsis vardı: üç kriter, sabit ağırlıklar. Uygulama
  // aynı listeyi kendi .sort()'uyla baştan sıraladığı için çıktısı hiçbir yere
  // ulaşmıyor, her istekte hesaplanıp atılıyordu. Uygulamadaki puanlama üç
  // noktada daha yetenekli: altı profil için ayrı katsayı, yürüyüş hedefi
  // aşılınca ceza, ve tek bacakta çok uzun yürüyüş içeren güzergâhı tamamen
  // eleme (TOPSIS onu listede tutuyordu — kullanıcı "en hızlı" diye seçip
  // 2.4 km yürüyebilirdi).
  //
  // Buraya yeniden sıralama eklenecekse, uygulamadaki puanlama aynı anda
  // kaldırılmalı: sorumluluk tek tarafta yaşamalı.
  return { itineraries, routingErrors, profile };
}

module.exports = {
  safeFloat,
  planRoute,
  // Saf yardımcılar — dışa açılmalarının tek sebebi test edilebilirlik.
  buildTransitPreferences,
  buildModesInput,
};
