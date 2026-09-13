# İzmir Ulaşım — Backend

İzmir Ulaşım mobil uygulamasının sunucu tarafı. Uygulamanın konuştuğu tek REST API'dir;
arkasında aynı konteynerde çalışan bir OpenTripPlanner 2.8.1 örneği vardır. Şehrin açık
verisini (BİSİM, İZELMAN ve CKAN otoparkları, raylı sistem istasyonları) OTP'nin anladığı
feed biçimlerine çevirir; Park & Ride ve bisiklet + toplu taşıma güzergâhları bu sayede
planlanabilir.

Node.js / Express · OpenTripPlanner 2.8.1 · GBFS 2.3 · Docker · Railway

Mobil uygulama (React Native / Expo) ayrı bir depodadır.

---

## Mimari

```
                   REST                    GraphQL
  Mobil uygulama ───────▶ Express :3000 ───────────▶ OpenTripPlanner :8080
                            │     ▲                        │
                            │     └───── feed çekme ───────┘
                            │          (1–5 dakikada bir)
                            ▼
                 açık veri kaynakları
   İZELMAN · CKAN · openapi.izmir.bel.tr · Overpass · Photon / Nominatim
```

İkisi aynı Docker konteynerinde çalışır ve dışarıya yalnız 3000 portu açıktır; OTP içeride
kalır. Veri iki yönde akar: uygulama rota istediğinde Express OTP'ye GraphQL sorgusu atar,
OTP ise canlı veriyi Express'in feed uçlarından **kendisi çeker**
([router-config.json](router-config.json)):

| Updater | Tür | Uç | Sıklık |
|---|---|---|---|
| `izmir-pr` | `PARK_API` | `/parking/feed` — P+R araç otoparkları | 1 dk |
| `izmir-bike-pr` | `BICYCLE_PARK_API` | `/parking/bike-feed` — raylı istasyonlar ve P+R | 5 dk |
| `bisim-izmir` | `GBFS` | `/bisim/gbfs.json` — BİSİM, bölge sınırlarıyla | 1 dk |

**Başlatma sırası önemli** ([start.sh](start.sh)). OTP'nin updater'ları Node'un uçlarını
çektiği için önce Node başlar, `/health` yanıt verene kadar beklenir (en fazla 60 sn), sonra
OTP açılır. Bir gözcü döngüsü iki süreci izler: biri ölürse diğeri de durdurulur ve konteyner
hata koduyla düşer, Railway'in `ON_FAILURE` politikası yeniden başlatır. Eskiden OTP ayakta
kaldıkça Node'un çökmesi fark edilmiyor, feed'ler sessizce boşalıyordu.

### Katmanlar

| Dizin / dosya | Sorumluluk |
|---|---|
| `routes/` | HTTP uçları: girdi doğrulama, yanıt biçimi |
| `services/` | İş mantığı ve dış kaynaklar (aşağıda) |
| `middleware/` | `asyncHandler` ve tek hata çıkışı `errorHandler` |
| `contract.js` | Uygulamayla paylaşılan alan adları; `__tests__/contract.test.js` doğrular |
| `config.js` | Portlar, dış kaynak adresleri, TTL ve timeout değerleri, gerekçeleriyle |
| `data/` | BİSİM bölge modelinin girdileri: bırakma bölgeleri ve bisiklet yolu geometrisi |
| `tools/` | GTFS bisiklet taşıma yaması |
| `*_cache.json` | Dış kaynak çökünce okunan disk yedekleri. Soğuk başlangıçta bile liste boş kalmasın diye depoda bir tohum sürümü durur. |

| Servis | Görevi |
|---|---|
| `OtpService` | Profili OTP `planConnection` sorgusuna çevirir; gerektiğinde birden fazla sorguyu birleştirir |
| `ParkingService` | CKAN envanteriyle İZELMAN doluluğunu birleştirir; P+R süzgeci, ParkAPI ve bisiklet park feed'leri |
| `BisimBolgeService` | BİSİM'in bölge tabanlı modeli: hizmet alanı, bırakma bölgeleri, GBFS feed'leri |
| `RayliIstasyonService` | Raylı sistem ve vapur istasyonları, en yakın istasyon araması |
| `StopIndexService` | OTP'nin durak listesinden kurulan ızgara indeksi (adres araması kullanır) |
| `GeocodingService` | Photon ve Nominatim ile İzmir sınırları içinde adres araması, 5 dk önbellek |
| `OverpassService` | Üç Overpass mirror'ı, disk yedeği, hepsi düşünce 6 saatlik geri çekilme |
| `OsmParkingService` | OSM'den kapalı/yeraltı otoparklar ve bisiklet parkları |

---

## Uçlar

**Uygulamanın kullandıkları**

| Uç | Döndürdüğü |
|---|---|
| `POST /get-route` | Güzergâhlar (`itineraries`), `routingErrors`, `profile` — aşağıya bakınız |
| `GET /bisim/stations` | BİSİM bırakma bölgeleri ve harita için hizmet ağı |
| `GET /parking/stations` | P+R otoparkları; `?kapsam=tumu` ile hepsi |
| `GET /parking/otp-lots` | OTP'nin gerçekten kullandığı lotlar, İZELMAN doluluğuyla (`?vehicle=bicycle\|car`, `?tag=`) |
| `GET /parking/osm` | OSM'deki kapalı/yeraltı ve isimli açık otoparklar |
| `GET /parking/bike-racks` | OSM bisiklet parkları (OTP kapalıyken de çalışır) |
| `GET /geocode?q=` | Adres araması |

**OTP'nin çektikleri:** `/parking/feed`, `/parking/bike-feed`, `/bisim/gbfs` ve GBFS alt
feed'leri (`system_information`, `station_information`, `station_status`, `vehicle_types`,
`free_bike_status`, `geofencing_zones`). Gövde şemalarını OTP dayatır; bir alan yanlış
yazıldığında OTP hata vermeden sıfır kayıt yükler.

**Sağlık**

| Uç | Ne söyler |
|---|---|
| `GET /health` | Node ayakta mı. Ağ isteği yapmaz, her zaman 200 döner. Platform healthcheck'i ve `start.sh` bunu kullanır. |
| `GET /health/ready` | OTP erişilebilir mi, veri hangi kaynaktan geliyor: 200 (`ok` / `degraded`) veya 503 (`down`). `issues` dizisi sessiz bozulmaları adlandırır: GTFS takviminin bitmesi, verinin canlı kaynak yerine build yedeğinden gelmesi, Overpass'ın düşmesi. |

OTP entegrasyonunu elle doğrulamak için tanı uçları da var: `/otp-status` (GTFS hizmet
penceresi ve kalan gün), `/bisim/otp-check`, `/bisim/otp-rental-test`, `/bisim/otp-schema`.

**Sunucu hataları** `{ error, detail }` gövdesiyle döner. `502` dış kaynağa (OTP dahil)
ulaşılamadığını söyler ve tekrar denenebilir; `500` hatanın bu kodda olduğunu söyler.
Uygulama kullanıcıya göstereceği mesajı bu ayrıma göre seçer.

### `POST /get-route`

```json
{
  "from": { "lat": 38.4189, "lon": 27.1287 },
  "to":   { "lat": 38.4360, "lon": 27.1490 },
  "profile": "bicycle",
  "bikeType": "RENT",
  "modes": ["BUS", "TRAM", "RAIL"],
  "numItineraries": 10,
  "dateTime": "2026-09-14T08:00:00+03:00"
}
```

Yalnız `from` ve `to` zorunludur. `modes` boşsa otobüs, tramvay, İZBAN ve metro birlikte
aranır (`RAIL` metroyu da kapsar); `numItineraries` varsayılanı 10, `dateTime` varsayılanı
şimdiki zamandır.

| `profile` | `bikeType` | OTP'ye giden sorgu |
|---|---|---|
| `transit` | — | Yürüyerek erişim, aktarma ve çıkış |
| `bicycle` | `RENT` | BİSİM: erişim ve çıkışta `BICYCLE_RENTAL` ya da yürüyüş |
| `bicycle` | `PARK` (varsayılan) | **İki sorgu:** bisiklet yanında (metro, tramvay ve İZBAN'a binilebilir) ve istasyonda bırakıp yürüyerek devam. Sonuçlar birleştirilip tekilleştirilir. |
| `car` | — | Doğrudan araç |
| `park_and_ride` | — | Araçla otoparka, oradan toplu taşıma |

- **Sıralama yapılmaz.** Puanlama, eleme ve etiketleme uygulamanın işidir; mobil ve web
  istemcisi aynı kodu kullanır. Backend bir ara TOPSIS ile sıralıyordu, uygulama o sıralamayı
  zaten tamamen eziyordu.
- **Bir sorgu düşerse diğerinin sonucu yine döner.** İki sorgulu profilde yalnız ikisi de
  başarısız olursa hata verilir.
- **`duzTransitEnIyiSn`:** `bicycle` ve `park_and_ride` profillerinde yürüyüşlü bir toplu
  taşıma sorgusu daha atılır ve en iyi süresi yanıta eklenir. Uygulama bununla "bisiklet
  bu yolculuğu X dk uzatıyor" diyebilir ve mod işe yaramadığında düz toplu taşımaya tek
  dokunuşla geçiş sunar. Sorgu başarısızsa alan boş kalır; tahmin üretilmez. Bisiklette
  aynı değer eski adıyla (`bisikletsizEnIyiSn`) da gönderilir.
- OTP kiralık bisikleti de `BICYCLE` diye bildirir. Bacağın ucunda kiralık araç ya da
  istasyon varsa backend onu `BICYCLE_RENTAL` olarak işaretler.

---

## Ölçülmüş kararlar

**Bisiklet parkları OTP'nin kendi durak listesinden türetilir.** OTP'de bisiklet bacağı
ancak bisiklet parkı olan bir noktada bitebilir. Graph'taki 87 park yerinin tamamı OSM
kaynaklıydı ve hiçbiri raylı istasyonda değildi. Narlıdere → Çiğli (Pazartesi 08:00)
güzergâhında bisiklet metroya 3 km kala bırakılıyor, araya bir otobüs bacağı giriyordu:
111 dakika. `/parking/bike-feed` raylı sefer yapılan her durağı (150 m'lik kümelemeyle)
bisiklet parkı olarak yayınlayınca aynı yolculuk 6 dakika bisiklet, ardından Güzel
Sanatlar'dan aktarmasız M1 oldu: 71 dakika. Kaynak Büyükşehir'in istasyon listesi değil;
o liste "Narlıdere İtfaiye"yi metro istasyonu sayıyor ve yalnız otobüs durağı olan bir
yere park koyarak aynı arızayı üretti.

**GTFS'te bisiklet izni ters girilmiş.** `bikes_allowed` alanı ESHOT otobüslerinde
"izinli", bisiklet alınan tramvay ve İZBAN'da boş; metro feed'inde sütun hiç yok. Otobüs
verisi kendi içinde de tutarsız: 406 hattın 119'unda aynı hat hem izinli hem bilgisiz
seferler taşıyor. Metro için İzmir Metro'nun açık verisi (2026'nın ilk yedi ayında 58.123
bisikletli giriş), tramvay ve İZBAN için işletme kuralları esas alındı;
[tools/gtfs-bisiklet-degisikligi.js](tools/gtfs-bisiklet-degisikligi.js) alanı operatöre
göre yeniden yazar. Bu tek başına yetmedi: OTP aktarma mesafelerini graph derlenirken
yalnız yürüyüş için hesaplıyor, bisikletli aktarma tablosu olmadan aktarmalı her güzergâh
`NO_TRANSIT_CONNECTION` döndü. [build-config.json](build-config.json) bu tabloyu ekler.
Bisikletli aktarma 8 dakikayla sınırlıdır: varsayılan 30 dakikada graph 264 MB'a
çıkıyordu, 8 dakikayla 84 MB.

**BİSİM istasyonsuz modellendi.** BİSİM 2025-08'de sabit istasyonları kaldırdı; bisiklet
hizmet alanı içinde her yere bırakılabiliyor. Bölgeleri GBFS'e istasyon olarak yayınlamak
OTP'ye yuvalı bir sistem tarif ediyordu: Konak İskele → Alsancak Garı'nda bisiklet en yakın
istasyona bırakılıp kalan 1,3 km yürünüyordu. `free_bike_status`, `vehicle_types`
(`free_floating`) ve `geofencing_zones` ile aynı yolculuk kapıya kadar sürülüyor, 19
dakika. Canlı bisiklet konumu yayınlanmadığı için bu noktalar gerçek bisiklet yolu
geometrisi üzerinde 400 m'de bir örneklenir. Varsayım oldukları için **kullanıcıya hiç
gösterilmez**; harita yalnız hizmet alanını çizer.

**Otopark verisi iki kaynaktan birleştirilir.** Anlık doluluk yalnız İZELMAN'da var (14
otopark), konum ve kapasite envanteri İzmir Açık Veri'de (CKAN, 82 otopark). İkisi 150 m
ve ad benzerliğiyle eşleştirilir. Kapalı otoparklar her zaman P+R sayılır; yol kenarındakiler
yalnız bir raylı sistem veya vapur istasyonuna 400 m'den yakınsa. Eşik 82 otoparkın hepsinde
ölçüldü: 400 m'de 50, 600 m'de 68, 800 m'de 81 otopark geçiyor; 800 m'de kural artık ayırt
etmiyor. İZELMAN ucu 48–58 saniyede yanıt verdiğinden yenileme istek yolunda değil arka
planda yapılır. Bilinmeyen doluluk `0` olarak yazılmaz: OTP bunu "dolu" okur ve sensörü
olmayan 68 otoparkı rotalamadan düşürürdü.

**`/health` ile `/health/ready` ayrı.** Platform healthcheck'i OTP'ye bağlı olsaydı, OTP'nin
yaklaşık bir dakikalık açılışı boyunca her deploy başarısız sayılırdı. Hazırlık ucu ise
sessiz arızaları adlandırır; örneğin GTFS takvimi bittiğinde toplu taşıma rotaları hata
vermeden kaybolur.

---

## Çalıştırma

### Yerelde

```bash
npm install
npm start        # Express, :3000
```

OTP ayrı çalışır ve `:8080`'de beklenir. OTP jar'ı ve derlenmiş graph
[izmir-otp-files](https://github.com/betulalpaslan/izmir-otp-files/releases) sürümlerindedir;
ikisini bu dizine indirdikten sonra:

```bash
java -Xmx2g -jar otp-shaded-2.8.1.jar --load . --port 8080
```

`router-config.json`'daki updater'lar `localhost:3000`'e baktığı için önce Node'u başlatın.
OTP olmadan feed ve otopark uçları çalışır, `/get-route` hata döner.

### Docker ve Railway

```bash
docker build -t izmir-backend .
docker run -p 3000:3000 izmir-backend
```

İmaj OTP jar'ını ve graph'ı sürüm etiketiyle indirir, build sırasında İZELMAN'dan taze
otopark verisi dener (başarısız olursa depodaki yedek kalır). Railway aynı Dockerfile'ı
kullanır; [railway.json](railway.json) `/health` healthcheck'ini ve `ON_FAILURE` yeniden
başlatmayı tanımlar.

| Ortam değişkeni | Varsayılan | |
|---|---|---|
| `OTP_PORT` | `8080` | OTP'nin portu |
| `OTP_HEAP` | `2g` | OTP'nin JVM yığın boyutu |
| `HAZIRLIK_TIMEOUT` | `60` | `start.sh`'ın Node'u bekleme süresi (sn) |

Geri kalan her ayar [config.js](config.js)'tedir. Gizli anahtar yok; kullanılan tüm
kaynaklar herkese açık.

### Graph'ı yenilemek

GTFS feed'leri tazelendiğinde:

```bash
node tools/gtfs-bisiklet-degisikligi.js <gtfs-dizini>             # yamayı uygula
node tools/gtfs-bisiklet-degisikligi.js <gtfs-dizini> --denetle   # yalnız kontrol; yamasız sefer varsa çıkış kodu 1
java -Xmx3g -jar otp-shaded-2.8.1.jar --build --save <gtfs-dizini>
```

- Yama **her tazelemede yeniden uygulanmalı.** Yamasız graph'ta "bisiklet yanında"
  güzergâhları hata vermeden kaybolur; `--denetle` bu yüzden var.
- `build-config.json` derleme dizininde olmalı; bisikletli aktarma tablosu oradan gelir.
- Betik zip dosyalarını PowerShell ile açar, bu yüzden Windows'ta çalışır.
- Yeni `graph.obj` izmir-otp-files'a **yeni bir sürüm etiketiyle** yüklenir ve
  Dockerfile'daki adres güncellenir. Aynı etiketin üstüne yazılırsa Docker o katmanı
  önbellekten alır ve eski graph'la çalışmaya devam eder.

---

## Testler

```bash
npm test
```

**131 test, 8 paket:** servisler (OTP sorgusu, otopark, Overpass, OSM otoparkları, adres
araması), middleware ve uygulamayla aradaki alan sözleşmesi.

**Senaryo matrisi** ([__tests__/senaryolar.json](__tests__/senaryolar.json)): 7 güzergâh ×
6 mod, ayakta bir backend ve OTP'ye 42 gerçek istek. Eşikler mobil uygulamanın `utils/`
kaynağından okunur, yani iki depo aynı kuralla ölçülür. Mobil depo yan dizinde
(`../izmir_ulasim`) değilse yolu `MOBIL_UTILS` ile verin. Backend ayakta değilse matris
atlanır.

---

## Veri kaynakları

| Kaynak | Kullanım |
|---|---|
| İzmir GTFS feed'leri | OTP graph'ı: hat, durak, sefer |
| İZELMAN / İZUM | Otopark doluluğu |
| İzmir Açık Veri (CKAN) | Otopark envanteri |
| `openapi.izmir.bel.tr` | Metro, İZBAN, tren garı ve iskele konumları |
| `data/` | BİSİM bırakma bölgeleri, açık veri bisiklet yolu geometrisi |
| OpenStreetMap (Overpass) | Kapalı/yeraltı otoparklar, bisiklet parkları |
| Photon / Nominatim | Adres araması |

Tümü herkese açıktır ve kimlik doğrulaması gerektirmez.
