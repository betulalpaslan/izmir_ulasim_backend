#!/bin/sh
# Node.js önce başlasın — GBFS feed'i OTP'den önce hazır olmalı
node server.js &

echo "Node.js başlatılıyor, 15 saniye bekleniyor..."
sleep 15

echo "OTP başlatılıyor..."
exec java -Xmx1g -jar otp-shaded-2.8.1.jar --load . --port 8080
