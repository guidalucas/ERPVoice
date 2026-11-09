(() => {
  'use strict';
  if (!window.fetch || !window.DOMParser || !history.pushState) return;
  const shop = document.body.dataset.catalog;
  if (!shop || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(shop)) return;
  const root = `/c/${shop}`, snapshots = new Map(), requests = new Map(), prefetched = new Map();
  let current = location.href, generation = 0, hoverTimer;
  history.scrollRestoration = 'manual';
  const eligible = url => url.origin === location.origin && (url.pathname === root || url.pathname.startsWith(`${root}/p/`));
  const key = url => url.pathname + url.search;
  const remember = () => {
    if (new URL(current).pathname === root && document.querySelector('.catalog-grid')) {
      const html = document.documentElement.outerHTML;
      const id = key(new URL(current)); snapshots.delete(id);
      if (html.length <= 1_000_000) snapshots.set(id, { html, scroll: scrollY, at: Date.now() });
      while (snapshots.size > 6) snapshots.delete(snapshots.keys().next().value);
    }
    history.replaceState({ ...history.state, catalogScroll: scrollY }, '');
  };
  async function load(url) {
    const id = key(url);
    if (requests.has(id)) return requests.get(id);
    const work = fetch(id, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15_000) })
      .then(async response => {
        if (!response.ok || response.redirected || !response.headers.get('content-type')?.includes('text/html')) throw new Error('NAVIGATION_UNAVAILABLE');
        const html = await response.text(); if (html.length > 1_000_000) throw new Error('PAGE_TOO_LARGE'); return html;
      }).finally(() => requests.delete(id));
    requests.set(id, work); return work;
  }
  function display(html, url, position) {
    const next = new DOMParser().parseFromString(html, 'text/html');
    if (next.body.dataset.catalog !== shop || !next.querySelector('main')) throw new Error('INVALID_CATALOG_PAGE');
    document.title = next.title;
    // Replace metadata and theme while keeping shared CSS/JS loaded once.
    for (const selector of ['meta[name="description"]', 'meta[name="theme-color"]', 'meta[property]', 'link[rel="canonical"]', 'script[type="application/ld+json"]']) {
      document.head.querySelectorAll(selector).forEach(node => node.remove());
      next.head.querySelectorAll(selector).forEach(node => document.head.append(node.cloneNode(true)));
    }
    const theme = `link[href^="/catalog-assets/${shop}/theme.css"]`;
    const oldTheme = document.head.querySelector(theme), newTheme = next.head.querySelector(theme);
    if (oldTheme && newTheme && oldTheme.getAttribute('href') !== newTheme.getAttribute('href')) oldTheme.replaceWith(newTheme.cloneNode(true));
    document.body.dataset.preset = next.body.dataset.preset;
    for (const selector of ['header.shop-header', 'main', 'body > footer']) {
      const old = document.querySelector(selector), replacement = next.querySelector(selector);
      if (old && replacement) old.replaceWith(replacement);
    }
    dispatchEvent(new Event('catalog:navigated'));
    if (position != null) scrollTo(0, position);
    else if (url.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
    else scrollTo(0, 0);
  }
  async function navigate(url, { pop = false, restore = null } = {}) {
    const attempt = ++generation;
    if (!pop) remember();
    const snapshot = snapshots.get(key(url));
    // Lists restore immediately (filters and scroll), then always revalidate live data.
    const instant = snapshot && Date.now() - snapshot.at < 10_000;
    // Scroll/filter history remains useful after the short HTML freshness window.
    let position = restore ?? snapshot?.scroll ?? null;
    document.documentElement.setAttribute('aria-busy', 'true');
    try {
      if (!pop) history.pushState({}, '', url.href);
      current = url.href;
      if (instant) display(snapshot.html, url, position);
      const hinted = prefetched.get(key(url)); prefetched.delete(key(url));
      // Intent prefetches have a strict two-second freshness window; never cache errors.
      const html = hinted && Date.now() - hinted.at < 2_000 ? await hinted.work : await load(url);
      if (attempt !== generation) return;
      if (instant) position = scrollY;
      display(html, url, position);
      if (!pop && !instant) {
        const heading = document.querySelector('main h1, main h2');
        if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      }
    } catch {
      if (attempt === generation) location.assign(url.href);
    } finally { if (attempt === generation) document.documentElement.removeAttribute('aria-busy'); }
  }
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download') || link.closest('.public-gallery')) return;
    let url = new URL(link.href);
    if (!eligible(url) || (url.pathname === location.pathname && url.search === location.search && url.hash)) return;
    if (link.matches('a.back')) {
      const prior = [...snapshots.entries()].reverse().find(([path]) => path.split('?')[0] === root);
      if (prior) url = new URL(prior[0], location.origin);
    }
    event.preventDefault(); void navigate(url);
  });
  document.addEventListener('submit', event => {
    const form = event.target;
    if (event.defaultPrevented || !form.matches('.catalog-filters,.header-search') || form.method.toLowerCase() !== 'get') return;
    const url = new URL(form.action); if (!eligible(url)) return;
    url.search = new URLSearchParams(new FormData(form)).toString();
    event.preventDefault(); void navigate(url);
  });
  addEventListener('popstate', event => { void navigate(new URL(location.href), { pop: true, restore: event.state?.catalogScroll ?? 0 }); });
  let scrollScheduled = false;
  addEventListener('scroll', () => {
    if (scrollScheduled) return; scrollScheduled = true;
    requestAnimationFrame(() => { scrollScheduled = false; history.replaceState({ ...history.state, catalogScroll: scrollY }, ''); });
  }, { passive: true });
  // One intent-driven prefetch at a time. No crawling or automatic image downloads.
  document.addEventListener('pointerover', event => {
    const link = event.target.closest('.catalog-card > a');
    if (!link || link.contains(event.relatedTarget) || navigator.connection?.saveData || /2g/.test(navigator.connection?.effectiveType || '')) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const url = new URL(link.href); if (!eligible(url) || requests.size) return;
      const work = load(url); prefetched.clear(); prefetched.set(key(url), { work, at: Date.now() });
      work.catch(() => prefetched.delete(key(url)));
    }, 120);
  });
  document.addEventListener('pointerout', event => { if (event.target.closest('.catalog-card > a')) clearTimeout(hoverTimer); });
})();
