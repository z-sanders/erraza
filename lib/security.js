'use strict';

const { timingSafeEqual, createHmac, randomBytes } = require('node:crypto');

function equal(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function signToken(claims, purpose, config, ttlSeconds, issuedAt = Math.floor(Date.now() / 1000)) {
  if (config.checkoutSecret.length < 32) throw new Error('Checkout signing secret is not configured');
  const payload = Buffer.from(JSON.stringify({ ...claims, purpose, audience: config.origin, expires: issuedAt + ttlSeconds })).toString('base64url');
  const signature = createHmac('sha256', config.checkoutSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token, purpose, config) {
  if (typeof token !== 'string' || token.length > 2048 || config.checkoutSecret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const expected = createHmac('sha256', config.checkoutSecret).update(parts[0]).digest('base64url');
  if (!equal(expected, parts[1])) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (claims.purpose !== purpose || claims.audience !== config.origin || !Number.isSafeInteger(claims.expires) || claims.expires <= Date.now() / 1000) return null;
    return claims;
  } catch { return null; }
}

function session(req, res, config, create = false) {
  const name = config.origin.startsWith('https:') ? '__Host-erraza-session' : 'erraza-session';
  const cookies = String(req.headers.cookie || '').split(';');
  const value = cookies.map(entry => entry.trim()).find(entry => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  let claims = verifyToken(value, 'session', config);
  if (claims && /^[a-f0-9]{48}$/.test(claims.sid)) return claims.sid;
  if (!create) return null;
  const sid = randomBytes(24).toString('hex');
  const token = signToken({ sid }, 'session', config, 86400);
  res.setHeader('Set-Cookie', `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${config.origin.startsWith('https:') ? '; Secure' : ''}`);
  return sid;
}

function orderToken(orderId, config, createdAt) {
  const issuedAt = Math.floor(Date.parse(createdAt) / 1000);
  if (!Number.isSafeInteger(issuedAt)) throw new Error('Order creation time is invalid');
  return signToken({ orderId }, 'order', config, config.tokenTtlSeconds, issuedAt);
}

function digest(value, secret) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

module.exports = { equal, signToken, verifyToken, session, orderToken, digest };
