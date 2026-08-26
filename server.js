const express = require("express");
const cors = require("cors");
const { fetchParks } = require("./services/ParkingService");
const healthRouter  = require("./routes/healthRouter");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const routeRouter   = require("./routes/routeRouter");
const bisimRouter   = require("./routes/bisimRouter");
const parkingRouter = require("./routes/parkingRouter");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/", healthRouter);   // /health, /health/ready — diğer router.ların önünde
app.use("/", routeRouter);
app.use("/bisim", bisimRouter);
app.use("/parking", parkingRouter);

// Router.lardan SONRA gelmeli: eşleşmeyen yol, sonra zincirin tek hata çıkışı.
// asyncHandler.ın yakaladığı her red buraya düşer.
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(3000, async () => {
  console.log("API Sunucusu http://localhost:3000 adresinde aktif");
  console.log("BİSİM GBFS feed: http://localhost:3000/bisim/gbfs");

  console.log("Cache'ler önceden dolduruluyor...");
  try {
    const parks = await fetchParks();
    console.log(`Otopark cache: ${parks.length} kayıt yüklendi`);
  } catch (err) {
    console.warn("Otopark cache doldurulamadı:", err.message);
  }
  console.log("Sunucu hazır.");
});
