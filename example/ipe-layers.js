/**
 * ipe-layers.js — reveal.js plugin for Ipe SVG presentations.
 *
 * Reads page/layer/view metadata from #ipe-meta, resolves <section> elements
 * to Ipe pages (by index, by title, or sequentially), fetches and injects the
 * per-page SVG, auto-fills missing view-fragment <span>s, drives layer
 * visibility as the presentation navigates, and fires animate.css animations
 * on layer elements at configurable trigger points.
 *
 * Data attributes consumed:
 *   <div class="slides" data-ipe-no-auto-pages>  — suppress auto-appending sections for unclaimed pages
 *   <div class="slides" data-ipe-no-auto-views>  — disable view-fragment auto-fill for all slides globally
 *   <section data-ipe-page="N">                  — select page by 1-based index
 *   <section data-ipe-page="Title">              — select page by title
 *   <section data-ipe-page="auto">               — assign the next not-yet-claimed page sequentially
 *   <section data-ipe-no-auto-views>             — disable view-fragment auto-fill for this slide
 *   <section data-ipe-animate='[...]'>           — animate.css rules for this slide (see below)
 *   <span class="fragment ipe-view"
 *         data-visible-layers="a b c">           — hand-authored view fragment
 *   <span class="fragment ipe-view"
 *         data-ipe-animate='[...]'>              — animations fired when this fragment is shown
 *
 * Animation rule format (JSON array on data-ipe-animate):
 *   [
 *     {
 *       "sel":   ".layer-alpha",   // CSS selector scoped to the slide's SVG (required)
 *       "anim":  "fadeInLeft",     // animate.css name without the animate__ prefix (required)
 *       "on":    "reveal",         // trigger: "reveal" | "slide" | "view-N" (default: "reveal")
 *       "dur":   "0.5s",           // optional: overrides --animate-duration
 *       "delay": "0.2s"            // optional: overrides animation-delay
 *     }
 *   ]
 *
 * Triggers on <section data-ipe-animate>:
 *   "reveal"  — fires when an element transitions from hidden to visible, both
 *               on slide entry (for layers in the initial view) and on each
 *               fragmentshown that makes new layers visible.
 *   "slide"   — fires for all matching elements whenever this slide becomes
 *               the current slide (slidechanged event).
 *   "view-N"  — fires at the N-th view (1-based; view-1 = initial state,
 *               view-2 = first fragment, etc.).  May be combined with a
 *               selector to restrict which elements animate.
 *
 * Trigger on <span data-ipe-animate>:
 *   The "on" field is ignored; all rules fire when the fragment is shown.
 *   This is equivalent to placing a "view-N" rule on the section, but
 *   co-located with the fragment span for clarity.
 */

const IpeLayers = (() => {
  'use strict';

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  async function parseMeta() {
    const el = document.getElementById('ipe-meta');
    if (el) return JSON.parse(el.textContent);
    // Fall back to fetching the separate metadata file (multi-file / hosted mode).
    const res = await fetch('ipe-meta.json');
    if (!res.ok)
      throw new Error(`IpeLayers: failed to fetch ipe-meta.json: HTTP ${res.status}`);
    return res.json();
  }

  // -------------------------------------------------------------------------
  // Page resolution
  // -------------------------------------------------------------------------

  /**
   * Map a <section> to a page metadata object.
   * usedSet tracks which page indices have already been assigned.
   * Returns null if the section has no data-ipe-page (not an ipe slide).
   */
  function resolvePage(section, pages, usedSet) {
    const attr = section.dataset.ipePage;

    if (attr === undefined) return null;  // plain section, not managed by this plugin

    if (attr === 'auto') {
      // Take the next not-yet-assigned page in document order
      for (let i = 0; i < pages.length; i++) {
        if (!usedSet.has(i)) {
          usedSet.add(i);
          return pages[i];
        }
      }
      return null;
    }

    // Try 1-based numeric index
    const n = parseInt(attr, 10);
    if (!isNaN(n) && n >= 1 && n <= pages.length) {
      usedSet.add(n - 1);
      return pages[n - 1];
    }
    // Try title match
    const idx = pages.findIndex(p => p.title === attr);
    if (idx >= 0) {
      usedSet.add(idx);
      return pages[idx];
    }
    console.warn(`IpeLayers: no page found for data-ipe-page="${attr}"`);
    return null;
  }

  // -------------------------------------------------------------------------
  // SVG ID namespacing
  // -------------------------------------------------------------------------

  /**
   * Prefix every id in svgEl and rewrite all internal references so that
   * multiple per-page SVGs can coexist in the same document without collisions.
   */
  function prefixIds(svgEl, prefix) {
    const idMap = new Map();

    svgEl.querySelectorAll('[id]').forEach(el => {
      const oldId = el.id;
      const newId = `${prefix}--${oldId}`;
      idMap.set(oldId, newId);
      el.id = newId;
    });

    if (idMap.size === 0) return;

    function rewrite(val) {
      return val
        .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${idMap.get(id) ?? id})`)
        .replace(/^#(.+)$/, (_, id) => `#${idMap.get(id) ?? id}`);
    }

    const refAttrs = [
      'href', 'xlink:href', 'fill', 'stroke',
      'clip-path', 'mask', 'filter',
      'marker-start', 'marker-mid', 'marker-end',
    ];

    svgEl.querySelectorAll('*').forEach(el => {
      refAttrs.forEach(attr => {
        const val = el.getAttribute(attr);
        if (val) el.setAttribute(attr, rewrite(val));
      });
      const style = el.getAttribute('style');
      if (style && style.includes('url(#'))
        el.setAttribute('style', rewrite(style));
    });
  }

  // -------------------------------------------------------------------------
  // SVG injection
  // -------------------------------------------------------------------------

  /**
   * Fetch pageInfo.file, inject the SVG into the section.
   * No-op if the section already contains an <svg> element.
   */
  async function injectSVG(section, pageInfo) {
    if (section.querySelector('svg')) return;

    let text;
    try {
      const res = await fetch(pageInfo.file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      console.error(`IpeLayers: failed to fetch ${pageInfo.file}:`, err);
      return;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'image/svg+xml');
    const svgEl = doc.documentElement;

    if (svgEl.nodeName === 'parsererror') {
      console.error(`IpeLayers: SVG parse error in ${pageInfo.file}`);
      return;
    }

    prefixIds(svgEl, `p${pageInfo.index}`);

    // Fill the slide; the viewBox preserves the aspect ratio
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', '100%');

    section.appendChild(document.adoptNode(svgEl));
  }

  // -------------------------------------------------------------------------
  // Layer elements
  // -------------------------------------------------------------------------

  /**
   * Stamp data-ipe-layer on every element that belongs to a layer so that the
   * CSS transition rule `[data-ipe-layer] { transition: opacity … }` applies.
   */
  function tagLayerElements(section, pageInfo) {
    const layers = pageInfo.layers.split(/\s+/).filter(Boolean);
    layers.forEach(name => {
      section.querySelectorAll(`[class~="layer-${CSS.escape(name)}"]`)
        .forEach(el => el.setAttribute('data-ipe-layer', name));
    });
  }

  /**
   * Show/hide layer elements according to a space-separated visible-layers string.
   * Uses opacity so CSS transitions apply; elements are never removed from layout.
   */
  function applyLayers(section, pageInfo, visibleStr) {
    const visible = new Set(
      (visibleStr ?? '').trim().split(/\s+/).filter(Boolean)
    );
    pageInfo.layers.split(/\s+/).filter(Boolean).forEach(name => {
      const opacity = visible.has(name) ? '1' : '0';
      section.querySelectorAll(`[class~="layer-${CSS.escape(name)}"]`)
        .forEach(el => { el.style.opacity = opacity; });
    });
  }

  // -------------------------------------------------------------------------
  // Fragment auto-fill
  // -------------------------------------------------------------------------

  /**
   * Append one invisible .fragment.ipe-view <span> for each view beyond the
   * first that does not yet have a corresponding hand-authored span.
   */
  function autoFillFragments(section, pageInfo) {
    const views   = pageInfo.views;          // views[0] is the initial state
    const existing = section.querySelectorAll('.fragment.ipe-view').length;
    const needed   = views.length - 1;

    for (let i = existing; i < needed; i++) {
      const span = document.createElement('span');
      span.className = 'fragment ipe-view';
      span.dataset.visibleLayers = views[i + 1];
      span.style.cssText = 'display:none!important';
      section.appendChild(span);
    }
  }

  // -------------------------------------------------------------------------
  // Current view state
  // -------------------------------------------------------------------------

  /**
   * Return the visible-layers string that corresponds to the highest
   * .fragment.ipe-view that reveal.js has marked as .visible, falling back to
   * view 1 (views[0]) if none are active.
   */
  function currentLayers(section, pageInfo) {
    const frags = [...section.querySelectorAll('.fragment.ipe-view')];
    const lastVisible = frags.filter(f => f.classList.contains('visible')).pop();
    return lastVisible
      ? (lastVisible.dataset.visibleLayers ?? '')
      : pageInfo.views[0];
  }

  // -------------------------------------------------------------------------
  // Animations
  // -------------------------------------------------------------------------

  function parseAnimRules(jsonStr) {
    if (!jsonStr) return [];
    try {
      const v = JSON.parse(jsonStr);
      return Array.isArray(v) ? v : [v];
    } catch (e) {
      console.warn('IpeLayers: invalid data-ipe-animate JSON:', jsonStr, e);
      return [];
    }
  }

  /**
   * Return (creating if necessary) a plain wrapper <g> around el.
   *
   * Cairo renders every SVG primitive with an individual transform attribute
   * (matrix(1,0,0,-1,x,y)) that both positions the element and corrects for
   * Ipe's Y-up coordinate system.  The CSS `transform` property overrides SVG
   * `transform` attributes, so applying animate.css classes directly to those
   * elements strips away their Y-flip and translation, causing them to appear
   * upside-down and misplaced during the animation.
   *
   * Instead we animate a wrapper <g> that has no transform attribute of its
   * own.  The wrapper sits in the SVG's normal coordinate space, so CSS
   * transforms on it behave as expected; the inner element keeps its own
   * transform intact and renders correctly throughout.
   */
  function getOrCreateWrapper(el) {
    if (el._ipeAnimWrapper) return el._ipeAnimWrapper;
    const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    // Scale/rotate animations should pivot around the element's own centre,
    // not the SVG viewport centre.
    wrapper.style.transformBox   = 'fill-box';
    wrapper.style.transformOrigin = 'center';
    el.parentNode.insertBefore(wrapper, el);
    wrapper.appendChild(el);
    el._ipeAnimWrapper = wrapper;
    return wrapper;
  }

  /**
   * Start an animate.css animation on a single element.
   * Animates a wrapper <g> (see getOrCreateWrapper) to avoid the CSS
   * `transform` property overriding the element's SVG `transform` attribute.
   * Removes the animation classes when the animation ends so that the element
   * returns to its static CSS state (important for opacity-driven layer
   * visibility).
   */
  function playAnimation(el, rule) {
    const target = (el.namespaceURI === 'http://www.w3.org/2000/svg')
      ? getOrCreateWrapper(el)
      : el;
    const cls = `animate__${rule.anim}`;
    target.classList.remove('animate__animated', cls);
    void target.offsetWidth;                  // force reflow to restart animation
    if (rule.dur)   target.style.setProperty('--animate-duration', rule.dur);
    if (rule.delay) target.style.animationDelay = rule.delay;
    target.classList.add('animate__animated', cls);
    target.addEventListener('animationend', () =>
      target.classList.remove('animate__animated', cls), { once: true });
  }

  /**
   * Fire section-level animation rules that match `trigger`.
   * prevVisible / nextVisible are Sets of currently-visible layer names.
   *
   * For the "reveal" trigger, only elements in layers that just became visible
   * (present in nextVisible but not prevVisible) are animated.
   * For all other triggers, every element matching rule.sel is animated.
   */
  function fireRules(section, rules, trigger, prevVisible, nextVisible) {
    for (const rule of rules) {
      if (!rule.anim || !rule.sel) continue;
      const on = rule.on ?? 'reveal';
      if (on !== trigger) continue;
      section.querySelectorAll(`svg ${rule.sel}`).forEach(el => {
        if (trigger === 'reveal') {
          const layer = el.getAttribute('data-ipe-layer');
          if (layer) {
            // Skip elements whose layer was already visible or is still hidden.
            if (prevVisible.has(layer) || !nextVisible.has(layer)) return;
          }
        }
        playAnimation(el, rule);
      });
    }
  }

  /**
   * Fire all animation rules on a fragment span (data-ipe-animate on
   * .fragment.ipe-view).  The "on" field is ignored — rules fire whenever
   * the fragment is shown.
   */
  function fireFragmentRules(section, fragment) {
    const rules = parseAnimRules(fragment.dataset.ipeAnimate);
    for (const rule of rules) {
      if (!rule.anim || !rule.sel) continue;
      section.querySelectorAll(`svg ${rule.sel}`).forEach(el => playAnimation(el, rule));
    }
  }

  // -------------------------------------------------------------------------
  // Plugin
  // -------------------------------------------------------------------------

  return {
    id: 'ipe-layers',

    async init(deck) {
      let meta;
      try {
        meta = await parseMeta();
      } catch (e) {
        console.error(e);
        return;
      }

      const pages    = meta.pages;
      const slidesEl = deck.getRevealElement().querySelector('.slides');
      const globalNoAutoPages = slidesEl.hasAttribute('data-ipe-no-auto-pages');
      const globalNoAutoViews = slidesEl.hasAttribute('data-ipe-no-auto-views');

      // Collect only direct-child <section>s (ignore vertical stacks for now)
      const sections = [...slidesEl.querySelectorAll(':scope > section')];

      // Resolve page assignments synchronously to preserve document order.
      // Sections without data-ipe-page are ignored (plain reveal.js slides).
      // data-ipe-page="auto" claims the next unclaimed page sequentially.
      const usedSet        = new Set();
      const sectionPageMap = new Map();
      for (const section of sections) {
        const pageInfo = resolvePage(section, pages, usedSet);
        if (pageInfo) sectionPageMap.set(section, pageInfo);
      }

      // Auto-append a new <section> for every page not yet claimed, unless
      // suppressed by data-ipe-no-auto-pages on the .slides container.
      if (!globalNoAutoPages) {
        for (let i = 0; i < pages.length; i++) {
          if (!usedSet.has(i)) {
            const section = document.createElement('section');
            slidesEl.appendChild(section);
            sectionPageMap.set(section, pages[i]);
          }
        }
      }

      // Tracks the set of currently-visible layer names per section, used to
      // compute the layer diff needed by the "reveal" animation trigger.
      const layersState = new Map();   // section → Set<layerName>

      // Inject SVGs and prepare fragments (async, in parallel per section).
      // View-fragment auto-fill is suppressed globally by data-ipe-no-auto-views
      // on .slides, or per-section by data-ipe-no-auto-views on the <section>.
      await Promise.all(
        [...sectionPageMap.entries()].map(async ([section, pageInfo]) => {
          const noAutoViews = globalNoAutoViews || section.hasAttribute('data-ipe-no-auto-views');

          await injectSVG(section, pageInfo);
          tagLayerElements(section, pageInfo);

          if (!noAutoViews) autoFillFragments(section, pageInfo);

          // Apply view 1 as the starting visibility state
          applyLayers(section, pageInfo, pageInfo.views[0]);
          layersState.set(section,
            new Set(pageInfo.views[0].trim().split(/\s+/).filter(Boolean)));
        })
      );

      // Initial layer visibility is already applied for every section inside
      // the Promise.all above.  Reveal.js picks up the auto-filled fragments
      // as it continues its own init after this plugin's promise resolves —
      // no deck.sync() or ready-event hook needed here.

      // ----- Navigation event handlers -----

      deck.on('slidechanged', ({ currentSlide }) => {
        const pageInfo = sectionPageMap.get(currentSlide);
        if (!pageInfo) return;
        // When navigating backward, reveal.js has already marked all fragments
        // of the target slide as .visible before firing this event, so
        // currentLayers() returns the correct last-view state.
        const layersStr = currentLayers(currentSlide, pageInfo);
        applyLayers(currentSlide, pageInfo, layersStr);

        const nextVisible = new Set(layersStr.trim().split(/\s+/).filter(Boolean));
        layersState.set(currentSlide, nextVisible);

        const rules = parseAnimRules(currentSlide.dataset.ipeAnimate);
        // "slide": fires for all matching elements on every slide entry.
        // "reveal": fires for all layers in the initial view (prevVisible is
        // empty because we are arriving from a different slide).
        fireRules(currentSlide, rules, 'slide',  new Set(), nextVisible);
        fireRules(currentSlide, rules, 'reveal', new Set(), nextVisible);
      });

      deck.on('fragmentshown', ({ fragment }) => {
        if (!fragment.classList.contains('ipe-view')) return;
        const section  = fragment.closest('section');
        const pageInfo = sectionPageMap.get(section);
        if (!pageInfo) return;

        const prevVisible  = layersState.get(section) ?? new Set();
        const nextLayersStr = fragment.dataset.visibleLayers ?? '';
        const nextVisible  = new Set(nextLayersStr.trim().split(/\s+/).filter(Boolean));

        applyLayers(section, pageInfo, nextLayersStr);
        layersState.set(section, nextVisible);

        // Determine the view-N label for this fragment.
        // view-1 is the initial state (no fragment); the first .ipe-view
        // fragment is view-2, the second is view-3, etc.
        const frags = [...section.querySelectorAll('.fragment.ipe-view')];
        const viewN = `view-${frags.indexOf(fragment) + 2}`;

        const sectionRules = parseAnimRules(section.dataset.ipeAnimate);
        fireRules(section, sectionRules, 'reveal', prevVisible, nextVisible);
        fireRules(section, sectionRules, viewN,    prevVisible, nextVisible);

        // Fragment-level rules: fire regardless of "on" field.
        fireFragmentRules(section, fragment);
      });

      deck.on('fragmenthidden', ({ fragment }) => {
        if (!fragment.classList.contains('ipe-view')) return;
        const section  = fragment.closest('section');
        const pageInfo = sectionPageMap.get(section);
        if (!pageInfo) return;

        const layersStr = currentLayers(section, pageInfo);
        applyLayers(section, pageInfo, layersStr);
        layersState.set(section,
          new Set(layersStr.trim().split(/\s+/).filter(Boolean)));
      });
    },
  };
})();
