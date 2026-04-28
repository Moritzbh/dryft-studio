// ============================================================
//  BB Brands — Customer-Preview Auth Backend
//  Vercel Serverless Function (Node runtime)
//
//  Storage: Upstash Redis (reuses existing KV_REST_API_*)
//  Token format: base64url(slug.expires).HMAC-SHA256(slug.expires, BB_PREVIEW_SECRET)
//
//  Endpoints:
//    POST /api/preview-auth { action: 'login', slug, password }
//      → { ok: true, token, brand: { name, slug, pages } }
//    GET  /api/preview-auth?action=verify
//         Authorization: Bearer <token>
//      → { ok: true, brand: { name, slug, pages } }
//    POST /api/preview-auth { action: 'register', slug, password, name, page }
//         Authorization: Bearer <ADMIN_TOKEN>
//      → { ok: true, brand }   // creates brand if missing, adds page
//    POST /api/preview-auth { action: 'add-page', slug, page }
//         Authorization: Bearer <ADMIN_TOKEN>
//      → { ok: true, brand }
//
//  Required env vars:
//    KV_REST_API_URL, KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_*)
//    ADMIN_TOKEN                          (existing, used for register/add-page)
//    BB_PREVIEW_SECRET                    (NEW — random 32+ chars for HMAC)
// ============================================================

const crypto = require('crypto');

const KV_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  '';
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PREVIEW_SECRET = process.env.BB_PREVIEW_SECRET || '';

const BRAND_KEY_PREFIX = 'bb:preview:brand:';
const RATE_KEY_PREFIX = 'bb:preview:rate:';
const TOKEN_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000; // 14 days (war 30, gekürzt für Security)
const RATE_WINDOW_SEC = 60;          // 1 min sliding window
const RATE_MAX_ATTEMPTS = 5;         // 5 Login-Versuche pro Min pro IP+slug-Kombi

// ---------- Redis helper ----------
async function redis(...command) {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error('Redis not configured (missing env vars)');
  }
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.result;
}

// ---------- HMAC helpers ----------
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function hmac(payload) {
  if (!PREVIEW_SECRET) throw new Error('BB_PREVIEW_SECRET env-var not configured');
  return b64url(crypto.createHmac('sha256', PREVIEW_SECRET).update(payload).digest());
}
function passwordHash(password) {
  if (!PREVIEW_SECRET) throw new Error('BB_PREVIEW_SECRET env-var not configured');
  return crypto.createHmac('sha256', PREVIEW_SECRET).update('pw:' + password).digest('hex');
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function makeToken(slug) {
  const expires = Date.now() + TOKEN_VALIDITY_MS;
  const payload = b64url(JSON.stringify({ slug, exp: expires }));
  const sig = hmac(payload);
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  let expectedSig;
  try {
    expectedSig = hmac(payload);
  } catch {
    return null;
  }
  if (!timingSafeEqual(sig, expectedSig)) return null;
  let data;
  try {
    data = JSON.parse(fromB64url(payload).toString('utf-8'));
  } catch {
    return null;
  }
  if (!data || !data.slug || !data.exp) return null;
  if (Date.now() > data.exp) return null;
  return { slug: data.slug, expires: data.exp };
}

// ---------- Rate-Limiter (per IP + slug pair) ----------
// Sliding-Window via Redis INCR + EXPIRE. Returns { ok, remaining, retryAfterSec }.
async function checkAndConsumeRate(ip, slug) {
  if (!ip || !slug) return { ok: true, remaining: RATE_MAX_ATTEMPTS };
  const safeIp = ip.replace(/[^a-fA-F0-9.:]/g, '').slice(0, 45);
  const safeSlug = slug.replace(/[^a-z0-9-]/g, '').slice(0, 60);
  const key = `${RATE_KEY_PREFIX}${safeIp}:${safeSlug}`;
  try {
    const count = await redis('INCR', key);
    if (count === 1) {
      // First hit in window — set expiry
      await redis('EXPIRE', key, RATE_WINDOW_SEC);
    }
    if (count > RATE_MAX_ATTEMPTS) {
      const ttl = await redis('TTL', key);
      return { ok: false, retryAfterSec: ttl > 0 ? ttl : RATE_WINDOW_SEC };
    }
    return { ok: true, remaining: RATE_MAX_ATTEMPTS - count };
  } catch (e) {
    // Fail-open: rate-limiter outage darf nicht den login blocken
    console.error('[rate-limit] error:', e.message);
    return { ok: true, remaining: RATE_MAX_ATTEMPTS };
  }
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  return (xff.split(',')[0] || req.socket?.remoteAddress || '').trim();
}

// ---------- Brand storage ----------
async function getBrand(slug) {
  const raw = await redis('GET', BRAND_KEY_PREFIX + slug);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function setBrand(slug, brand) {
  await redis('SET', BRAND_KEY_PREFIX + slug, JSON.stringify(brand));
}

// ---------- Validation ----------
function str(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}
function isValidSlug(s) {
  return /^[a-z0-9][a-z0-9-]{1,40}$/i.test(s);
}

function checkAdmin(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return ADMIN_TOKEN && token && timingSafeEqual(token, ADMIN_TOKEN);
}

function getBearerToken(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

// ---------- Cookie helpers (HttpOnly auth — XSS-safe) ----------
const AUTH_COOKIE_NAME = 'bb_preview_auth';

function getCookieToken(req) {
  const raw = req.headers['cookie'] || '';
  if (!raw) return '';
  const parts = raw.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === AUTH_COOKIE_NAME) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return '';
}

// Prefer Cookie, fallback to Bearer (für CLI/Skripte)
function getAuthToken(req) {
  return getCookieToken(req) || getBearerToken(req);
}

function setAuthCookie(res, token, maxAgeSec) {
  // Domain=.bb-brands.de → Cookie gilt für www. UND apex (kein Verlust bei Domain-Switch)
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'Domain=.bb-brands.de',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res) {
  // Killt BEIDE Cookie-Varianten: alte ohne Domain-Spec (nur www.) + neue mit
  // Domain=.bb-brands.de. Sonst bleibt alter Cookie kleben weil Browser beide
  // als getrennte Cookies sieht.
  res.setHeader('Set-Cookie', [
    `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${AUTH_COOKIE_NAME}=; Path=/; Domain=.bb-brands.de; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ]);
}

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function publicBrand(brand) {
  return {
    name: brand.name,
    slug: brand.slug,
    token: brand.token,
    phase: brand.phase || null,
    pages: brand.pages || [],
  };
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (!PREVIEW_SECRET) {
    return jsonResponse(res, 503, {
      ok: false,
      error: 'BB_PREVIEW_SECRET not configured. Set it in Vercel project env vars.',
    });
  }

  try {
    // ===== GET ?action=verify (with bearer token) =====
    if (req.method === 'GET') {
      const url = new URL(req.url, 'https://x');
      const action = url.searchParams.get('action');

      if (action === 'verify') {
        // Cookie zuerst (UI-Flow), dann Bearer (CLI/Skripte)
        const token = getAuthToken(req);
        const data = verifyToken(token);
        if (!data) return jsonResponse(res, 401, { ok: false, error: 'invalid or expired token' });
        const brand = await getBrand(data.slug);
        if (!brand) return jsonResponse(res, 404, { ok: false, error: 'brand no longer exists' });
        return jsonResponse(res, 200, { ok: true, brand: publicBrand(brand) });
      }

      return jsonResponse(res, 400, { ok: false, error: 'unknown action' });
    }

    // ===== POST: login | register | add-page =====
    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = body ? JSON.parse(body) : await readBody(req); }
        catch { body = await readBody(req); }
      }
      body = body || {};
      const action = str(body.action, 40);

      // ----- login -----
      if (action === 'login') {
        const slug = str(body.slug, 60).toLowerCase();
        const password = str(body.password, 200);
        if (!isValidSlug(slug) || !password) {
          return jsonResponse(res, 400, { ok: false, error: 'slug or password invalid' });
        }

        // Rate-Limiter: 5 Versuche/Min pro IP+slug-Kombi (Brute-Force-Protection)
        const ip = getClientIp(req);
        const rate = await checkAndConsumeRate(ip, slug);
        if (!rate.ok) {
          res.setHeader('Retry-After', String(rate.retryAfterSec));
          return jsonResponse(res, 429, {
            ok: false,
            error: 'too many attempts',
            retryAfterSec: rate.retryAfterSec,
          });
        }

        const brand = await getBrand(slug);
        if (!brand) return jsonResponse(res, 401, { ok: false, error: 'wrong slug or password' });

        const expectedHash = brand.password_hash;
        const givenHash = passwordHash(password);
        if (!expectedHash || !timingSafeEqual(givenHash, expectedHash)) {
          return jsonResponse(res, 401, { ok: false, error: 'wrong slug or password' });
        }

        const token = makeToken(slug);
        // HttpOnly-Cookie setzen (XSS-safe — JS kommt nicht ran)
        setAuthCookie(res, token, Math.floor(TOKEN_VALIDITY_MS / 1000));
        return jsonResponse(res, 200, {
          ok: true,
          // token wird auch im Body returned als Fallback für CLI-Tools (Bearer)
          token,
          brand: publicBrand(brand),
        });
      }

      // ----- register (admin only) -----
      if (action === 'register') {
        if (!checkAdmin(req)) return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
        const slug = str(body.slug, 60).toLowerCase();
        const password = str(body.password, 200);
        const name = str(body.name, 200) || slug;
        const token = str(body.token, 40);
        if (!isValidSlug(slug) || !password) {
          return jsonResponse(res, 400, { ok: false, error: 'slug or password invalid' });
        }
        const existing = await getBrand(slug);
        const brand = existing || {
          slug,
          name,
          token: token || null,
          pages: [],
          created_at: new Date().toISOString(),
        };
        brand.password_hash = passwordHash(password);
        brand.name = name;
        if (token) brand.token = token;
        brand.updated_at = new Date().toISOString();

        // optionally add a page in the same call
        const page = body.page;
        if (page && typeof page === 'object' && page.key) {
          // Status preserve wenn page bereits existiert (z.B. 'approved' bleibt approved auch nach redeploy)
          const existingPage = (brand.pages || []).find(p => p.key === page.key);
          const preservedStatus = existingPage?.status || 'review';
          brand.pages = (brand.pages || []).filter(p => p.key !== page.key);
          brand.pages.push({
            key: str(page.key, 80),
            label: str(page.label, 200) || page.key,
            url_path: str(page.url_path, 300) || '',
            status: preservedStatus,  // default 'review' für frisch deployed pages
            deployed_at: new Date().toISOString(),
          });
        }
        await setBrand(slug, brand);
        return jsonResponse(res, 200, { ok: true, brand: publicBrand(brand) });
      }

      // ----- logout (clears cookie) -----
      if (action === 'logout') {
        clearAuthCookie(res);
        return jsonResponse(res, 200, { ok: true });
      }

      // ----- set-phase (admin only) -----
      // Stages (v2): brief_plan, build_review, launch, live
      // Legacy (v1) accepted for backwards compat: onboarding, plan, setup, build, review
      if (action === 'set-phase') {
        if (!checkAdmin(req)) return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
        const slug = str(body.slug, 60).toLowerCase();
        const phase = str(body.phase, 40);
        const VALID_PHASES = [
          'brief_plan', 'build_review', 'launch', 'live',          // v2
          'onboarding', 'plan', 'setup', 'build', 'review',        // v1 legacy
        ];
        if (!isValidSlug(slug) || !VALID_PHASES.includes(phase)) {
          return jsonResponse(res, 400, { ok: false, error: 'slug or phase invalid' });
        }
        const brand = await getBrand(slug);
        if (!brand) return jsonResponse(res, 404, { ok: false, error: 'brand not found' });
        brand.phase = phase;
        brand.phase_set_at = new Date().toISOString();
        brand.updated_at = new Date().toISOString();
        await setBrand(slug, brand);
        return jsonResponse(res, 200, { ok: true, brand: publicBrand(brand) });
      }

      // ----- set-page-status (admin only) -----
      // Status: building, review, approved, change_request
      if (action === 'set-page-status') {
        if (!checkAdmin(req)) return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
        const slug = str(body.slug, 60).toLowerCase();
        const pageKey = str(body.page_key, 80);
        const status = str(body.status, 40);
        const VALID_STATUS = ['building', 'review', 'approved', 'change_request'];
        if (!isValidSlug(slug) || !pageKey || !VALID_STATUS.includes(status)) {
          return jsonResponse(res, 400, { ok: false, error: 'slug, page_key, or status invalid' });
        }
        const brand = await getBrand(slug);
        if (!brand) return jsonResponse(res, 404, { ok: false, error: 'brand not found' });
        brand.pages = (brand.pages || []).map(p => {
          if (p.key === pageKey) {
            return { ...p, status, status_set_at: new Date().toISOString() };
          }
          return p;
        });
        brand.updated_at = new Date().toISOString();
        await setBrand(slug, brand);
        return jsonResponse(res, 200, { ok: true, brand: publicBrand(brand) });
      }

      // ----- add-page (admin only) -----
      if (action === 'add-page') {
        if (!checkAdmin(req)) return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
        const slug = str(body.slug, 60).toLowerCase();
        const page = body.page;
        if (!isValidSlug(slug) || !page || !page.key) {
          return jsonResponse(res, 400, { ok: false, error: 'slug or page invalid' });
        }
        const brand = await getBrand(slug);
        if (!brand) return jsonResponse(res, 404, { ok: false, error: 'brand not found' });
        const existingPage = (brand.pages || []).find(p => p.key === page.key);
        const preservedStatus = existingPage?.status || 'review';
        brand.pages = (brand.pages || []).filter(p => p.key !== page.key);
        brand.pages.push({
          key: str(page.key, 80),
          label: str(page.label, 200) || page.key,
          url_path: str(page.url_path, 300) || '',
          status: preservedStatus,
          deployed_at: new Date().toISOString(),
        });
        brand.updated_at = new Date().toISOString();
        await setBrand(slug, brand);
        return jsonResponse(res, 200, { ok: true, brand: publicBrand(brand) });
      }

      return jsonResponse(res, 400, { ok: false, error: 'unknown action' });
    }

    return jsonResponse(res, 405, { ok: false, error: 'method not allowed' });
  } catch (err) {
    console.error('[/api/preview-auth] error:', err);
    return jsonResponse(res, 500, { ok: false, error: err.message || 'server error' });
  }
};

// ----- raw body reader -----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) {
        try {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [k, v] of params) obj[k] = v;
          resolve(obj);
        } catch { reject(e); }
      }
    });
    req.on('error', reject);
  });
}
