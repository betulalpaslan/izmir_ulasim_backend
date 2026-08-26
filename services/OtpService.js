const axios = require("axios");

const OTP_PORT = process.env.OTP_PORT || 8080;
const OTP_URL = `http://localhost:${OTP_PORT}/otp/gtfs/v1`;

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

function extractCriteria(itinerary) {
  const legs = itinerary.legs || [];
  const totalDuration = legs.reduce((sum, l) => sum + (l.duration || 0), 0);
  const walkDuration  = legs.filter(l => l.mode === "WALK").reduce((sum, l) => sum + (l.duration || 0), 0);
  const transitLegs   = legs.filter(l => !["WALK", "BICYCLE", "BICYCLE_RENTAL", "CAR"].includes(l.mode));
  const transfers     = Math.max(0, transitLegs.length - 1);
  return { totalDuration, walkDuration, transfers };
}

function rankWithTopsis(itineraries) {
  if (itineraries.length <= 1) return itineraries;

  const weights = { totalDuration: 0.40, walkDuration: 0.35, transfers: 0.25 };
  const keys    = Object.keys(weights);
  const criteria = itineraries.map(extractCriteria);

  // Vektör normalizasyonu
  const norms = {};
  for (const k of keys) {
    const sumSq = criteria.reduce((s, c) => s + c[k] ** 2, 0);
    norms[k] = Math.sqrt(sumSq) || 1;
  }

  // Ağırlıklı normalize matris
  const weighted = criteria.map(c => {
    const w = {};
    for (const k of keys) w[k] = (c[k] / norms[k]) * weights[k];
    return w;
  });

  // İdeal en iyi (min) ve en kötü (max) — tüm kriterler "küçük daha iyi"
  const idealBest  = {};
  const idealWorst = {};
  for (const k of keys) {
    const vals = weighted.map(w => w[k]);
    idealBest[k]  = Math.min(...vals);
    idealWorst[k] = Math.max(...vals);
  }

  // Yakınlık katsayısı hesapla
  const scored = weighted.map((w, i) => {
    const dBest  = Math.sqrt(keys.reduce((s, k) => s + (w[k] - idealBest[k])  ** 2, 0));
    const dWorst = Math.sqrt(keys.reduce((s, k) => s + (w[k] - idealWorst[k]) ** 2, 0));
    const closeness = (dBest + dWorst) > 0 ? dWorst / (dBest + dWorst) : 0;
    return { i, closeness };
  });

  scored.sort((a, b) => b.closeness - a.closeness);
  return scored.map(s => itineraries[s.i]);
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
    OTP_URL,
    { query, variables: { dateTime, first, modes: modesInput } },
    { timeout: 15000 }
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

  return { itineraries: rankWithTopsis(itineraries), routingErrors, profile };
}

module.exports = { safeFloat, planRoute };
