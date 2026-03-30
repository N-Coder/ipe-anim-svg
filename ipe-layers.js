/**
 * ipe-layers.js — reveal.js plugin for Ipe SVG presentations.
 *
 * Reads page/layer/view metadata from #ipe-meta, resolves <section> elements
 * to Ipe pages (by index, by title, or sequentially), fetches and injects the
 * per-page SVG, auto-fills missing view-fragment <span>s, and drives layer
 * visibility as the presentation navigates.
 *
 * Data attributes consumed:
 *   <div class="slides" data-ipe-no-auto>   — do not autogenerate missing sections during page assignment
 *   <section data-ipe-page="N">             — select page by 1-based index
 *   <section data-ipe-page="Title">         — select page by title
 *   <section data-ipe-no-auto>              — disable view-fragment auto-fill for this slide
 *   <span class="fragment ipe-view"
 *         data-visible-layers="a b c">      — hand-authored view fragment
 */

const IpeLayers = (() => {
  'use strict';

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  function parseMeta() {
    const el = document.getElementById('ipe-meta');
    if (!el) throw new Error('IpeLayers: #ipe-meta element not found.');
    return JSON.parse(el.textContent);
  }

  // -------------------------------------------------------------------------
  // Page resolution
  // -------------------------------------------------------------------------

  /**
   * Map a <section> to a page metadata object.
   * usedSet tracks which page indices have already been assigned so that
   * attribute-free sections get sequential pages.
   */
  function resolvePage(section, pages, usedSet) {
    const attr = section.dataset.ipePage;

    if (attr !== undefined) {
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

    // No attribute: take the next not-yet-assigned page
    for (let i = 0; i < pages.length; i++) {
      if (!usedSet.has(i)) {
        usedSet.add(i);
        return pages[i];
      }
    }
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
  // Plugin
  // -------------------------------------------------------------------------

  return {
    id: 'ipe-layers',

    async init(deck) {
      let meta;
      try {
        meta = parseMeta();
      } catch (e) {
        console.error(e);
        return;
      }

      const pages    = meta.pages;
      const slidesEl = deck.getRevealElement().querySelector('.slides');
      const globalNoAuto = slidesEl.hasAttribute('data-ipe-no-auto'); // FIXME this should mean that sections shouldn't be autogenerated

      // Collect only direct-child <section>s (ignore vertical stacks for now)
      const sections = [...slidesEl.querySelectorAll(':scope > section')];

      // Resolve page assignments synchronously to preserve document order
      const usedSet       = new Set();
      const sectionPageMap = new Map();
      for (const section of sections) {
        const pageInfo = resolvePage(section, pages, usedSet);
        if (pageInfo) sectionPageMap.set(section, pageInfo);
      }

      // Inject SVGs and prepare fragments (async, in parallel per section).
      // View-fragment auto-fill is controlled per section via data-ipe-no-auto.
      await Promise.all(
        [...sectionPageMap.entries()].map(async ([section, pageInfo]) => {
          const noAuto = section.hasAttribute('data-ipe-no-auto');

          await injectSVG(section, pageInfo);
          tagLayerElements(section, pageInfo);

          if (!noAuto) autoFillFragments(section, pageInfo);

          // Apply view 1 as the starting visibility state
          applyLayers(section, pageInfo, pageInfo.views[0]);
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
        applyLayers(currentSlide, pageInfo, currentLayers(currentSlide, pageInfo));
      });

      deck.on('fragmentshown', ({ fragment }) => {
        if (!fragment.classList.contains('ipe-view')) return;
        const section  = fragment.closest('section');
        const pageInfo = sectionPageMap.get(section);
        if (!pageInfo) return;
        applyLayers(section, pageInfo, fragment.dataset.visibleLayers ?? '');
      });

      deck.on('fragmenthidden', ({ fragment }) => {
        if (!fragment.classList.contains('ipe-view')) return;
        const section  = fragment.closest('section');
        const pageInfo = sectionPageMap.get(section);
        if (!pageInfo) return;
        applyLayers(section, pageInfo, currentLayers(section, pageInfo));
      });
    },
  };
})();
