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
COPY parking_cache.json .
# NOT: bisim_cache.json ve bisim_stations.json burada KOPYALANMIYOR, çünkü
# artık yoklar. İkisi de BikeShareService'in girdisiydi; o servis BİSİM
# sabit istasyonları kaldırılınca (2025-08) silindi. Bölge modeli verisini
# data/ dizininden okur — yukarıdaki COPY data/ satırı.
# Bu satırlar bir süre kalmıştı ve Docker build'i COPY adımında kırıyordu:
# imaj derlenmeden hata verdiği için hiçbir testte görünmüyordu.
# OSM bisiklet parkı yedeği (86 nokta). Overpass erişilemediğinde
# /parking/bike-racks bunu servis eder.
COPY bike_parking_cache.json .

RUN wget -q https://github.com/betulalpaslan/izmir-otp-files/releases/download/v1/otp-shaded-2.8.1.jar
# graph.obj SÜRÜM ETİKETİYLE alınır, "en son" diye sabit bir URL ile değil.
# Sebep: bu bir RUN katmanı ve Docker onu URL'e göre önbelleğe alır. Aynı
# etiketin üstüne yeni dosya yüklenirse katman değişmediği için yeniden
# indirilmez — hata verilmez, eski graph'la çalışılır. v2, bisiklet taşıma
# (bikes_allowed yaması) ve bisikletli aktarma tablosu içerir.
RUN wget -q https://github.com/betulalpaslan/izmir-otp-files/releases/download/v2/graph.obj

# NOT: Burada Overpass'tan amenity=bicycle_rental çeken bir adım vardı ve
# sonucu bisim_cache.json'a yazıyordu. Kaldırıldı, çünkü o dosyayı okuyan
# kimse kalmadı: BİSİM 2025-08'de sabit istasyonları kaldırdı, model bölge
# tabanlı ve verisi data/ dizininden geliyor. Adım her build'de Overpass'a
# gidip hiçbir işe yaramayan bir dosya üretiyordu.

# Build sırasında İZELMAN'dan taze otopark verisi çekmeyi dene; başarısız olursa statik cache kalır
RUN wget -q --timeout=20 -O /tmp/parking_fresh.json \
      "https://openapi.izmir.bel.tr/api/ibb/izum/otoparklar" \
    && mv /tmp/parking_fresh.json parking_cache.json \
    || true

RUN chmod +x start.sh

EXPOSE 3000
CMD ["sh", "start.sh"]
