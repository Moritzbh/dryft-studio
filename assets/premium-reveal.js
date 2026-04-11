/* =========================================================
   BB BRANDS — PREMIUM REVEAL
   Tiny IntersectionObserver-based scroll-reveal.

   - Auto-targets headlines, cards, lists, hero blocks
     across all pages without HTML edits.
   - Respects prefers-reduced-motion.
   - Adds .pv2-auto-reveal then toggles .is-visible.
   - Also handles explicit [data-reveal] elements.
   ========================================================= */
(function () {
    'use strict';

    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    var prefersReduced = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!('IntersectionObserver' in window) || prefersReduced) {
        // Mark everything visible immediately, no animation.
        document.addEventListener('DOMContentLoaded', function () {
            document.querySelectorAll('[data-reveal], .pv2-auto-reveal').forEach(function (el) {
                el.classList.add('is-visible');
            });
        });
        return;
    }

    var AUTO_SELECTORS = [
        // Headlines
        '.hero h1', '.hero--split h1', 'header.hero h1',
        '.hero-sub', '.hero--split .hero-sub',
        '.section-title', 'section h2',
        '.section-sub', 'section .lead',

        // Cards
        '.problem-card', '.service-card', '.guarantee-card',
        '.resource-card', '.about-card', '.stat-card',
        '.tool-card', '.step-card', '.card',
        '.layer', '.lever', '.phase',
        '.faq-item', '.callout', '.compare',

        // Calculators / forms
        '.calc-result', '.calc-form', '.form-card', '.field',
        '.live-box', '.formula',
        '.bottom-cta', '.bottom-strip',

        // Hero supporting elements
        '.hero-badge', '.hero-guarantee',
        '.float-pill', '.float-note', '.proof-card',
        '.stack-card', '.hs-card',

        // Article / wissen elements
        '.phase', '.phase-tag',
        'article > p', 'article > h2', 'article > h3',
        'article > ul', 'article > ol',

        // Generic blocks worth animating once
        '.eyebrow'
    ].join(',');

    function init() {
        var nodes = document.querySelectorAll(AUTO_SELECTORS);
        if (!nodes.length) return;

        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-visible');
                    io.unobserve(entry.target);
                }
            });
        }, {
            root: null,
            rootMargin: '0px 0px -8% 0px',
            threshold: 0.08
        });

        nodes.forEach(function (el, i) {
            // Reveal anything within ~1.2x viewport on first paint so the
            // top of the page never looks "broken". Only blocks far down
            // wait for scroll.
            var rect = el.getBoundingClientRect();
            var initialReveal = rect.top < window.innerHeight * 1.2 && rect.bottom > -200;

            el.classList.add('pv2-auto-reveal');

            if (initialReveal) {
                var delay = Math.min(i, 8) * 70;
                setTimeout(function () {
                    el.classList.add('is-visible');
                }, delay);
            } else {
                io.observe(el);
            }
        });

        // Explicit [data-reveal] elements
        var explicit = document.querySelectorAll('[data-reveal]:not(.pv2-auto-reveal)');
        explicit.forEach(function (el) { io.observe(el); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
