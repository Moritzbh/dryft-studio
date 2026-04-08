// ============================================================
//  BB Brands — Lead Magnet Backend
//  Vercel Serverless Function (Node runtime)
//
//  Storage: Upstash Redis (via REST API, no SDK needed)
//  Works with either env var pair:
//    - KV_REST_API_URL + KV_REST_API_TOKEN  (Vercel KV / Marketplace)
//    - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (Upstash direct)
//
//  Endpoints:
//    POST   /api/leads          → store new lead (public)
//    GET    /api/leads          → list all leads (admin token required)
//    PATCH  /api/leads          → update status  (admin token required)
//    DELETE /api/leads          → delete lead    (admin token required)
//
//  Required env vars:
//    KV_REST_API_URL (or UPSTASH_REDIS_REST_URL)
//    KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_TOKEN)
//    ADMIN_TOKEN  → secret for /admin dashboard
// ============================================================

const KV_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  '';
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const HASH_KEY = 'bb:leads';

// ----- Redis helper (single REST call) ----------------------
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

// ----- Validation helpers -----------------------------------
function str(v, max = 500) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isUrl(s) {
  try {
    const u = new URL(s.startsWith('http') ? s : 'https://' + s);
    return !!u.host;
  } catch {
    return false;
  }
}

function checkAdmin(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return ADMIN_TOKEN && token && token === ADMIN_TOKEN;
}

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// ----- Handler ----------------------------------------------
module.exports = async function handler(req, res) {
  // CORS: allow same-origin only by default; allow cross-origin GET preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    // ============ POST: create lead ============
    if (req.method === 'POST') {
      // Body parsing (Vercel doesn't always parse JSON automatically)
      let body = req.body;
      if (!body || typeof body === 'string') {
        try {
          body = body ? JSON.parse(body) : await readBody(req);
        } catch {
          body = await readBody(req);
        }
      }
      body = body || {};

      // Honeypot
      if (body._gotcha) {
        return jsonResponse(res, 200, { ok: true });
      }

      const lead = {
        name: str(body.name, 120),
        company: str(body.company, 200),
        website: str(body.website, 300),
        email: str(body.email, 200),
        phone: str(body.phone, 60),
        delivery: body.delivery === 'whatsapp' ? 'whatsapp' : 'email',
        consentGuide: body.consentGuide === true || body.consentGuide === 'true' || body.consentGuide === 'on',
        consentReference: body.consentReference === true || body.consentReference === 'true' || body.consentReference === 'on',
      };

      // Validation
      const errors = {};
      if (!lead.name) errors.name = 'Name fehlt';
      if (!lead.company) errors.company = 'Unternehmen fehlt';
      if (!lead.website || !isUrl(lead.website)) errors.website = 'Webseite ungültig';
      if (!lead.email || !isEmail(lead.email)) errors.email = 'E-Mail ungültig';
      if (lead.delivery === 'whatsapp' && !lead.phone) errors.phone = 'Telefon nötig für WhatsApp';
      if (!lead.consentGuide) errors.consentGuide = 'Einwilligung zur Datenverarbeitung erforderlich';
      if (Object.keys(errors).length) {
        return jsonResponse(res, 400, { ok: false, errors });
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const record = {
        id,
        ...lead,
        status: 'new',
        createdAt: now,
        deliveredAt: null,
        // GDPR consent audit trail (Art. 7 Abs. 1 DSGVO — Nachweispflicht)
        consentGuideAt: lead.consentGuide ? now : null,
        consentReferenceAt: lead.consentReference ? now : null,
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
        userAgent: str(req.headers['user-agent'] || '', 300),
      };

      await redis('HSET', HASH_KEY, id, JSON.stringify(record));

      return jsonResponse(res, 200, { ok: true, id });
    }

    // ============ GET: list leads (admin) ============
    if (req.method === 'GET') {
      if (!checkAdmin(req)) {
        return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
      }
      const all = (await redis('HGETALL', HASH_KEY)) || [];
      // HGETALL returns [field, value, field, value, ...]
      const leads = [];
      for (let i = 0; i < all.length; i += 2) {
        try {
          leads.push(JSON.parse(all[i + 1]));
        } catch {
          // skip corrupted
        }
      }
      leads.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return jsonResponse(res, 200, { ok: true, leads, count: leads.length });
    }

    // ============ PATCH: update status (admin) ============
    if (req.method === 'PATCH') {
      if (!checkAdmin(req)) {
        return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
      }
      const body = req.body || (await readJsonBody(req));
      const id = str(body.id, 80);
      const status = ['new', 'in-progress', 'delivered'].includes(body.status)
        ? body.status
        : null;
      if (!id || !status) {
        return jsonResponse(res, 400, { ok: false, error: 'invalid input' });
      }
      const existing = await redis('HGET', HASH_KEY, id);
      if (!existing) return jsonResponse(res, 404, { ok: false, error: 'not found' });
      const record = JSON.parse(existing);
      record.status = status;
      record.deliveredAt = status === 'delivered' ? new Date().toISOString() : null;
      await redis('HSET', HASH_KEY, id, JSON.stringify(record));
      return jsonResponse(res, 200, { ok: true, lead: record });
    }

    // ============ DELETE: remove lead (admin) ============
    if (req.method === 'DELETE') {
      if (!checkAdmin(req)) {
        return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
      }
      const body = req.body || (await readJsonBody(req));
      const id = str(body.id, 80);
      if (!id) return jsonResponse(res, 400, { ok: false, error: 'invalid input' });
      await redis('HDEL', HASH_KEY, id);
      return jsonResponse(res, 200, { ok: true });
    }

    return jsonResponse(res, 405, { ok: false, error: 'method not allowed' });
  } catch (err) {
    console.error('[/api/leads] error:', err);
    return jsonResponse(res, 500, { ok: false, error: 'server error' });
  }
};

// ----- raw body reader (fallback for when Vercel doesn't parse) -----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        // also accept x-www-form-urlencoded
        try {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [k, v] of params) obj[k] = v;
          resolve(obj);
        } catch {
          reject(e);
        }
      }
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const b = await readBody(req);
  return b || {};
}
