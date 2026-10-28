const { env } = require('../config/env');

function saleTimeGuard(req, res, next) {
  const saleStartTime = new Date(env.SALE_START_TIME).getTime();
  const now = Date.now();

  if (now < saleStartTime) {
    const remainingMs = saleStartTime - now;
    const remainingSec = Math.ceil(remainingMs / 1000);

    res.status(403).json({
      error: 'SALE_NOT_STARTED',
      message: 'The flash sale has not started yet.',
      startsAt: env.SALE_START_TIME,
      startsInSeconds: remainingSec,
      serverTime: new Date().toISOString(),
    });
    return;
  }

  next();
}

module.exports = {
  saleTimeGuard,
};
