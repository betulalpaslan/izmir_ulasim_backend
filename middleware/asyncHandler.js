
// Sarmalayıcı reddi yakalayıp next(err)'e verir; oradan errorHandler devralır.
// Amaç tek bir ucu kurtarmak değil, bu hata sınıfını yapısal olarak
// imkânsız kılmak: yeni bir async uç yazan kişi try/catch koymayı unutsa
// bile istek askıda kalmaz.
const asyncHandler = (fn) => (req, res, next) => {
  try {
    // Asıl iş: reddedilen Promise → next(err)
    return Promise.resolve(fn(req, res, next)).catch(next);
  } catch (err) {
    next(err);
  }
};

module.exports = asyncHandler;
