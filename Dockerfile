FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache wget nodejs npm
WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .
COPY router-config.json .
COPY start.sh .
COPY routes/ routes/
COPY services/ services/
COPY middleware/ middleware/
COPY bisim_cache.json .
COPY parking_cache.json .
# Kapasite anlık görüntüsü — BikeShareService.loadCapacityByRef bunu okur.
# Kopyalanmazsa kapasite sessizce yalnızca OSM etiketinden gelir (çoğu
# istasyonda o etiket yok) ve GBFS feed.i kapasitesiz istasyon yayınlar.
COPY bisim_stations.json .

RUN wget -q https://github.com/kitanajde/izmir-otp-files/releases/download/v1/otp-shaded-2.8.1.jar
RUN wget -q https://github.com/kitanajde/izmir-otp-files/releases/download/v1/graph.obj

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
