const express = require("express");
const config = require("./config");
const cors = require("cors");
const { baslatYenileme } = require("./services/ParkingService");
const healthRouter  = require("./routes/healthRouter");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const routeRouter   = require("./routes/routeRouter");
const bisimRouter   = require("./routes/bisimRouter");
const parkingRouter = require("./routes/parkingRouter");
const osmRouter     = require("./routes/osmRouter");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/", healthRouter);   // /health, /health/ready — diğer router.ların önünde
app.use("/", routeRouter);
app.use("/bisim", bisimRouter);
app.use("/parking", parkingRouter);
// OSM katmanları ve adres araması: uygulamanın doğrudan Overpass/Photon'a
// gitmesi yerine buradan geçer — cache, mirror ve disk yedeği bu tarafta.
app.use("/", osmRouter);

// Router.lardan SONRA gelmeli: eşleşmeyen yol, sonra zincirin tek hata çıkışı.
// asyncHandler.ın yakaladığı her red buraya düşer.
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(config.PORT, async () => {
  console.log(`API Sunucusu http://localhost:${config.PORT} adresinde aktif`);
  console.log(`BİSİM GBFS feed: http://localhost:${config.PORT}/bisim/gbfs`);

  console.log("Cache'ler önceden dolduruluyor...");
  // İlk tur burada beklenir; sonrası arka planda döner. Otopark uçları bu
  // andan itibaren ağ beklemeden yanıt verir — OTP'nin ParkAPI updater'ı 5
  // saniyede vazgeçtiği için /parking/feed'in hızlı olması şart.
  try {
    const parks = await baslatYenileme();
    console.log(`Otopark cache: ${parks.length} kayıt yüklendi`);
  } catch (err) {
    console.warn("Otopark cache doldurulamadı:", err.message);
  }
  console.log("Sunucu hazır.");
});
