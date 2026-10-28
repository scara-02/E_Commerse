const https = require('https');
const { env } = require('../config/env');

/**
 * Validates Cloudflare Turnstile token against Cloudflare's siteverify API.
 * Uses official testing keys in dev/test, and official API in production.
 */
async function verifyTurnstileToken(token, remoteIp) {
  // If Turnstile is disabled (e.g. in local development when configured off), allow pass-through
  if (!env.TURNSTILE_ENABLED) {
    return { success: true, bypassed: true };
  }

  if (!token) {
    return { success: false, error: 'MISSING_TURNSTILE_TOKEN' };
  }

  return new Promise((resolve) => {
    const postData = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: remoteIp || '',
    }).toString();

    const options = {
      hostname: 'challenges.cloudflare.com',
      port: 443,
      path: '/turnstile/v0/siteverify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 3000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.success === true) {
            resolve({ success: true, details: result });
          } else {
            console.warn('[Turnstile] Verification failed by Cloudflare:', result['error-codes']);
            resolve({ success: false, errorCodes: result['error-codes'] });
          }
        } catch (err) {
          console.error('[Turnstile] Failed to parse Cloudflare response:', err);
          resolve({ success: false, error: 'PARSE_ERROR' });
        }
      });
    });

    req.on('error', (err) => {
      console.warn('[Turnstile] Cloudflare network error:', err.message);
      // In development fail-open; in strict production fail-closed
      resolve({ success: env.NODE_ENV !== 'production', error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn('[Turnstile] Cloudflare verification timed out');
      resolve({ success: env.NODE_ENV !== 'production', error: 'TIMEOUT' });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Express middleware to enforce Cloudflare Turnstile bot verification
 * on the checkout hot path before reaching business logic.
 */
async function turnstileGuard(req, res, next) {
  const token =
    req.body['cf-turnstile-response'] ||
    req.headers['cf-turnstile-response'] ||
    req.body.turnstileToken ||
    req.headers['x-turnstile-token'];

  const remoteIp = req.ip || req.socket.remoteAddress;

  const result = await verifyTurnstileToken(token, remoteIp);

  if (!result.success) {
    return res.status(403).json({
      error: 'BOT_CHALLENGE_FAILED',
      message: 'Bot verification challenge failed or missing. Please complete Turnstile verification.',
      details: result.errorCodes || result.error,
    });
  }

  req.turnstileVerified = true;
  next();
}

module.exports = {
  turnstileGuard,
  verifyTurnstileToken,
};

