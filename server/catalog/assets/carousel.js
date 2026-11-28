(() => {
  'use strict';
  let dispose;
  function initialize() {
    dispose?.();
    const lifetime = new AbortController(), cleanups = [];
    dispose = () => { lifetime.abort(); cleanups.forEach(cleanup => cleanup()); };
    for (const shelf of document.querySelectorAll('[data-carousel]')) {
      const track = shelf.querySelector('[data-carousel-track]'), controls = shelf.querySelector('[data-carousel-controls]');
      const cards = [...track.children], previous = shelf.querySelector('[data-carousel-step="-1"]'), next = shelf.querySelector('[data-carousel-step="1"]');
      const status = shelf.querySelector('[data-carousel-status]');
      let timer;
      const update = () => {
        const maximum = track.scrollWidth - track.clientWidth;
        controls.hidden = maximum <= 2;
        previous.disabled = track.scrollLeft <= 2;
        next.disabled = track.scrollLeft >= maximum - 2;
        const bounds = track.getBoundingClientRect();
        const visible = cards.map((card, index) => ({ index, bounds: card.getBoundingClientRect() }))
          .filter(card => Math.min(card.bounds.right, bounds.right) - Math.max(card.bounds.left, bounds.left) >= card.bounds.width / 2);
        const first = (visible[0]?.index ?? 0) + 1, last = (visible.at(-1)?.index ?? 0) + 1;
        const text = `${first === last ? first : first + '–' + last} de ${cards.length}`;
        if (status.textContent !== text) status.textContent = text;
      };
      const scroll = left => track.scrollTo({ left, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      const advance = direction => {
        const pitch = cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : track.clientWidth;
        const gap = pitch - cards[0].getBoundingClientRect().width;
        const perPage = Math.max(1, Math.floor((track.clientWidth + gap + 1) / pitch));
        const current = Math.round(track.scrollLeft / pitch);
        scroll((current + direction * perPage) * pitch);
      };
      for (const button of [previous, next]) button.addEventListener('click', () => advance(Number(button.dataset.carouselStep)), { signal: lifetime.signal });
      track.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(update, 100); }, { passive: true, signal: lifetime.signal });
      track.addEventListener('keydown', event => {
        if (event.target !== track || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); advance(event.key === 'ArrowRight' ? 1 : -1); }
        else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); scroll(event.key === 'Home' ? 0 : track.scrollWidth); }
      }, { signal: lifetime.signal });
      if (window.ResizeObserver) {
        const observer = new ResizeObserver(update); observer.observe(track);
        cleanups.push(() => observer.disconnect());
      } else addEventListener('resize', update, { signal: lifetime.signal });
      cleanups.push(() => clearTimeout(timer));
      update();
    }
  }
  addEventListener('catalog:navigated', initialize);
  initialize();
})();
