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

// Email notifications (optional — runs only if RESEND_API_KEY is set)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'info@bb-brands.de';
const NOTIFY_FROM = process.env.NOTIFY_FROM || 'BB Brands Lead <leads@bb-brands.de>';

const HASH_KEY = 'bb:leads';

const PAIN_LABELS = {
  branding: 'Brand & Identity',
  shop: 'Shopify Store & CVR',
  ads: 'Meta & Performance Ads',
  ai: 'KI im Store & Support',
};

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

      const magnet = str(body.magnet, 40) || 'style-guide';
      const isWhatsAppFunnel = magnet === 'whatsapp-chat';

      // ========== WHATSAPP CHAT FUNNEL ==========
      if (isWhatsAppFunnel) {
        const lead = {
          magnet: 'whatsapp-chat',
          name: str(body.name, 120),
          brand: str(body.brand, 200),
          website: str(body.website, 300),
          pain: ['branding', 'shop', 'ads', 'ai'].includes(body.pain) ? body.pain : '',
          context: str(body.context, 1000),
          phone: str(body.phone, 60),
          source: str(body.source, 60) || 'unknown',
          consentChat: body.consentChat === true || body.consentChat === 'true' || body.consentChat === 'on',
        };

        const errors = {};
        if (!lead.name) errors.name = 'Name fehlt';
        if (!lead.brand) errors.brand = 'Marke fehlt';
        if (!lead.website || !isUrl(lead.website)) errors.website = 'Webseite ungültig';
        if (!lead.pain) errors.pain = 'Engpass nicht ausgewählt';
        if (!lead.phone || lead.phone.replace(/\D/g, '').length < 6) errors.phone = 'Telefon ungültig';
        if (!lead.consentChat) errors.consentChat = 'Einwilligung erforderlich';
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
          consentChatAt: now,
          ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
          userAgent: str(req.headers['user-agent'] || '', 300),
        };

        await redis('HSET', HASH_KEY, id, JSON.stringify(record));

        // Fire-and-forget email notification (don't block response on failure)
        sendWhatsAppLeadEmail(record).catch((err) =>
          console.error('[/api/leads] email notify failed:', err)
        );

        return jsonResponse(res, 200, { ok: true, id });
      }

      // ========== EXISTING LEAD MAGNETS (style-guide / ai-readiness-check) ==========
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
        magnet,
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

// ----- WhatsApp lead email notifier (Resend API, optional) -----
async function sendWhatsAppLeadEmail(record) {
  if (!RESEND_API_KEY) {
    console.log('[/api/leads] RESEND_API_KEY not set — skipping email notification');
    return;
  }
  const painLabel = PAIN_LABELS[record.pain] || record.pain;
  const subject = `WhatsApp-Lead · ${record.brand} · ${painLabel}`;
  const escapeHtml = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0B0B12;">
      <div style="display:inline-block;padding:6px 14px;border-radius:999px;background:#25D366;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:16px;">Neuer WhatsApp-Lead</div>
      <h2 style="font-size:22px;margin:0 0 6px;font-weight:700;letter-spacing:-0.6px;">${escapeHtml(record.name)} · ${escapeHtml(record.brand)}</h2>
      <p style="margin:0 0 20px;color:#55555C;font-size:14px;">Quelle: ${escapeHtml(record.source)} · ${new Date(record.createdAt).toLocaleString('de-DE')}</p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:8px 0;color:#8C8C95;width:120px;">Engpass</td><td style="padding:8px 0;font-weight:600;">${escapeHtml(painLabel)}</td></tr>
        <tr><td style="padding:8px 0;color:#8C8C95;">Webseite</td><td style="padding:8px 0;"><a href="${escapeHtml(record.website)}" style="color:#0305C6;">${escapeHtml(record.website)}</a></td></tr>
        <tr><td style="padding:8px 0;color:#8C8C95;">WhatsApp</td><td style="padding:8px 0;"><a href="https://wa.me/${escapeHtml((record.phone || '').replace(/\D/g, ''))}" style="color:#25D366;font-weight:600;">${escapeHtml(record.phone)}</a></td></tr>
        ${record.context ? `<tr><td style="padding:8px 0;color:#8C8C95;vertical-align:top;">Kontext</td><td style="padding:8px 0;">${escapeHtml(record.context)}</td></tr>` : ''}
      </table>

      <div style="margin-top:24px;padding:14px 18px;background:#F4F4FF;border-radius:12px;font-size:13px;color:#55555C;">
        Lead-ID: <code style="font-family:monospace;">${escapeHtml(record.id)}</code><br>
        Im Admin-Dashboard: <a href="https://bb-brands.de/admin" style="color:#0305C6;">bb-brands.de/admin</a>
      </div>
    </div>
  `;

  const text = [
    `Neuer WhatsApp-Lead`,
    ``,
    `Name: ${record.name}`,
    `Marke: ${record.brand}`,
    `Webseite: ${record.website}`,
    `Engpass: ${painLabel}`,
    `WhatsApp: ${record.phone}`,
    record.context ? `Kontext: ${record.context}` : null,
    `Quelle: ${record.source}`,
    `Zeit: ${new Date(record.createdAt).toLocaleString('de-DE')}`,
    ``,
    `Lead-ID: ${record.id}`,
    `Admin: https://bb-brands.de/admin`,
  ].filter(Boolean).join('\n');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: [NOTIFY_EMAIL],
      reply_to: `https://wa.me/${(record.phone || '').replace(/\D/g, '')}`,
      subject,
      html,
      text,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend ${resp.status}: ${errText}`);
  }
}

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
