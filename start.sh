#!/bin/sh
# Konteynerde iki süreç var: Node (feed'ler, 3000) ve OTP (rotalama, 8080).
# OTP'nin updater'ları Node'un uçlarını çeker, bu yüzden Node önce hazır olmalı.
set -eu

# server.js sabit 3000 dinliyor (app.listen(3000)); ikisi birlikte değişmeli.
NODE_PORT=3000
OTP_PORT=${OTP_PORT:-8080}
HAZIRLIK_TIMEOUT=${HAZIRLIK_TIMEOUT:-60}

node server.js &
NODE_PID=$!

# Eskiden burada "sleep 15" vardı: Node'un 15 saniyede hazır olacağı
# VARSAYILIYORDU. Yavaş bir makinede yetmezse OTP feed'i boş görür ve hata
# vermeden istasyonsuz çalışır. Artık gerçekten yoklanıyor — hızlı makinede
# 1-2 saniyede geçer, yavaşta 60 saniyeye kadar bekler.
echo "Node bekleniyor (en fazla ${HAZIRLIK_TIMEOUT} sn)..."
i=0
while [ "$i" -lt "$HAZIRLIK_TIMEOUT" ]; do
  if wget -q -O /dev/null "http://localhost:${NODE_PORT}/health"; then
    echo "Node hazır (${i} sn)."
    break
  fi
  # Node hiç başlamadan öldüyse beklemenin anlamı yok, hemen düş.
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "HATA: Node başlamadan öldü."
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -ge "$HAZIRLIK_TIMEOUT" ]; then
  echo "HATA: Node ${HAZIRLIK_TIMEOUT} sn içinde /health'e yanıt vermedi."
  kill "$NODE_PID" 2>/dev/null || true
  exit 1
fi

echo "OTP başlatılıyor..."
# Yığın boyutu. 1g yetmiyor: bisikletli aktarma tablosu graph'a eklendiğinde
# dosya 73 MB'tan 84 MB'a çıktı ve yükleme sırasında tepe bellek kullanımı
# dosya boyutunun katı oluyor. Ortamdan geçersiz kılınabilir ki daha büyük
# bir plana geçildiğinde bu dosya düzenlenmesin.
#
# NOT: aktarma tablosu bir ara 264 MB'a çıkmıştı; sebebi bisiklet aktarma
# yarıçapının varsayılan 30 dakika (~8 km) olmasıydı. build-config.json'daki
# transferParametersForMode.BIKE.maxTransferDuration = 8m onu 84 MB'a indirdi.
# Oradaki enum WALK/BIKE'tır — "BICYCLE" yazılırsa OTP ayarı SESSİZCE yok
# sayar (yalnız bir WARN satırı düşer) ve graph yine şişer.
OTP_HEAP=${OTP_HEAP:-2g}
java -Xmx"$OTP_HEAP" -jar otp-shaded-2.8.1.jar --load . --port "$OTP_PORT" &
OTP_PID=$!

# Gözcü. Eskiden son satır "exec java ..." idi: Node çökerse konteyneri
# yeniden başlatan kimse yoktu, java ayakta olduğu sürece her şey sağlıklı
# görünüyordu — OTP'nin feed'leri sessizce boşalırdı. Artık ikisinden biri
# ölürse diğeri de durdurulur ve konteyner hata koduyla düşer; Railway'in
# restartPolicy'si (ON_FAILURE) devreye girer.
temizle() {
  kill "$NODE_PID" "$OTP_PID" 2>/dev/null || true
}
trap temizle TERM INT

while true; do
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "HATA: Node süreci öldü, OTP durduruluyor."
    kill "$OTP_PID" 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 "$OTP_PID" 2>/dev/null; then
    echo "HATA: OTP süreci öldü, Node durduruluyor."
    kill "$NODE_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 5
done
