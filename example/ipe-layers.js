/**
 * ipe-layers.js — reveal.js plugin for Ipe SVG presentations.
 *
 * Reads page/layer/view metadata from #ipe-meta, resolves <section> elements
 * to Ipe pages (by index, by title, or sequentially), fetches and injects the
 * per-page SVG, auto-fills missing view-fragment <span>s, drives layer
 * visibility as the presentation navigates, and fires animations on layer
 * elements at configurable trigger points.
 *
 * Three animation backends are supported (mix freely within a presentation):
 *   animate.css — simple named animations (fadeInLeft, zoomIn, …)
 *   GSAP        — advanced tweens including MorphSVGPlugin, DrawSVGPlugin, …
 *   script      — arbitrary JS callback for anything a single tween can't do
 *
 * Data attributes consumed:
 *   <div class="slides" data-ipe-no-auto-pages>  — suppress auto-appending sections for unclaimed pages
 *   <div class="slides" data-ipe-no-auto-views>  — disable view-fragment auto-fill for all slides globally
 *   <section data-ipe-page="N">                  — select page by 1-based index
 *   <section data-ipe-page="Title">              — select page by title
 *   <section data-ipe-page="auto">               — assign the next not-yet-claimed page sequentially
 *   <section data-ipe-no-auto-views>             — disable view-fragment auto-fill for this slide
 *   <section data-ipe-animate='[...]'>           — animation rules for this slide (see below)
 *   <span class="fragment ipe-view"
 *         data-visible-layers="a b c">           — hand-authored view fragment
 *   <span class="fragment ipe-view"
 *         data-ipe-animate='[...]'>              — animations fired when this fragment is shown
 *
 * Animation rule format (JSON array on data-ipe-animate):
 *   [
 *     {
 *       "sel": ".layer-alpha",    // CSS selector scoped to the slide's SVG
 *                                 //   required for anim/GSAP; optional for script
 *       "on":  "reveal",          // trigger: "reveal"|"slide"|"view-N" (default: "reveal")
 *
 *       // — animate.css rule (simple animations) —
 *       "anim":    "fadeInLeft",  // animate.css name without the animate__ prefix
 *       "dur":     "0.5s",        // optional: overrides --animate-duration
 *       "delay":   "0.2s",        // optional: overrides animation-delay
 *       "mode":    "individual",  // "individual" (default) | "group"
 *       "stagger": "0.08s",       // individual only: cumulative CSS delay per element
 *
 *       // — or — GSAP rule (advanced tweens, MorphSVG, DrawSVG, …) —
 *       // Exactly one of from/to/fromTo identifies the tween method.
 *       // Selector strings inside morphSVG / morphSVG.shape are automatically
 *       // scoped to the slide's SVG.  Requires gsap (and any plugins) loaded
 *       // before ipe-layers.js and registered with gsap.registerPlugin().
 *       "from":    { "morphSVG": "path.src", "opacity": 0 },
 *       "to":      { "x": 100, "opacity": 1 },
 *       "fromTo":  [{ "opacity": 0 }, { "opacity": 1 }],
 *       "duration": 0.5,          // top-level GSAP tween vars — merged into from/to/fromTo
 *       "ease":    "power2.out",  // (any property GSAP accepts as tween vars)
 *       "stagger":  0.08,         // numeric seconds, not a CSS time string
 *
 *       // — or — script rule (for anything a single tween cannot express) —
 *       "script": "myScript",     // name passed to IpeLayers.registerScript()
 *       "args":   { ... }         // forwarded verbatim to the callback
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
 *   "conceal" — counterpart to "reveal": fires just before elements transition
 *               from visible to hidden (on fragmenthidden).  Elements are still
 *               visible when the rule fires, so reverse animations play against
 *               a visible state while the layer system's CSS opacity transition
 *               runs concurrently.  ctx.prevVisible contains the layers about to
 *               be hidden; ctx.nextVisible contains the layers that will remain.
 *               The selector is filtered to elements in newly-hidden layers.
 *
 * Trigger on <span data-ipe-animate>:
 *   The "on" field is ignored; all rules fire when the fragment is shown.
 *   This is equivalent to placing a "view-N" rule on the section, but
 *   co-located with the fragment span for clarity.
 */

const IpeLayers = (() => {
  'use strict';

  // Registry for user-defined script animations (see registerScript below).
  const scriptRegistry = new Map();

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

  function parseTimeMs(s) {
    if (!s) return 0;
    return s.endsWith('ms') ? parseFloat(s) : parseFloat(s) * 1000;
  }

  function msToTimeStr(ms) {
    return Number.isInteger(ms / 1000) ? `${ms / 1000}s` : `${ms}ms`;
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
    wrapper.style.transformBox    = 'fill-box';
    wrapper.style.transformOrigin = 'center';
    el.parentNode.insertBefore(wrapper, el);
    wrapper.appendChild(el);
    el._ipeAnimWrapper = wrapper;
    return wrapper;
  }

  /**
   * Play an animate.css animation on `target`, starting after `extraDelayMs`
   * milliseconds beyond rule.delay.  Cleans up animation classes on end.
   */
  function playOnTarget(target, rule, extraDelayMs = 0) {
    const cls = `animate__${rule.anim}`;
    target.classList.remove('animate__animated', cls);
    void target.offsetWidth;                  // force reflow to restart animation
    if (rule.dur) target.style.setProperty('--animate-duration', rule.dur);
    const totalMs = parseTimeMs(rule.delay) + extraDelayMs;
    target.style.animationDelay = totalMs > 0 ? msToTimeStr(totalMs) : '';
    target.classList.add('animate__animated', cls);
    target.addEventListener('animationend', () =>
      target.classList.remove('animate__animated', cls), { once: true });
  }

  /**
   * Animate all elements together as one group.
   *
   * A temporary <g> wrapper is placed in the DOM (at the position of the last
   * individual wrapper, i.e. the highest z-level among the matched elements).
   * All per-element wrappers are reparented into it for the duration of the
   * animation so that CSS percentage offsets and transform-origin are computed
   * relative to the combined bounding box of the whole group.  On animationend
   * every wrapper is restored to its original parent/position and the temporary
   * group is removed, leaving the DOM unchanged after animation.
   *
   * Z-order: SVG uses DOM order as implicit z-order.  Reparenting elements into
   * the group changes their position in the tree, and the CSS `transform` that
   * animate.css applies to the group creates a new stacking context, so the
   * implicit z-order would be lost.  We therefore make it explicit up-front:
   * every sibling in the shared parent receives a `z-index` matching its
   * original 1-based DOM position, and the group itself gets the z-index of the
   * last moved wrapper.  After restoration, all explicit z-indices are cleared
   * so DOM order is authoritative again.
   *
   * Limitation: within a CSS stacking context (i.e. while the group has an
   * active `transform`) elements inside the group cannot interleave with
   * elements outside it.  The group as a whole renders at the z-level of its
   * last element; elements inside that should originally have been below some
   * outside element may appear above it during the animation.  This is an
   * inherent constraint of CSS stacking contexts and cannot be fully avoided
   * with z-index alone.
   */
  function playGrouped(els, rule) {
    if (!els.length) return;

    // Ensure per-element wrappers exist (Y-flip protection).
    const wrappers = els.map(el => getOrCreateWrapper(el));

    // Require a single shared parent; fall back to individual mode otherwise.
    const parentSet = new Set(wrappers.map(w => w.parentNode));
    if (parentSet.size > 1) { playIndividual(els, rule); return; }
    const parent = [...parentSet][0];

    // Snapshot the current children of the shared parent BEFORE any DOM
    // changes.  This is the ground truth for the original z-order.
    const siblings = [...parent.children];

    // Record each wrapper's next sibling so we can restore it later.
    const positions = wrappers.map(w => w.nextSibling);

    // Make implicit z-order explicit on every sibling (1-based so that a
    // missing entry falls below everything).
    siblings.forEach((child, i) => { child.style.zIndex = i + 1; });

    // The group renders at the z-level of the last (topmost) wrapper.
    const groupZ = siblings.indexOf(wrappers[wrappers.length - 1]) + 1;

    // Create the temporary animation group and insert it where the last
    // wrapper was, then move all wrappers into it.
    const ns  = 'http://www.w3.org/2000/svg';
    const grp = document.createElementNS(ns, 'g');
    grp.style.transformBox    = 'fill-box';
    grp.style.transformOrigin = 'center';
    grp.style.zIndex          = groupZ;
    parent.insertBefore(grp, positions[positions.length - 1]);
    wrappers.forEach(w => grp.appendChild(w));

    // Animate the group.
    const cls = `animate__${rule.anim}`;
    grp.classList.remove('animate__animated', cls);
    void grp.offsetWidth;
    if (rule.dur)   grp.style.setProperty('--animate-duration', rule.dur);
    if (rule.delay) grp.style.animationDelay = rule.delay;
    grp.classList.add('animate__animated', cls);

    grp.addEventListener('animationend', () => {
      // Restore each wrapper to its original position.  Iterate in reverse so
      // that when a wrapper's recorded `next` is another wrapper in the same
      // set, it is already back in the DOM by the time it is needed.
      for (let i = wrappers.length - 1; i >= 0; i--) {
        parent.insertBefore(wrappers[i], positions[i]);
      }
      grp.remove();
      // DOM order is authoritative again — drop the explicit z-indices.
      siblings.forEach(child => { child.style.zIndex = ''; });
    }, { once: true });
  }

  /**
   * Animate elements individually (default), optionally staggered.
   * rule.stagger: CSS time string added cumulatively to each element's delay.
   */
  function playIndividual(els, rule) {
    const staggerMs = parseTimeMs(rule.stagger);
    els.forEach((el, i) => {
      const target = (el.namespaceURI === 'http://www.w3.org/2000/svg')
        ? getOrCreateWrapper(el)
        : el;
      playOnTarget(target, rule, i * staggerMs);
    });
  }

  /** Dispatch to grouped or individual animation based on rule.mode. */
  function playAnimationForElements(els, rule) {
    if (!els.length) return;
    if (rule.mode === 'group') playGrouped(els, rule);
    else                       playIndividual(els, rule);
  }

  /**
   * Resolve selector strings inside a GSAP vars object to DOM elements scoped
   * to the section's SVG.  This prevents cross-slide collisions when multiple
   * SVGs share the same class names.
   *
   * Only the `morphSVG` property is resolved — either as a plain selector
   * string or as the `shape` property of an object shorthand.
   */
  function resolveGsapVars(vars, section) {
    if (!vars || typeof vars !== 'object') return vars;
    const out = { ...vars };
    if (typeof out.morphSVG === 'string') {
      out.morphSVG = section.querySelector(`svg ${out.morphSVG}`) ?? out.morphSVG;
    } else if (out.morphSVG?.shape && typeof out.morphSVG.shape === 'string') {
      out.morphSVG = { ...out.morphSVG,
        shape: section.querySelector(`svg ${out.morphSVG.shape}`) ?? out.morphSVG.shape };
    }
    return out;
  }

  /**
   * Dispatch a GSAP tween for the given elements using from/to/fromTo fields.
   * Shared tween properties (duration, ease, stagger, …) sit at the rule's top
   * level alongside the from/to/fromTo field; sel and on are stripped out.
   */
  function fireGsap(section, els, rule) {
    if (!window.gsap) { console.warn('IpeLayers: GSAP not loaded'); return; }
    if (!els.length) return;
    // eslint-disable-next-line no-unused-vars
    const { sel, on, from, to, fromTo, ...shared } = rule;
    const targets = els.length === 1 ? els[0] : els;
    if (fromTo !== undefined) {
      const [fv, tv] = fromTo;
      gsap.fromTo(targets, resolveGsapVars(fv, section),
                  { ...shared, ...resolveGsapVars(tv, section) });
    } else if (from !== undefined) {
      gsap.from(targets, { ...shared, ...resolveGsapVars(from, section) });
    } else {
      gsap.to(targets, { ...shared, ...resolveGsapVars(to, section) });
    }
  }

  /** Return elements matching rule.sel, filtered for reveal/conceal triggers. */
  function selectEls(section, rule, trigger, prevVisible, nextVisible) {
    if (!rule.sel) return [];
    let els = [...section.querySelectorAll(`svg ${rule.sel}`)];
    if (trigger === 'reveal') {
      els = els.filter(el => {
        const layer = el.getAttribute('data-ipe-layer');
        return !layer || (!prevVisible.has(layer) && nextVisible.has(layer));
      });
    } else if (trigger === 'conceal') {
      els = els.filter(el => {
        const layer = el.getAttribute('data-ipe-layer');
        return !layer || (prevVisible.has(layer) && !nextVisible.has(layer));
      });
    }
    return els;
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
      const on = rule.on ?? 'reveal';
      if (on !== trigger) continue;

      if ('from' in rule || 'to' in rule || 'fromTo' in rule) {
        fireGsap(section, selectEls(section, rule, trigger, prevVisible, nextVisible), rule);
        continue;
      }

      if (rule.script) {
        const fn = scriptRegistry.get(rule.script);
        if (!fn) {
          console.warn(`IpeLayers: no script registered for "${rule.script}"`);
          continue;
        }
        fn(selectEls(section, rule, trigger, prevVisible, nextVisible),
           rule, { section, trigger, prevVisible, nextVisible });
        continue;
      }

      if (!rule.anim || !rule.sel) continue;
      playAnimationForElements(
        selectEls(section, rule, trigger, prevVisible, nextVisible), rule);
    }
  }

  /**
   * Fire all animation rules on a fragment span (data-ipe-animate on
   * .fragment.ipe-view).  The "on" field is ignored — rules fire whenever
   * the fragment is shown.  Supports mode and stagger like section-level rules.
   */
  function fireFragmentRules(section, fragment) {
    const rules = parseAnimRules(fragment.dataset.ipeAnimate);
    for (const rule of rules) {
      if ('from' in rule || 'to' in rule || 'fromTo' in rule) {
        const els = rule.sel ? [...section.querySelectorAll(`svg ${rule.sel}`)] : [];
        fireGsap(section, els, rule);
        continue;
      }
      if (rule.script) {
        const fn = scriptRegistry.get(rule.script);
        if (!fn) {
          console.warn(`IpeLayers: no script registered for "${rule.script}"`);
          continue;
        }
        const els = rule.sel ? [...section.querySelectorAll(`svg ${rule.sel}`)] : [];
        fn(els, rule, { section, trigger: 'fragment', prevVisible: new Set(), nextVisible: new Set() });
        continue;
      }
      if (!rule.anim || !rule.sel) continue;
      const els = [...section.querySelectorAll(`svg ${rule.sel}`)];
      playAnimationForElements(els, rule);
    }
  }

  // -------------------------------------------------------------------------
  // Plugin
  // -------------------------------------------------------------------------

  return {
    id: 'ipe-layers',

    /**
     * Register a named animation script for use in {"script": "name"} rules.
     *
     * fn(els, rule, ctx) is called when the rule's trigger fires:
     *   els  — array of matched DOM elements (from rule.sel, filtered for "reveal")
     *   rule — the full rule object, including rule.args for per-rule config
     *   ctx  — { section, trigger, prevVisible: Set, nextVisible: Set }
     *
     * Scripts may use any animation library (SVG.js, GSAP, anime.js, …).
     * Because Cairo bakes a Y-flip + translation into each element's SVG
     * transform attribute, CSS transforms applied to those elements will
     * conflict with it.  Libraries that modify the SVG transform attribute
     * directly (e.g. SVG.js with relative: true) or that only change other
     * attributes (e.g. path morphing via plot()) are not affected.
     */
    registerScript(name, fn) {
      scriptRegistry.set(name, fn);
    },

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
        fireRules(currentSlide, rules, 'slide', new Set(), nextVisible);
        // "reveal": fires only when the slide is entered at its initial state,
        // i.e. no fragments are active yet.  When navigating backward (or
        // jumping to a later fragment step), reveal.js pre-marks fragments as
        // .visible before this event, so the check below is false and we skip
        // the animation — elements must appear instantly at their final state.
        // Without this guard, staggered animations would leave elements stuck
        // at the `from` keyframe (opacity:0 / translated) for their delay
        // period, making them invisible or partially animated on arrival.
        const atInitialStep =
          currentSlide.querySelector('.fragment.ipe-view.visible') === null;
        if (atInitialStep) {
          fireRules(currentSlide, rules, 'reveal', new Set(), nextVisible);
        }
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

        const prevVisible = layersState.get(section) ?? new Set();
        const layersStr   = currentLayers(section, pageInfo);
        const nextVisible = new Set(layersStr.trim().split(/\s+/).filter(Boolean));

        // "conceal" fires BEFORE applyLayers so elements are still visible
        // when reverse animations start.
        const sectionRules = parseAnimRules(section.dataset.ipeAnimate);
        fireRules(section, sectionRules, 'conceal', prevVisible, nextVisible);

        applyLayers(section, pageInfo, layersStr);
        layersState.set(section, nextVisible);
      });
    },
  };
})();
