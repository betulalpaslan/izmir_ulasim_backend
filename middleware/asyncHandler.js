// Express 4, bir route handler'ın döndürdüğü reddedilmiş Promise'i GÖRMEZ.
// async bir handler throw ederse Express bundan habersiz kalır: yanıt hiç
// yazılmaz, istek istemci timeout'una kadar askıda durur. OTP'nin dakikada
// bir çeken updater'ı için bu, hata almaktan daha kötüdür — hata alsa eski
// veriyi korurdu, askıda kalınca updater thread'i boşuna bekler.
//
// Sarmalayıcı reddi yakalayıp next(err)'e verir; oradan errorHandler devralır.
// Amaç tek bir ucu kurtarmak değil, bu hata sınıfını yapısal olarak
// imkânsız kılmak: yeni bir async uç yazan kişi try/catch koymayı unutsa
// bile istek askıda kalmaz.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
