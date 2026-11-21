'use strict';

// Admin dashboard identity: Supabase Auth (GoTrue) over fetch, shared with the
// Jade Institutional project. Credentials, hashing, rate limits, and lockouts
// are owned by Supabase; this module performs the password grant, token
// verification, and the admin decision (email membership in ADMIN_EMAILS).
// The session rides as an httpOnly base64url cookie {a: accessToken, r: refreshToken}.

const COOKIE_NAME = 'erraza_admin_session';
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function authUrl(config) { return config.supabaseUrl; }
function authKey(config) { return config.supabaseAnonKey || config.supabaseKey; }

function authConfigured(config) {
  return Boolean(authUrl(config) && authKey(config));
}

function isAdminEmail(email, config) {
  return Boolean(email && (config.adminEmails || []).includes(String(email).toLowerCase()));
}

class GrantError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function passwordGrant(email, password, config, fetchImpl = fetch) {
  const response = await fetchImpl(`${authUrl(config)}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: authKey(config), Authorization: `Bearer ${authKey(config)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.access_token && body?.refresh_token) {
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresInSeconds: body.expires_in ?? 3600 };
  }
  if (response.status === 429) throw new GrantError(429, 'Too many attempts. Please wait a minute and try again.');
  throw new GrantError(400, 'Invalid email or password.');
}

async function refreshSession(refreshToken, config, fetchImpl = fetch) {
  const response = await fetchImpl(`${authUrl(config)}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: authKey(config), Authorization: `Bearer ${authKey(config)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.access_token && body?.refresh_token) {
    return { accessToken: body.access_token, refreshToken: body.refresh_token };
  }
  throw new GrantError(401, 'Session expired.');
}

const verificationCache = new Map();

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch { return null; }
}

async function verifyAccessToken(token, config, fetchImpl = fetch) {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp ? payload.exp * 1000 : 0;
  const cached = verificationCache.get(token);
  const now = Date.now();
  if (cached && cached.cachedUntil > now) return cached.state;
  if (exp && now > exp) return { ok: false, expired: true };
  try {
    const response = await fetchImpl(`${authUrl(config)}/auth/v1/user`, {
      headers: { apikey: authKey(config), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12000),
    });
    if (response.ok) {
      const user = await response.json().catch(() => null);
      const state = {
        ok: true, expired: false,
        userId: user?.id ?? payload?.sub,
        email: user?.email,
        emailVerified: Boolean(user?.email_confirmed_at || user?.confirmed_at),
      };
      verificationCache.set(token, { state, cachedUntil: exp ? Math.min(exp - 30000, now + 300000) : now + 300000 });
      return state;
    }
    const state = { ok: false, expired: Boolean(exp) };
    verificationCache.set(token, { state, cachedUntil: now + 60000 });
    return state;
  } catch {
    // Fail closed but allow refresh attempts.
    return { ok: false, expired: Boolean(exp) };
  }
}

async function globalLogout(accessToken, config, fetchImpl = fetch) {
  try {
    await fetchImpl(`${authUrl(config)}/auth/v1/logout?scope=global`, {
      method: 'POST',
      headers: { apikey: authKey(config), Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    // Best-effort; the cookie is cleared regardless.
  }
}

function encodeSessionCookie(accessToken, refreshToken) {
  return Buffer.from(JSON.stringify({ a: accessToken, r: refreshToken }), 'utf8').toString('base64url');
}

function decodeSessionCookie(raw) {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed.a === 'string' && typeof parsed.r === 'string') return parsed;
    return null;
  } catch { return null; }
}

function setAdminCookie(res, value, config) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${config.origin.startsWith('https:') ? '; Secure' : ''}`);
}

function clearAdminCookie(res, config) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.origin.startsWith('https:') ? '; Secure' : ''}`);
}

function readAdminCookie(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  const raw = cookies.map(entry => entry.trim()).find(entry => entry.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  return raw ? decodeSessionCookie(raw) : null;
}

// Password grant + admin email gate. Returns { ok, cookieValue } or throws
// GrantError-shaped { status, message } failures; rate limits live in Supabase.
async function attemptAdminLogin(email, password, config, fetchImpl = fetch) {
  if (!authConfigured(config)) throw new GrantError(503, 'Admin sign-in is not configured.');
  const grant = await passwordGrant(String(email).trim().toLowerCase(), password, config, fetchImpl);
  const verified = await verifyAccessToken(grant.accessToken, config, fetchImpl);
  if (!verified.ok) throw new GrantError(503, 'Admin sign-in could not be verified. Try again.');
  if (!isAdminEmail(verified.email, config)) {
    throw new GrantError(403, 'This account is not an Erraza administrator.');
  }
  return { ok: true, email: verified.email, cookieValue: encodeSessionCookie(grant.accessToken, grant.refreshToken) };
}

// Session check for admin routes. Returns { email } or null; refreshes
// silently and writes the refreshed cookie back when the access token expired.
async function getAdminSession(req, res, config, fetchImpl = fetch) {
  const parsed = readAdminCookie(req);
  if (!parsed) return null;
  const state = await verifyAccessToken(parsed.a, config, fetchImpl);
  if (state.ok) return isAdminEmail(state.email, config) ? { email: state.email } : null;
  if (state.expired) {
    let refreshed = null;
    try { refreshed = await refreshSession(parsed.r, config, fetchImpl); } catch { return null; }
    const reverified = await verifyAccessToken(refreshed.accessToken, config, fetchImpl);
    if (reverified.ok && isAdminEmail(reverified.email, config)) {
      setAdminCookie(res, encodeSessionCookie(refreshed.accessToken, refreshed.refreshToken), config);
      return { email: reverified.email };
    }
  }
  return null;
}

async function adminLogout(req, res, config, fetchImpl = fetch) {
  const parsed = readAdminCookie(req);
  if (parsed) await globalLogout(parsed.a, config, fetchImpl);
  clearAdminCookie(res, config);
}

function clearVerificationCache() {
  verificationCache.clear();
}

module.exports = {
  COOKIE_NAME, COOKIE_MAX_AGE_SECONDS, clearVerificationCache,
  authConfigured, isAdminEmail,
  attemptAdminLogin, getAdminSession, adminLogout,
  setAdminCookie, clearAdminCookie, encodeSessionCookie, decodeSessionCookie,
  GrantError,
};
