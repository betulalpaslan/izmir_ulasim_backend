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
  // VAPUR YOK. İzmir GTFS feed'inde route_type=4 (ferry) hiç bulunmuyor —
  // İZDENİZ vapur seferleri ayrı bir kaynakta ve bu feed'e dahil değil.
  // Mod listesinde tutmak, kullanıcıya karşılığı olmayan bir seçenek
  // göstermek demekti; OTP boş sonuç dönüyordu. Feed geldiğinde geri eklenir.
  if (out.length === 0) return [{ mode: "BUS" }, { mode: "RAIL" }, { mode: "TRAM" }, { mode: "SUBWAY" }];
  return out;
}

// Bisiklet profilinin İKİ modu var ve İKİSİ DE AKTARMALIDIR:
//
//   PARK → kendi bisikletin. İstasyondaki bisiklet parkına kilitlenir,
//          yolculuk raylı sistemle sürer.
//   RENT → BİSİM. Hizmet bölgesi içinde alınır, bölge içinde bırakılır.
//
// Tek başına bisiklet sürüşü (`direct`) KASTEN İSTENMİYOR. Ölçüldü —
// Narlıdere → Çiğli, Pzt 08:00:
//   "Kendi bisikletim"  → tek kart: 137 dk / 33.5 km kesintisiz sürüş
//   "Kirala"            → tek kart: 28 dk yürü + 153 dk / 35.1 km BİSİM
// İkisi de OTP'nin doğru yanıtıydı ve ikisi de kullanıcıya işe yaramaz bir
// öneriydi: kimse şehrin bir ucundan diğerine kiralık bisikletle gitmez.
// `direct` istendiği sürece bu kartlar üretiliyor, üretildikleri sürece de
// puanlama katmanında aktarmalı adayları eziyorlardı (MOD_AMACI bisikletsiz
// aktarmalı rotaları elediği için geriye YALNIZ saf sürüş kalıyordu).
//
// Karar mod tanımında: bisiklet burada bir ERİŞİM ARACIDIR. Yolculuğun
// tamamını bisikletle yapmak isteyen kullanıcı zaten harita üzerinde
// gidebilir; bu iki modun vaadi "bisikletle transite eriş"tir.
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
    //
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
//
//   BICYCLE          → bisikleti YANINA AL, transite onunla bin
//   BICYCLE_PARKING  → bisikleti istasyonda bırak, yürüyerek devam et
//
// İkisini aynı erişim listesine koymak denendi, OTP reddediyor:
//   "Bicycle can't be combined with other modes for the same leg:
//    [BIKE, BIKE_TO_PARK]"
// Bu yüzden iki sorgu atılır ve sonuçlar birleştirilir; hangisi daha iyiyse
// puanlama katmanı öne alır (izmir_ulasim/utils/routeScoring.js).
//
// Bisikletle transite binmek İzmir'de gerçekten mümkün: metro, tramvay ve
// İZBAN bisiklet taşımaya izin veriyor. OTP bunu YALNIZ GTFS'te
// trips.bikes_allowed=1 olan seferlerde üretir; feed'de o alan operatöre
// göre yamalıdır (tools/gtfs-bisiklet-yamasi.js). Yama uygulanmadan
// derlenmiş bir graph'ta bu sorgu sessizce boş döner — hata verilmez,
// seçenek hiç üretilmez.
//
// Kaynaklar ve ölçüm: docs/API.md, "GTFS bisiklet taşıma yaması".
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
  // İsteğe bağlı kalkış zamanı. Verilmezse "şimdi".
  // İleri tarihli sorgu, GTFS takvim penceresinin ne zaman bittiğini
  // ölçmeye de yarar: takvim dışı bir gün için sefer dönmez.
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
        //
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

  // ─── Bisikletsiz TABAN ÇİZGİSİ ───────────────────────────────────────
  //
  // Burada bir zamanlar "bisikletsiz yedek" vardı: bisiklet işe yaramıyorsa
  // yürüyüş erişimiyle yeniden sorulup BİSİKLETSİZ güzergâhlar DÖNDÜRÜLÜYORDU.
  // O kaldırıldı — kullanıcı "Bisikletim + Aktarma" seçmişken içinde bisiklet
  // olmayan bir liste alıyordu (mod saflığı).
  //
  // Ama ölçüm hâlâ gerekli, çünkü "bu bisiklet işe yarıyor mu" sorusunun
  // dürüst cevabı ancak bisikletsiz alternatifle KARŞILAŞTIRARAK verilebilir.
  // Ölçüldü (Konak → Bornova): 282 m'lik bisiklet bacağı yolculuğu 6.2 dakika
  // UZATIYORDU; oran ya da mesafe eşiği bunu göremez, süre farkı görür.
  //
  // Bu yüzden yürüyüşlü sorgu yapılmaya devam ediyor ama sonucu KULLANILMIYOR;
  // yalnız en iyi süresi alınıp her güzergâha iliştiriliyor. Eleme kararı
  // gösterim katmanında (MOD_AMACI.bicycle_park) ve o katman tek: mobil
  // uygulama, web demo ve web arayüzü aynı paketi çalıştırıyor.
  //
  // Sorgu paralel gitmiyor çünkü yalnız bisiklet profillerinde gerekiyor ve
  // OTP'ye üçüncü bir istek yükü var; düşerse taban çizgisi null kalır ve
  // eleme AÇIK FAİL eder (bilinmiyorsa güzergâh elenmez).
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
