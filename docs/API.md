# izmir_backend — API sözleşmesi

Bu belge iki depo arasındaki anlaşmayı anlatır: **izmir_backend** üretir,
**izmir_ulasim** tüketir. Alan adlarının makine tarafındaki tanımı
[`contract.js`](../contract.js), doğrulaması ise
[`__tests__/contract.test.js`](../__tests__/contract.test.js) içindedir —
bir alanı yeniden adlandıran kişi orada yakalanır, kullanıcıda değil.

## Kurallar

| Kural | Sebep |
|---|---|
| Koordinat her yerde `lat` / `lon` | İZELMAN `lng` der, çeviri `ParkingService` içinde yapılır ve dışarı sızmaz. Tek istisna OTP'nin dayattığı ParkAPI gövdesi: orada `coords.lng`. |
| Bilinmeyen sayısal değer `null`, `0` değil | `0` "gerçekten sıfır" demektir. Kapasitesi bilinmeyen istasyon ile boş istasyon aynı şey değildir. |
| Liste her zaman bir zarf içinde (`{stations: […]}`) | Çıplak dizi dönmek, yanına `updatedAt` eklemeyi kırıcı değişiklik yapardı. |
| Hata gövdesi `{error, detail}` | `502` = yukarı akış cevap vermedi, tekrar dene. `500` = hata bu kodda, denemenin faydası yok. |

## Uygulamanın tükettiği uçlar

| Uç | Zarf | Eleman alanları |
|---|---|---|
| `GET /bisim/stations` | `stations` | `id, name, active, capacity, bikes, lat, lon, ref` |
| `GET /parking/stations` | `stations` | `id, name, lat, lon, type, capacity, free, occupied, status, isPaid, nearMetro, nearTrain, nearTram, provider` |
| `GET /parking/otp-lots` | `stations` | `id, name, lat, lon, tags, state, bicyclePlaces, carPlaces, otpCarSpaces, otpBicycleSpaces, otpFreeCar, free, occupied, capacity` |
| `GET /parking/osm` | `spots` | `id, name, lat, lon, type, fee, capacity` |
| `GET /parking/bike-racks` | `stations` | `id, lat, lon, capacity, covered` |
| `GET /parking/bike-feed` | `lots` | OTP içindir, uygulama tüketmez — aşağıdaki OTP bölümüne bakınız |
| `GET /geocode?q=` | `results` | `place_id, lat, lon, display_name` |
| `POST /get-route` | `itineraries` | `legs` (+ `routingErrors`, `profile`) |

Notlar:

- `bisim/stations` → `bikes` **her zaman `null`**. BİSİM'in anlık doluluğu
  2025-07-23'ten beri hiçbir kaynakta yayınlanmıyor; uydurma sayı üretilmez.
- `parking/otp-lots` → `?vehicle=bicycle|car` ve `?tag=` ile süzülür. OSM
  kaynaklı kayıtlarda (`id` öneki `OSM:`) doluluk `null`'dır — OSM'de doluluk
  verisi yoktur.
- `geocode` → `lat`/`lon` burada **metindir** (Nominatim biçimi); uygulama
  `parseFloat` eder.
- `get-route` → **sıralama yapılmaz.** Puanlama, eleme ve etiketleme
  uygulamanın işidir (`izmir_ulasim/utils/routeScoring.js`). Bir zamanlar
  backend de TOPSIS ile sıralıyordu; uygulama sonucu tamamen eziyordu.

## OTP'nin dayattığı gövdeler

Bunlar bizim tercihimiz değil — OTP'nin updater'ları tam olarak bu adları
arar ve **bir alan yanlış yazıldığında hata vermeden sıfır kayıt yükler.**

### `GET /parking/feed` — ParkAPI (`sourceType: PARK_API`)

```json
{ "lots": [ { "id": "…", "name": "…",
             "coords": { "lat": 38.41, "lng": 27.12 },
             "state": "open", "total": 41, "free": 16 } ] }
```

`state` **zorunludur**: OTP null kontrolü yapmadan okur, eksikse updater düşer.
Koordinat burada `lng`'dir — sözleşmenin tek istisnası.

Bu feed **yalnız ARABA yeri** kaydeder; `sourceType: PARK_API` böyle çalışır.

### `GET /parking/bike-feed` — ParkAPI (`sourceType: BICYCLE_PARK_API`)

Gövde şeması `/parking/feed` ile birebir aynı; fark OTP'nin bu lotları
**bisiklet** yeri olarak kaydetmesi. İçeriği:

- raylı sefer YAPILAN her durak (OTP'nin kendi durak listesinden türetilir,
  150 m'lik kümelemeyle istasyon başına tek nokta)
- P+R otoparkları (araba yeri olan yere bisiklet de bırakılır)

`free` bu feed'de hiç gönderilmez: doluluk araba yerlerinindir, bisiklet için
anlamı yoktur ve taşınırsa dolu bir otopark bisiklete de kapalı sayılır.
Kapasite nominaldir (bisiklet park envanteri yayınlanmıyor) ve kullanıcıya
dönük uçlarda gösterilmez.

**Neden var** — ölçüm, Narlıdere → Çiğli, Pzt 08:00, "bisikletim + aktarma":

```
BİSİKLET 18 dk / 4.2 km  →  OTOBÜS 311, 13 dk  →  METRO M1
```

Bisiklet metronun 3 km beriside park ediliyor ve araya bir otobüs bacağı
giriyordu. OTP'nin bisiklet bacağı ancak bisiklet parkı OLAN bir noktada
bitebilir; graph'taki 87 park yerinin tamamı OSM kaynaklıydı ve hiçbiri raylı
istasyonda değildi. Feed eklendikten sonra aynı yolculuk:

```
BİSİKLET 6 dk / 1.2 km  →  Güzel Sanatlar istasyonu  →  METRO M1 (aktarmasız)
```
71 dk (öncesi 111 dk), en uzun yürüyüş 4 dk.

**Kaynak neden İZULAŞ istasyon API'si değil:** o liste "Narlıdere İtfaiye"yi
metro istasyonu sayıyor. Metro feed'i içermeyen bir graph'a karşı denendiğinde
yalnız otobüs durağı olan bir noktaya bisiklet parkı koydu ve düzeltilmek
istenen arızayı aynen üretti. Bir noktanın bisiklet parkını hak etmesinin
ölçütü orada gerçekten raylı sefer olmasıdır.

### `GET /bisim/gbfs*` — GBFS 2.3 (`sourceType: GBFS`)

`gbfs` (discovery), `gbfs/system_information`, `gbfs/station_information`,
`gbfs/station_status`. İstasyon alanları: `station_id` (metin), `name`, `lat`,
`lon`. `capacity` **isteğe bağlıdır ve bilinmiyorsa hiç gönderilmez.**

### `router-config.json`

Üç updater var:

| feedId | sourceType | url |
|---|---|---|
| `izmir-pr` | `PARK_API` | `/parking/feed` — araba otoparkları |
| `izmir-bike-pr` | `BICYCLE_PARK_API` | `/parking/bike-feed` — raylı istasyonlar + P+R |
| `bisim-izmir` | `GBFS` | `/bisim/gbfs.json` |

`izmir-bike-pr` bir zamanlar vardı, aynı `/parking/feed`'i besliyordu (yani
İZELMAN'ın araba otoparklarını bisiklet parkı olarak yüklüyordu) ve doğru
olarak kaldırılmıştı. 2026-08'de KENDİ feed'iyle geri geldi: OSM'den gelen 87
bisiklet parkının hiçbiri raylı istasyonda değil ve bu ölçülebilir bir arızaya
yol açıyordu — yukarıya bakınız.

> **Yerel geliştirme uyarısı.** Bu depodaki `router-config.json` ve `graph.obj`
> üretim (Railway) içindir. Yerel OTP `D:/multimodal_web/otp/otp_data` dizininden
> `--load .` ile çalışıyor ve ORADAKİ `router-config.json` + `graph.obj`'i okur.
> İki graph aynı değil: depodaki 2026-04-28 tarihli ve **metro feed'ini
> içermiyor**; otp_data'daki 2026-08-16 tarihli ve `METRO İZMİR` feed'i var.
> Yanlışlıkla depodaki graph ile başlatıldığında M1 tamamen kaybolur.
> Bir updater eklerken İKİ dosyayı da güncellemek gerekir.

## GTFS bisiklet taşıma yaması

**Bisiklet İzmir'de metroya, tramvaya ve İZBAN'a bindirilebiliyor.** OTP bu
güzergâh tipini (`BICYCLE` erişim/çıkış/aktarma modu) YALNIZ GTFS'te
`trips.bikes_allowed=1` olan seferlerde üretir ve İzmir feed'inde o alan
kullanılamaz durumdaydı:

| | feed'de yazan | gerçek |
|---|---|---|
| ESHOT otobüs | 21.302 sefer "izinli", 46.095 "bilgi yok" | izinli değil |
| Tramvay | boş | **izinli** |
| İZBAN | boş | **izinli** |
| Metro | sütun hiç yok | **izinli** |

Otobüs verisi kendi içinde de tutarsız: 406 hattın 119'unda **aynı hat** hem
`0` hem `1` sefer taşıyor (hat 42: 531 izinli, 38 bilgi yok). Bisiklet otobüse
ya sığar ya sığmaz, sefere göre değişmez — bu veri değil gürültü. Yani
gerçekten bisiklet binebilen üç sistemde hiç veri yok, binemeyen otobüste
"izinli" yazıyor.

**Kaynaklar.** Metro için İZMİR METRO A.Ş.'nin açık verisi *Bisikletli Giriş
Sayıları* (`acikveri.bizizmir.com`, kaynak `c774b611-0be0-4021-ba4c-8bec8cc7201d`):
2020'den beri aylık kayıt, 2026'nın yedi ayında 58.123 giriş, temmuzda günde
~320 — kesin izinli ve artıyor. Tramvay için İzmir Tramvayı'nın kuralı: ek
ücret ödemeden bisiklet, katlanabilir bisiklet, elektrikli bisiklet ve scooter
taşınabilir (motosiklet ebadında/ağırlığında ve üç tekerlekli olanlar hariç).
İZBAN için de aynı izin geçerli. ESHOT için izin verildiğine dair kaynak yok.

**Yama.** `tools/gtfs-bisiklet-yamasi.js` feed'lerdeki `bikes_allowed` alanını
operatöre göre yeniden yazar:

```bash
node tools/gtfs-bisiklet-yamasi.js <gtfs-dizini>            # uygula
node tools/gtfs-bisiklet-yamasi.js <gtfs-dizini> --denetle  # sadece kontrol, CI için
java -Xmx3g -jar otp-shaded-2.8.1.jar --build --save <gtfs-dizini>
```

> **Feed her tazelendiğinde yeniden uygulanmalı.** Yamasız derlenen bir
> graph'ta bisikletle transite binme güzergâhı **sessizce** kaybolur: hata
> verilmez, o seçenek hiç üretilmez ve mod yalnızca "bisikleti istasyonda
> bırak" güzergâhları döndürür. `--denetle` bu yüzden var; graph derleme
> adımının önüne konabilir.

**`build-config.json` de gerekli.** Yalnız GTFS yaması yetmiyor: OTP aktarma
mesafelerini graph derlenirken ÖNCEDEN hesaplıyor ve varsayılan olarak yalnız
yürüyüş için. Bisikletli aktarma tablosu yoksa taşıma güzergâhı **yalnız tek
transit bacaklı** yolculuklarda çıkar; aktarma gerektiren her şeyde OTP
`NO_TRANSIT_CONNECTION` döner. Ölçüldü — Balçova → Buca, bisiklet yanında:

| hedef | aktarma | sonuç |
|---|---|---|
| Çankaya (yalnız M1) | yok | 35 dk, bisikletli güzergâh bulundu |
| Şemikler (M1 + İZBAN) | var | **hiç güzergâh yok** |

Bu yüzden `build-config.json`'da:

```json
"transferRequests": [ { "modes": "WALK" }, { "modes": "BICYCLE" } ]
```

OTP'nin mod karıştırmaya dair iki katı kuralı da burada not edilsin, ikisi de
denenip hata alındı:

- `access`/`egress`/`transfer`'de BICYCLE kullanılıyorsa **üçünde de**
  kullanılmalı — *"If BICYCLE is used for access, egress or transfer, then it
  should be used for all."*
- BICYCLE başka bir modla aynı listede olamaz — *"Bicycle can't be combined
  with other modes for the same leg: [BIKE, WALK]"*, aynı şekilde
  `[BIKE, BIKE_TO_PARK]`.

Bu yüzden "bisikleti yanına al" ve "bisikleti park et" TEK sorguda istenemez;
backend iki ayrı sorgu atıp sonuçları birleştirir (`buildModesInputs`).

## Sağlık uçları

| Uç | Ne söyler | Kod |
|---|---|---|
| `GET /health` | Node ayakta mı. Ağ isteği yapmaz. | **Her zaman 200** |
| `GET /health/ready` | OTP erişilebilir mi, veri hangi kaynaktan geliyor | 200 (`ok`/`degraded`), 503 (`down`) |

`/health` platform healthcheck'i ve `start.sh`'ın hazırlık yoklaması içindir;
OTP'ye bağlansaydı OTP'nin ~1 dakikalık açılışı boyunca deploy başarısız sayılırdı.

`/health/ready` içindeki `issues` dizisi sessiz bozulmaları adlandırır:

| issue | Anlamı |
|---|---|
| `otp_unreachable` | Rota üretilemiyor (tek `down` sebebi) |
| `graph_expired` / `graph_expiring_soon` | GTFS takvim penceresi bitti/bitiyor — toplu taşıma rotaları sessizce kaybolur |
| `bisim_build_cache` / `parking_build_cache` / `osm_parking_build_cache` / `bike_parking_build_cache` | Veri canlı kaynaktan değil, build sırasında alınmış yedekten geliyor |
| `bisim_overpass_backoff` / `overpass_backoff` | Overpass düştü, 6 saatlik tekrar-deneme beklemesi sürüyor |
| `bisim_no_stations` / `parking_no_park_and_ride` | Kaynak cevap veriyor ama süzgeçten hiçbir kayıt geçmiyor |

## Yapılandırma

Tümü [`config.js`](../config.js) içinde: portlar, OTP adresi, dış kaynak
URL'leri, TTL'ler ve timeout'lar. Ortam değişkeni yalnızca `OTP_PORT`.
