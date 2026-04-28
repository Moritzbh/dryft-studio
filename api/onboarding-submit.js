// ============================================================
//  BB Brands — Onboarding Submission Backend
//  Vercel Serverless Function (Node runtime)
//
//  Storage: Upstash Redis (reuses KV_REST_API_*)
//  Auth:    Customer Preview Token (Bearer) — same as /api/preview-auth verify
//
//  Endpoints:
//    POST   /api/onboarding-submit       (customer-authenticated)
//      Body: { brandSlug, answers: { ... } }
//      → stores submission, sends email + push notification
//    GET    /api/onboarding-submit       (admin-authenticated)
//      → list of all submissions
//
//  Required env vars:
//    KV_REST_API_URL, KV_REST_API_TOKEN
//    ADMIN_TOKEN
//    BB_PREVIEW_SECRET     — to verify customer tokens (HMAC)
//    RESEND_API_KEY        — optional, for email
//    NOTIFY_EMAIL          — optional, defaults to info@bb-brands.de
//    NOTIFY_FROM           — optional, defaults to "BB Brands Onboarding <onboarding@bb-brands.de>"
//    NTFY_TOPIC            — optional, for push notifications
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

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'info@bb-brands.de';
const NOTIFY_FROM = process.env.NOTIFY_FROM || 'BB Brands Onboarding <onboarding@bb-brands.de>';

const NTFY_TOPIC_RAW = process.env.NTFY_TOPIC || '';
const NTFY_TOPIC = NTFY_TOPIC_RAW
  .trim()
  .replace(/^https?:\/\/[^/]+\//, '')
  .replace(/^\/+/, '');
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, '');

const ONBOARDING_LIST_KEY = 'bb:onboarding:list';
const ONBOARDING_HASH_KEY = 'bb:onboarding:items';
const AUTH_COOKIE_NAME = 'bb_preview_auth';

function getCookieToken(req) {
  const raw = req.headers['cookie'] || '';
  if (!raw) return '';
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 0) continue;
    const k = parts[i].slice(0, eq).trim();
    if (k === AUTH_COOKIE_NAME) {
      try { return decodeURIComponent(parts[i].slice(eq + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

// ----- Redis helper -----------------------------------------
async function redis(...command) {
  if (!KV_URL || !KV_TOKEN) throw new Error('Redis not configured');
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.result;
}

// ----- HMAC token verification (matches /api/preview-auth) ----
function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function hmacB64url(payload) {
  if (!PREVIEW_SECRET) throw new Error('BB_PREVIEW_SECRET not set');
  return Buffer.from(crypto.createHmac('sha256', PREVIEW_SECRET).update(payload).digest())
    .toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  // HMAC is computed over the base64url-encoded payload (not decoded JSON)
  const expectedSig = hmacB64url(payloadB64);
  if (sigB64 !== expectedSig) return null;
  let data;
  try { data = JSON.parse(fromB64url(payloadB64).toString('utf-8')); } catch { return null; }
  if (!data || !data.slug || !data.exp) return null;
  if (Date.now() > data.exp) return null;
  return { slug: data.slug, expires: data.exp };
}

// ----- Validation -------------------------------------------
function str(v, max = 5000) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
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

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) reject(new Error('Payload too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ----- Email & Push -----------------------------------------
async function sendEmail(submission) {
  if (!RESEND_API_KEY) return { skipped: true };
  const { id, brandSlug, brandName, answers, submittedBy, submittedAt } = submission;

  const md = formatAnswersMarkdown(submission);
  const html = formatAnswersHtml(submission);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: [NOTIFY_EMAIL],
        reply_to: submittedBy && submittedBy.email ? submittedBy.email : undefined,
        subject: `🏁 Onboarding eingereicht — ${brandName || brandSlug}`,
        html,
        text: md,
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendPush(submission) {
  if (!NTFY_TOPIC) return { skipped: true };
  try {
    const url = `${NTFY_SERVER}/${NTFY_TOPIC}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Title': `Onboarding eingereicht: ${submission.brandName || submission.brandSlug}`,
        'Priority': 'high',
        'Tags': 'rocket,onboarding',
        'Click': `https://www.bb-brands.de/admin?focus=onboarding-${submission.id}`,
      },
      body: `${submission.submittedBy?.name || submission.brandSlug} hat den Onboarding-Fragebogen eingereicht.`,
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ----- Format helpers ---------------------------------------
function formatAnswersMarkdown(s) {
  const a = s.answers || {};
  const date = new Date(s.submittedAt).toLocaleString('de-DE');
  let md = `# ${s.brandName || s.brandSlug} — Onboarding-Antworten\n_${date}_\n\n`;
  if (s.submittedBy) md += `**Von:** ${s.submittedBy.name || ''} ${s.submittedBy.email ? `<${s.submittedBy.email}>` : ''}\n\n`;
  md += `---\n\n`;
  for (const [key, value] of Object.entries(a)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    md += `**${label}:** ${value || '–'}\n\n`;
  }
  return md;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function formatAnswersHtml(s) {
  const a = s.answers || {};
  const date = new Date(s.submittedAt).toLocaleString('de-DE');
  let html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#FAFAFB;padding:24px;color:#0A0A0A">`;
  html += `<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:14px;padding:32px 28px;box-shadow:0 8px 24px rgba(3,5,198,0.08)">`;
  html += `<div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#0305C6;margin-bottom:8px">✦ Onboarding eingereicht</div>`;
  html += `<h1 style="font-size:26px;font-weight:800;margin-bottom:6px;letter-spacing:-0.5px">${escapeHtml(s.brandName || s.brandSlug)}</h1>`;
  html += `<p style="color:#6B7280;font-size:13px;margin-bottom:24px">${escapeHtml(date)}${s.submittedBy ? ` · ${escapeHtml(s.submittedBy.name || '')}${s.submittedBy.email ? ` &lt;${escapeHtml(s.submittedBy.email)}&gt;` : ''}` : ''}</p>`;
  html += `<table style="width:100%;border-collapse:collapse">`;
  for (const [key, value] of Object.entries(a)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    html += `<tr><td style="padding:12px 0;border-bottom:1px solid #E5E7EB;font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;width:34%;vertical-align:top">${escapeHtml(label)}</td>`;
    html += `<td style="padding:12px 0;border-bottom:1px solid #E5E7EB;font-size:14px;color:#0A0A0A;vertical-align:top;white-space:pre-wrap">${escapeHtml(value || '–')}</td></tr>`;
  }
  html += `</table>`;
  html += `<p style="margin-top:24px;font-size:12px;color:#9CA3AF">Submission-ID: <code>${escapeHtml(s.id)}</code></p>`;
  html += `</div></body></html>`;
  return html;
}

// ----- Handler ----------------------------------------------
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  try {
    // ============ POST: customer submits onboarding ============
    if (req.method === 'POST') {
      // Cookie first (browser flow), Bearer fallback (CLI/scripts)
      const cookieTok = getCookieToken(req);
      const bearerTok = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      const auth = cookieTok || bearerTok;
      const tokenInfo = verifyToken(auth);
      if (!tokenInfo) return jsonResponse(res, 401, { ok: false, error: 'invalid token' });

      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = body ? JSON.parse(body) : await readBody(req); } catch { body = await readBody(req); }
      }
      body = body || {};

      const brandSlug = str(body.brandSlug, 80) || tokenInfo.slug;
      // Token must match brand
      if (brandSlug !== tokenInfo.slug) {
        return jsonResponse(res, 403, { ok: false, error: 'token-brand mismatch' });
      }

      const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
      // Sanitize each value
      const cleanAnswers = {};
      for (const [k, v] of Object.entries(answers)) {
        if (typeof k !== 'string' || k.length > 80) continue;
        if (Array.isArray(v)) cleanAnswers[k] = v.map(x => str(String(x), 500)).join(', ');
        else cleanAnswers[k] = str(String(v ?? ''), 5000);
      }

      // Brand name lookup (best effort)
      let brandName = str(body.brandName, 200);
      if (!brandName) {
        try {
          const brandRaw = await redis('HGET', `bb:preview:brand:${brandSlug}`, 'data');
          if (brandRaw) {
            const b = JSON.parse(brandRaw);
            brandName = b.name || brandSlug;
          }
        } catch {}
      }

      const submission = {
        id: `${brandSlug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        brandSlug,
        brandName: brandName || brandSlug,
        answers: cleanAnswers,
        submittedBy: {
          name: str(body.submittedByName, 120),
          email: str(body.submittedByEmail, 200),
        },
        submittedAt: new Date().toISOString(),
        userAgent: str(req.headers['user-agent'] || '', 300),
        ip: str(req.headers['x-forwarded-for'] || '', 100).split(',')[0].trim(),
      };

      // Store
      await redis('HSET', ONBOARDING_HASH_KEY, submission.id, JSON.stringify(submission));
      await redis('LPUSH', ONBOARDING_LIST_KEY, submission.id);
      await redis('LTRIM', ONBOARDING_LIST_KEY, 0, 999);

      // Notify (best-effort, don't block on failures)
      const [emailRes, pushRes] = await Promise.all([
        sendEmail(submission).catch(e => ({ ok: false, error: e.message })),
        sendPush(submission).catch(e => ({ ok: false, error: e.message })),
      ]);

      return jsonResponse(res, 200, {
        ok: true,
        id: submission.id,
        notify: { email: emailRes, push: pushRes },
      });
    }

    // ============ GET: admin list ============
    if (req.method === 'GET') {
      if (!checkAdmin(req)) return jsonResponse(res, 401, { ok: false, error: 'admin token required' });

      const ids = (await redis('LRANGE', ONBOARDING_LIST_KEY, 0, -1)) || [];
      if (!ids.length) return jsonResponse(res, 200, { ok: true, items: [] });

      const raws = await redis('HMGET', ONBOARDING_HASH_KEY, ...ids);
      const items = (raws || [])
        .map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
        .filter(Boolean);

      return jsonResponse(res, 200, { ok: true, items });
    }

    return jsonResponse(res, 405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[onboarding-submit]', e);
    return jsonResponse(res, 500, { ok: false, error: e.message });
  }
};
