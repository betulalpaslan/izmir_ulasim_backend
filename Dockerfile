FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache wget nodejs npm
WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .
COPY config.js .
COPY router-config.json .
COPY start.sh .
COPY routes/ routes/
COPY services/ services/
COPY middleware/ middleware/
# BİSİM bölge modeli bu iki dosyadan üretilir ve İKİSİ DE ZORUNLU:
#   bisim-bolgeler.json      → bırakma noktaları (yeşil "P" bonus alanları)
#   bisiklet-yollari.geojson → hizmet alanı poligonu ve serbest bisikletlerin
#                              örneklendiği koridor
# Kopyalanmazsa BisimBolgeService açılışta dosya bulamaz: hizmet alanı da,
# GBFS free_bike_status da üretilemez, yani BİSİM üretimde tamamen kaybolur.
COPY data/ data/
COPY bisim_cache.json .
COPY parking_cache.json .
# Kapasite anlık görüntüsü — BikeShareService.loadCapacityByRef bunu okur.
# Kopyalanmazsa kapasite sessizce yalnızca OSM etiketinden gelir (çoğu
# istasyonda o etiket yok) ve GBFS feed.i kapasitesiz istasyon yayınlar.
COPY bisim_stations.json .
# OSM bisiklet parkı yedeği (86 nokta). Overpass erişilemediğinde
# /parking/bike-racks bunu servis eder.
COPY bike_parking_cache.json .

RUN wget -q https://github.com/kitanajde/izmir-otp-files/releases/download/v1/otp-shaded-2.8.1.jar
# graph.obj SÜRÜM ETİKETİYLE alınır, "en son" diye sabit bir URL ile değil.
# Sebep: bu bir RUN katmanı ve Docker onu URL'e göre önbelleğe alır. Aynı
# etiketin üstüne yeni dosya yüklenirse katman değişmediği için yeniden
# indirilmez — hata verilmez, eski graph'la çalışılır. v2, bisiklet taşıma
# (bikes_allowed yaması) ve bisikletli aktarma tablosu içerir.
RUN wget -q https://github.com/betulalpaslan/izmir-otp-files/releases/download/v2/graph.obj

# Build sırasında Overpass'tan taze BİSİM verisi çekmeyi dene; başarısız olursa statik cache kalır
RUN wget -q -O /tmp/bisim_fresh.json \
      "https://overpass-api.de/api/interpreter?data=%5Bout%3Ajson%5D%3Bnode%5Bamenity%3Dbicycle_rental%5D%2838.2%2C26.8%2C38.6%2C27.5%29%3Bout%3B" \
    && mv /tmp/bisim_fresh.json bisim_cache.json \
    || true

# Build sırasında İZELMAN'dan taze otopark verisi çekmeyi dene; başarısız olursa statik cache kalır
RUN wget -q --timeout=20 -O /tmp/parking_fresh.json \
      "https://openapi.izmir.bel.tr/api/ibb/izum/otoparklar" \
    && mv /tmp/parking_fresh.json parking_cache.json \
    || true

RUN chmod +x start.sh

EXPOSE 3000
CMD ["sh", "start.sh"]
