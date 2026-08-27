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

### `GET /bisim/gbfs*` — GBFS 2.3 (`sourceType: GBFS`)

`gbfs` (discovery), `gbfs/system_information`, `gbfs/station_information`,
`gbfs/station_status`. İstasyon alanları: `station_id` (metin), `name`, `lat`,
`lon`. `capacity` **isteğe bağlıdır ve bilinmiyorsa hiç gönderilmez.**

### `router-config.json`

İki updater var: `izmir-pr` (PARK_API → `/parking/feed`) ve `bisim-izmir`
(GBFS → `/bisim/gbfs.json`). Bir zamanlar üçüncü bir updater vardı —
`izmir-pr-bike` (BICYCLE_PARK_API) aynı `/parking/feed`'i besliyordu, yani
İZELMAN'ın araba otoparklarını bisiklet parkı olarak yüklüyordu. Kaldırıldı:
gerçek bisiklet parkları OSM'den graph'a zaten giriyor (2026-08 ölçümü: 87 nokta).

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
