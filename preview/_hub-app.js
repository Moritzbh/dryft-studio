/* ============================================================
   BB Brands · Customer-Hub — Shared App Logic
   Single-Source-of-Truth für alle Brand-Hubs.
   Update hier = Update für ALLE Brands.

   Erwartet im HTML-Wrapper:
     window.BB_HUB = { slug: 'leo', token: 'oppahw' }
   ============================================================ */

(function () {
  if (!window.BB_HUB || !window.BB_HUB.slug) {
    console.error('[BB Hub] window.BB_HUB.slug not configured');
    return;
  }

  // ---------- Card-Type Registry ----------
  // Alle bekannten Page-Types. Neue Brand-Asset-Types einfach hier ergänzen.
  // - icon: Emoji oder kurzer String
  // - label: Anzeigename
  // - sub: Default-Beschreibung (kann durch page.label/sub aus API überschrieben werden)
  // - default_status: wenn page.status fehlt
  const PAGE_LABELS = {
    // ===== Pre-Build Assets (Vertrag, Onboarding, Konzept) =====
    contract:    { icon: '📜', label: 'Werkvertrag',   sub: 'Formaler Vertrag — drucken, unterschreiben, retour',     default_status: 'pending_action' },
    scope_brief: { icon: '🎯', label: 'Scope-Brief',   sub: '1-Pager: was im Build drin ist, was nicht',              default_status: 'ready' },
    onboarding:  { icon: '✏️',  label: 'Onboarding',    sub: 'Brand-Assets, Founder-Bios, Trust-Daten — 2–3 Min',      default_status: 'pending_action' },
    concept:     { icon: '✨', label: 'Konzept-Store', sub: 'Multi-Page-Mockup aus dem Sales-Call — voll navigierbar', default_status: 'ready' },

    // ===== Theme-Vorschauen (live Build-Output) =====
    homepage:    { icon: '🏠', label: 'Homepage',      sub: 'Startseite mit Hero, Trust, Reviews und Bundle-Finder',  default_status: 'review' },
    pdp:         { icon: '📦', label: 'Produktseite',  sub: 'Conversion-Page mit ATC, Trust und FAQ',                 default_status: 'review' },
    cart:        { icon: '🛒', label: 'Warenkorb',     sub: 'Cart-Drawer und Checkout-Vorbereitung',                  default_status: 'review' },
    collection:  { icon: '🗂️', label: 'Kollektion',    sub: 'Produktübersicht und Filter',                             default_status: 'review' },
  };

  // Reihenfolge in der die Cards gerendert werden, wenn keine deployed_at-Daten vorliegen.
  // Pre-Build-Assets zuerst, dann Theme-Vorschauen.
  const PAGE_ORDER = [
    'contract', 'scope_brief', 'onboarding', 'concept',
    'homepage', 'pdp', 'collection', 'cart',
  ];

  // ---------- 4 Major-Stages ----------
  const STAGES = [
    { key: 'brief_plan',   label: 'Brief & Plan',   sub: 'Onboarding, Strategie, Roadmap' },
    { key: 'build_review', label: 'Build & Review', sub: 'Iterativ — Wir bauen, du gibst Feedback' },
    { key: 'launch',       label: 'Launch',         sub: 'Soft-Launch, Final-Checks' },
    { key: 'live',         label: 'Live',           sub: 'Aktiv im Markt + Performance' },
  ];

  // Mapping legacy 7-Stage-Keys → neue 4-Stages
  const LEGACY_PHASE_MAP = {
    onboarding: 'brief_plan',
    plan:       'brief_plan',
    setup:      'brief_plan',
    build:      'build_review',
    review:     'build_review',
    launch:     'launch',
    live:       'live',
  };

  // ---------- Status-Labels ----------
  const STATUS_LABELS = {
    // Theme-Vorschau-Status
    building:        { label: 'In Arbeit' },
    review:          { label: 'In Review' },
    approved:        { label: 'Freigegeben' },
    change_request:  { label: 'Change-Request' },
    // Pre-Build-Asset-Status
    pending_action:  { label: 'Aktion erforderlich' },
    ready:           { label: 'Bereit' },
    done:            { label: 'Erledigt' },
  };

  // ---------- Boot ----------
  const BRAND_SLUG = window.BB_HUB.slug;

  fetch('/api/preview-auth?action=verify', { credentials: 'include' })
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok || !d.brand || d.brand.slug !== BRAND_SLUG) {
        try { localStorage.removeItem('bb-preview-brand'); } catch (e) {}
        location.href = '/preview/login?return=' + encodeURIComponent(location.pathname);
        return;
      }
      renderApp(d.brand);
    })
    .catch(() => {
      location.href = '/preview/login?return=' + encodeURIComponent(location.pathname);
    });

  // ---------- Render ----------
  function renderApp(brand) {
    const gate = document.getElementById('gate');
    const app = document.getElementById('app');
    if (gate) gate.style.display = 'none';
    if (app) app.classList.add('is-active');

    const nameEl = document.getElementById('brand-name');
    if (nameEl) nameEl.textContent = brand.name || brand.slug;

    try { localStorage.setItem('bb-preview-brand', JSON.stringify(brand)); } catch (e) {}

    const greetEl = document.getElementById('greeting-time');
    if (greetEl) {
      const hour = new Date().getHours();
      greetEl.textContent = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Hallo' : 'Guten Abend';
    }

    const currentStage = resolveStage(brand);
    renderStages(currentStage);
    renderIterationStats(currentStage, brand);
    renderCards(brand);
    renderActivity(brand);
  }

  function resolveStage(brand) {
    if (brand.phase) {
      const mapped = LEGACY_PHASE_MAP[brand.phase] || brand.phase;
      if (STAGES.findIndex((s) => s.key === mapped) >= 0) return mapped;
    }
    if (!brand.pages || brand.pages.length === 0) return 'brief_plan';
    // Heuristic: wenn nur Pre-Build-Assets vorhanden sind, ist Brand noch in brief_plan
    const themePages = brand.pages.filter((p) => isThemePage(p.key));
    if (themePages.length === 0) return 'brief_plan';
    return 'build_review';
  }

  function isThemePage(key) {
    return ['homepage', 'pdp', 'cart', 'collection'].indexOf(key) >= 0;
  }

  function renderStages(currentStage) {
    const track = document.getElementById('stage-track');
    if (!track) return;
    const currentIdx = STAGES.findIndex((s) => s.key === currentStage);
    track.innerHTML = STAGES.map((s, i) => {
      let cls = '';
      if (i < currentIdx) cls = 'is-done';
      else if (i === currentIdx) cls = 'is-current';
      return `
        <div class="stage-step ${cls}">
          <div class="stage-row">
            <span class="stage-dot">${i < currentIdx ? '✓' : i === currentIdx ? '●' : ''}</span>
            <span class="stage-label">${escapeHtml(s.label)}</span>
          </div>
          <div class="stage-sub">${escapeHtml(s.sub)}</div>
        </div>
      `;
    }).join('');
  }

  function renderIterationStats(currentStage, brand) {
    const card = document.getElementById('iteration-card');
    if (!card) return;
    if (currentStage !== 'build_review') return;
    card.classList.add('is-active');

    const themePages = (brand.pages || []).filter((p) => isThemePage(p.key));
    const counts = { building: 0, review: 0, approved: 0, change_request: 0 };
    themePages.forEach((p) => {
      const status = p.status || 'review';
      if (counts.hasOwnProperty(status)) counts[status]++;
    });

    const stats = [
      { num: counts.building,       label: 'In Arbeit' },
      { num: counts.review,         label: 'In Review' },
      { num: counts.approved,       label: 'Freigegeben' },
      { num: counts.change_request, label: 'Change-Request' },
    ];
    const el = document.getElementById('iteration-stats');
    if (!el) return;
    el.innerHTML = stats.map((s) => `
      <div class="iteration-stat">
        <div class="iteration-stat-num ${s.num === 0 ? 'is-zero' : ''}">${s.num}</div>
        <div class="iteration-stat-label">${escapeHtml(s.label)}</div>
      </div>
    `).join('');
  }

  function renderCards(brand) {
    const cardsEl = document.getElementById('cards');
    if (!cardsEl) return;
    const pages = (brand.pages || []).slice();
    const countEl = document.getElementById('page-count');
    if (countEl) {
      countEl.textContent =
        pages.length === 0 ? 'noch keine' : pages.length === 1 ? '1 Eintrag' : pages.length + ' Einträge';
    }

    if (!pages.length) {
      cardsEl.outerHTML =
        '<div class="empty"><div class="empty-emoji">🛠️</div>Wir bereiten gerade deinen Bereich vor. Du wirst per Mail informiert sobald er ready ist.</div>';
      return;
    }

    // Sort: Pre-Build-Assets zuerst (in PAGE_ORDER-Reihenfolge), dann Theme-Pages nach deployed_at desc
    pages.sort((a, b) => {
      const ai = PAGE_ORDER.indexOf(a.key);
      const bi = PAGE_ORDER.indexOf(b.key);
      const aIdx = ai === -1 ? 999 : ai;
      const bIdx = bi === -1 ? 999 : bi;
      if (aIdx !== bIdx) return aIdx - bIdx;
      return (b.deployed_at || '').localeCompare(a.deployed_at || '');
    });

    cardsEl.innerHTML = pages.map((p) => {
      const meta = PAGE_LABELS[p.key] || { icon: '📄', label: p.label || p.key, sub: '', default_status: 'review' };
      const label = p.label || meta.label;
      const sub = p.sub || meta.sub;
      const status = p.status || meta.default_status || 'review';
      const statusLabel = (STATUS_LABELS[status] || STATUS_LABELS.review).label;
      const url = pageUrl(brand, p);
      const deployed = p.deployed_at ? new Date(p.deployed_at) : null;
      const deployedStr = deployed
        ? deployed.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      const isThemeUpdate = isThemePage(p.key);
      return `
        <a class="card" href="${escapeAttr(url)}">
          <span class="card-badge status-${escapeAttr(status)}">${escapeHtml(statusLabel)}</span>
          <div class="card-icon">${meta.icon}</div>
          <div class="card-title">${escapeHtml(label)}</div>
          <div class="card-meta">${escapeHtml(sub)}${deployedStr && isThemeUpdate ? '<br>📅 aktualisiert ' + deployedStr : ''}</div>
          <div class="card-cta">${ctaForStatus(status)}</div>
        </a>
      `;
    }).join('');
  }

  function pageUrl(brand, p) {
    if (p.url_path) {
      // url_path kann absolut (/preview/...) oder relativ (key) sein
      if (p.url_path.startsWith('/')) return p.url_path;
      return '/preview/' + brand.slug + '-' + brand.token + '/' + p.url_path.replace(/^\/+/, '');
    }
    return '/preview/' + brand.slug + '-' + brand.token + '/' + p.key;
  }

  function ctaForStatus(status) {
    if (status === 'pending_action') return 'Jetzt erledigen';
    if (status === 'ready')          return 'Öffnen';
    if (status === 'done')           return 'Ansehen';
    if (status === 'building')       return 'Stand ansehen';
    return 'Vorschau öffnen';
  }

  function renderActivity(brand) {
    const listEl = document.getElementById('activity-list');
    if (!listEl) return;
    const pages = (brand.pages || []).slice().sort((a, b) => (b.deployed_at || '').localeCompare(a.deployed_at || ''));
    if (!pages.length) {
      listEl.innerHTML =
        '<div class="activity-item"><span class="activity-dot" style="background: var(--text-light)"></span><span class="activity-text">Noch keine Aktivitäten — wir starten gleich.</span></div>';
      return;
    }
    listEl.innerHTML = pages.slice(0, 6).map((p) => {
      const meta = PAGE_LABELS[p.key] || { label: p.label || p.key };
      const label = p.label || meta.label;
      const t = p.deployed_at ? new Date(p.deployed_at) : null;
      const verb = isThemePage(p.key) ? 'Neue Vorschau' : 'Bereitgestellt';
      return `
        <div class="activity-item">
          <span class="activity-dot"></span>
          <span class="activity-text">${verb}: <strong>${escapeHtml(label)}</strong></span>
          <span class="activity-time">${t ? formatRelative(t) : ''}</span>
        </div>
      `;
    }).join('');
  }

  function formatRelative(date) {
    const diff = Date.now() - date.getTime();
    const m = Math.round(diff / 60000);
    if (m < 1) return 'gerade eben';
    if (m < 60) return 'vor ' + m + ' Min';
    const h = Math.round(m / 60);
    if (h < 24) return 'vor ' + h + ' Std';
    const d = Math.round(h / 24);
    if (d < 7) return 'vor ' + d + ' Tagen';
    return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  }

  // ---------- Logout ----------
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btn-logout');
    if (!btn) return;
    btn.addEventListener('click', () => {
      fetch('/api/preview-auth', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logout' }),
      }).finally(() => {
        try { localStorage.removeItem('bb-preview-brand'); } catch (e) {}
        location.href = '/preview/login';
      });
    });
  });

  // ---------- Helpers ----------
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }
})();
