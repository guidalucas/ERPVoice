(() => {
  'use strict';
  const shop = document.body.dataset.catalog;
  if (!shop || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(shop)) return;
  const key = `fullmatch.inquiry.${shop}`, isInquiry = Boolean(document.getElementById('inquiry-lines'));
  let cart = read(), quote = null, generation = 0, busy = false;
  function read() {
    try {
      const raw = localStorage.getItem(key); if (!raw || raw.length > 20_000) return [];
      const value = JSON.parse(raw); if (!Array.isArray(value) || value.length > 20) return [];
      const unique = new Map();
      for (const item of value) if (item && typeof item.productSlug === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(item.productSlug) && item.productSlug.length <= 120
        && typeof item.size === 'string' && item.size.length > 0 && item.size.length <= 40 && Number.isSafeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 10) {
        const size = item.size.normalize('NFC').trim(); unique.set(JSON.stringify([item.productSlug, size.toLocaleLowerCase('es')]), { productSlug: item.productSlug, size, quantity: item.quantity });
      }
      return [...unique.values()];
    } catch { return []; }
  }
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  function store(next) { localStorage.setItem(key, JSON.stringify(next)); cart = next; quote = null; updateCount(); }
  function updateCount() { for (const count of document.querySelectorAll('[data-cart-count]')) count.textContent = String(cart.reduce((sum, item) => sum + item.quantity, 0)); }
  const message = text => { const target = document.getElementById('inquiry-message'); if (target) target.textContent = text; };
  const money = value => {
    if (!value) return '—'; const amount = BigInt(value.amountMinor), scale = 10n ** BigInt(value.fractionDigits), cents = (amount % scale).toString().padStart(value.fractionDigits, '0');
    return `${value.currency} $ ${(amount / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${Number(cents) ? ',' + cents : ''}`;
  };
  function controls() {
    const contact = document.getElementById('inquiry-contact'), refresh = document.getElementById('inquiry-refresh'), clear = document.getElementById('inquiry-clear');
    if (contact) contact.disabled = busy || !quote?.canContact;
    if (refresh) refresh.disabled = busy || !cart.length;
    if (clear) { clear.disabled = busy; clear.hidden = !cart.length; }
    for (const control of document.querySelectorAll('#inquiry-lines input,#inquiry-lines button')) control.disabled = busy;
  }
  function render(result) {
    const target = document.getElementById('inquiry-lines'); if (!target) return; target.replaceChildren();
    document.getElementById('inquiry-empty').hidden = cart.length > 0;
    document.getElementById('inquiry-total').textContent = money(result?.total);
    document.getElementById('inquiry-checked').textContent = result ? `Datos revisados a las ${new Date(result.quotedAt).toLocaleTimeString('es-UY')}.` : '';
    for (const [index, line] of (result?.lines ?? []).entries()) {
      const row = node('article', undefined, `inquiry-line${line.available ? '' : ' unavailable'}`), detail = node('div', undefined, 'inquiry-line-detail');
      const title = node(line.path ? 'a' : 'strong', line.title); if (line.path) title.href = line.path;
      detail.append(title, node('small', `Talle ${line.size} · ${money(line.unitPrice)} c/u`));
      if (!line.available) detail.append(node('p', 'Revisá el talle o la cantidad disponible.', 'line-warning'));
      const quantityLabel = node('label', 'Cantidad'), quantity = node('input'); quantity.type = 'number'; quantity.min = '1'; quantity.max = '10'; quantity.step = '1'; quantity.value = String(line.quantity); quantity.setAttribute('aria-label', `Cantidad ${line.title} talle ${line.size}`);
      quantity.addEventListener('change', () => {
        const value = Number(quantity.value); if (!Number.isSafeInteger(value) || value < 1 || value > 10) { quantity.value = String(cart[index].quantity); message('Elegí entre una y diez unidades por talle.'); return; }
        try { const next = cart.map((item, position) => position === index ? { ...item, quantity: value } : item); store(next); void refresh(false); } catch { message('No pude conservar el cambio en este navegador.'); }
      }); quantityLabel.append(quantity);
      const remove = node('button', 'Retirar'); remove.type = 'button'; remove.addEventListener('click', () => { try { store(cart.filter((_item, position) => position !== index)); void refresh(false); } catch { message('No pude conservar el cambio.'); } });
      row.append(detail, quantityLabel, node('strong', money(line.lineTotal), 'line-total'), remove); target.append(row);
    }
    controls();
  }
  async function refresh(compare = false) {
    const attempt = ++generation, previous = compare ? quote?.fingerprint ?? null : null;
    if (!cart.length) { quote = null; busy = false; render(null); message(''); return null; }
    busy = true; quote = null; controls(); message('Revisando precios y disponibilidad…');
    try {
      const response = await fetch(`/api/catalog/v1/${shop}/inquiry-preview`, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: cart, previousFingerprint: previous }), signal: AbortSignal.timeout(15_000) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || 'No pude revisar la consulta.');
      if (attempt !== generation) return null; quote = result; render(result);
      message(result.changed ? 'Cambiaron los datos de tu consulta. Revisá los importes actuales y volvé a confirmar.' : !result.canContact ? 'Hay camisetas, talles o cantidades que necesitan revisión.' : 'Tu consulta está lista para revisar con el comercio.');
      return result;
    } catch (error) { if (attempt === generation) { quote = null; message(error instanceof Error ? error.message : 'No pude revisar la consulta.'); } return null; }
    finally { if (attempt === generation) { busy = false; controls(); } }
  }
  updateCount();
  addEventListener('storage', event => { if (event.key === key) { cart = read(); quote = null; updateCount(); if (isInquiry) void refresh(false); } });
  for (const form of document.querySelectorAll('[data-add-inquiry]')) form.addEventListener('submit', event => {
    event.preventDefault(); const status = form.querySelector('[data-inquiry-status]');
    try {
      const productSlug = form.dataset.product, size = form.elements.namedItem('size').value, quantity = Number(form.elements.namedItem('quantity').value);
      if (!size || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) throw new Error('Elegí un talle y una cantidad válida.');
      const next = read(), existing = next.find(item => item.productSlug === productSlug && item.size === size);
      if (existing) { if (existing.quantity + quantity > 10) throw new Error('Podés consultar hasta diez unidades por talle.'); existing.quantity += quantity; }
      else { if (next.length >= 20) throw new Error('Podés incluir hasta veinte talles en una consulta.'); next.push({ productSlug, size, quantity }); }
      store(next); status.textContent = 'Agregada a tu consulta. Podés seguir eligiendo o revisar el resumen.';
    } catch (error) { status.textContent = error instanceof Error ? error.message : 'No pude conservar la consulta en este navegador.'; }
  });
  if (isInquiry) {
    document.getElementById('inquiry-refresh').addEventListener('click', () => void refresh(false));
    document.getElementById('inquiry-clear').addEventListener('click', () => { if (!confirm('¿Vaciar tu consulta en este dispositivo?')) return; try { store([]); void refresh(false); } catch { message('No pude vaciar la consulta.'); } });
    document.getElementById('inquiry-contact').addEventListener('click', async () => {
      const latest = await refresh(true);
      if (!latest?.canContact || latest.changed || !latest.contactUrl) return;
      const destination = new URL(latest.contactUrl);
      if (destination.protocol !== 'https:' || destination.hostname !== 'wa.me' || !/^\/[0-9]{8,15}$/.test(destination.pathname)) { message('El contacto comercial no es válido.'); return; }
      location.assign(destination.href);
    });
    void refresh(false);
  }
})();
