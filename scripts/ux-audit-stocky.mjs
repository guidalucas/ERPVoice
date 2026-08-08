/**
 * UX audit crawl for Stocky (local + modo local/invitado).
 * Captures desktop + mobile screenshots and friction metrics.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../ux-audit-screenshots');
const BASE_URL = process.env.STOCKY_URL || 'http://localhost:5173';

const SECTIONS = ['Inicio', 'Productos', 'Pedidos', 'Clientes', 'Actividad'];

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function measureTapTargets(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const interactive = [...document.querySelectorAll('button, a, [role="button"], input, select, textarea')];
    const small = [];
    for (const el of interactive) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) {
        const label =
          el.getAttribute('aria-label') ||
          el.textContent?.trim().slice(0, 40) ||
          el.getAttribute('placeholder') ||
          el.tagName;
        small.push({
          label,
          w: Math.round(r.width),
          h: Math.round(r.height),
          tag: el.tagName.toLowerCase(),
        });
      }
    }
    return { total: interactive.filter(isVisible).length, smallCount: small.length, small: small.slice(0, 25) };
  });
}

async function contrastSamples(page) {
  return page.evaluate(() => {
    const parseColor = (c) => {
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!m) return null;
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (fg, bg) => {
      const L1 = lum(fg);
      const L2 = lum(bg);
      const lighter = Math.max(L1, L2);
      const darker = Math.min(L1, L2);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const effectiveBg = (el) => {
      let cur = el;
      while (cur) {
        const bg = parseColor(getComputedStyle(cur).backgroundColor);
        if (bg && bg.a > 0.9) return bg;
        cur = cur.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };

    const nodes = [...document.querySelectorAll('p, span, h1, h2, h3, h4, button, label, a')].slice(0, 80);
    const weak = [];
    for (const el of nodes) {
      const style = getComputedStyle(el);
      const fg = parseColor(style.color);
      if (!fg || fg.a < 0.5) continue;
      const bg = effectiveBg(el);
      const r = ratio(fg, bg);
      const fontSize = parseFloat(style.fontSize);
      const weight = parseInt(style.fontWeight, 10) || 400;
      const needed = fontSize >= 18 || weight >= 700 ? 3 : 4.5;
      if (r < needed) {
        weak.push({
          text: (el.textContent || '').trim().slice(0, 50),
          ratio: Math.round(r * 100) / 100,
          needed,
          fontSize,
        });
      }
    }
    return weak.slice(0, 20);
  });
}

async function loginGuest(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const guestBtn = page.getByRole('button', { name: /Entrar en modo local/i });
  if (await guestBtn.isVisible().catch(() => false)) {
    await guestBtn.click();
  } else {
    // Already logged in?
    const inicio = page.getByRole('button', { name: /^Inicio$/ });
    if (!(await inicio.first().isVisible().catch(() => false))) {
      throw new Error('No se encontró botón de modo local ni dashboard.');
    }
  }

  await page.waitForSelector('text=Registrar venta', { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(1200);
}

async function hideVoiceFab(page) {
  // El FAB del simulador WhatsApp (z-50) tapa la bottom nav (z-40) en mobile.
  await page.addStyleTag({
    content: '.fixed.bottom-4.left-4.z-50 { visibility: hidden !important; pointer-events: none !important; }',
  });
}

async function goSection(page, label, mobile) {
  if (mobile) {
    const bottom = page.locator('.dashboard-bottom-nav');
    await bottom.getByRole('button', { name: label }).click({ force: true });
  } else {
    await page.locator('.dashboard-sidebar').getByRole('button', { name: label }).click();
  }
  await page.waitForTimeout(700);
}

async function countClicksToSale(page) {
  const steps = [];
  const t0 = Date.now();
  await page.getByRole('button', { name: /Registrar venta/i }).click();
  steps.push({ step: 1, action: 'Click − Registrar venta' });
  await page.waitForTimeout(400);

  const productBtn = page.locator('.fixed.inset-0 button').filter({ hasText: /Disp\./i }).first();
  if (await productBtn.isVisible().catch(() => false)) {
    await productBtn.click();
    steps.push({ step: 2, action: 'Seleccionar producto de la lista' });
  } else {
    steps.push({ step: 2, action: 'Sin productos visibles en modal', blocked: true });
  }

  const confirm = page.getByRole('button', { name: /Confirmar venta|Registrar venta/i }).last();
  const confirmVisible = await confirm.isVisible().catch(() => false);
  steps.push({
    step: 3,
    action: confirmVisible ? 'Click confirmar (no ejecutado para no mutar datos)' : 'Confirmar no visible',
    ms: Date.now() - t0,
  });

  await page.screenshot({ path: path.join(OUT_DIR, 'flow-registrar-venta-modal.png') });
  await page.keyboard.press('Escape').catch(() => null);
  const close = page.getByRole('button', { name: /Cerrar modal/i });
  if (await close.isVisible().catch(() => false)) await close.click();
  await page.waitForTimeout(300);
  return steps;
}

async function countClicksToLowStock(page) {
  const steps = [];
  const t0 = Date.now();
  const card = page.getByRole('button', { name: /Stock bajo/i });
  if (await card.isVisible().catch(() => false)) {
    await card.click();
    steps.push({ step: 1, action: 'Click card Stock bajo / agotado', ms: Date.now() - t0 });
  } else {
    steps.push({ step: 1, action: 'Card stock bajo no clickeable o ausente', blocked: true });
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, 'flow-stock-bajo.png'), fullPage: true });
  return steps;
}

async function explorePedidoCreation(page) {
  // Pedidos panel has no "crear pedido" CTA — only voice/empty guidance
  const createBtn = page.getByRole('button', { name: /nuevo pedido|crear pedido|cargar pedido|agregar pedido/i });
  const hasCreate = await createBtn.count();
  return {
    hasManualCreateCta: hasCreate > 0,
    note:
      hasCreate > 0
        ? 'Existe CTA de crear pedido'
        : 'No hay CTA para cargar pedido manualmente; el empty state solo menciona voz',
  };
}

async function auditViewport(browser, viewport, prefix) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: viewport.width < 500 ? 2 : 1,
    isMobile: viewport.width < 500,
    hasTouch: viewport.width < 500,
  });
  const page = await context.newPage();
  const report = { viewport, sections: {}, a11y: {}, flows: {} };
  const mobile = viewport.width < 500;

  await loginGuest(page);
  await shot(page, `${prefix}-00-login-or-inicio`);
  await shot(page, `${prefix}-01-inicio`);

  // Captura evidencia del overlap FAB vs bottom nav antes de ocultarlo
  if (mobile) {
    report.overlap = await page.evaluate(() => {
      const fab = document.querySelector('.fixed.bottom-4.left-4.z-50');
      const nav = document.querySelector('.dashboard-bottom-nav');
      if (!fab || !nav) return null;
      const a = fab.getBoundingClientRect();
      const b = nav.getBoundingClientRect();
      const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return {
        fab: { x: a.x, y: a.y, w: a.width, h: a.height },
        nav: { x: b.x, y: b.y, w: b.width, h: b.height },
        overlapArea: Math.round(overlapX * overlapY),
        fabBlocksNav: overlapX > 8 && overlapY > 8,
      };
    });
    await shot(page, `${prefix}-fab-vs-bottom-nav-overlap`);
    await hideVoiceFab(page);
  }

  report.a11y.inicio = {
    tapTargets: await measureTapTargets(page),
    contrastWeak: await contrastSamples(page),
  };

  report.flows.venta = await countClicksToSale(page);
  await goSection(page, 'Inicio', mobile);
  report.flows.stockBajo = await countClicksToLowStock(page);

  for (const section of SECTIONS) {
    await goSection(page, section, mobile);
    const slug = section.toLowerCase();
    await shot(page, `${prefix}-${slug}`);

    // scroll mid for long pages
    await page.evaluate(() => window.scrollTo(0, Math.min(600, document.body.scrollHeight)));
    await page.waitForTimeout(200);
    await shot(page, `${prefix}-${slug}-scrolled`);

    report.sections[section] = {
      title: await page.locator('h2, h3').first().innerText().catch(() => null),
      emptyStates: await page.locator('text=/Sin |No hay /i').count(),
      headings: await page.locator('h2, h3, h4').allInnerTexts(),
    };

    if (section === 'Pedidos') {
      report.flows.pedido = await explorePedidoCreation(page);
      await shot(page, `${prefix}-pedidos-detail`);
    }

    if (section === 'Productos') {
      // open first expand / form if available
      const addBtn = page.getByRole('button', { name: /Agregar|Nuevo producto|\+/i }).first();
      if (await addBtn.isVisible().catch(() => false)) {
        await addBtn.click();
        await page.waitForTimeout(400);
        await shot(page, `${prefix}-productos-form`);
        await page.keyboard.press('Escape').catch(() => null);
      }
      report.a11y.productos = { tapTargets: await measureTapTargets(page) };
    }
  }

  // bottom nav closeup on mobile
  if (mobile) {
    await goSection(page, 'Inicio', true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    try {
      const box = await page.locator('.dashboard-bottom-nav').boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        const clip = {
          x: Math.max(0, Math.floor(box.x)),
          y: Math.max(0, Math.floor(box.y)),
          width: Math.min(viewport.width - Math.max(0, Math.floor(box.x)), Math.ceil(box.width)),
          height: Math.min(viewport.height - Math.max(0, Math.floor(box.y)), Math.ceil(box.height)),
        };
        if (clip.width > 0 && clip.height > 0) {
          await page.screenshot({
            path: path.join(OUT_DIR, `${prefix}-bottom-nav-closeup.png`),
            clip,
          });
        }
      }
    } catch {
      // ignore clip errors; full-page shots already cover nav
    }
    report.a11y.bottomNavLabels = await page.locator('.dashboard-bottom-nav-item span').allInnerTexts();
  }

  // First-paint hierarchy: largest text in viewport
  await goSection(page, 'Inicio', mobile);
  report.hierarchy = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('h1,h2,h3,h4,p,button,span')];
    const scored = [];
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight || r.width < 20) continue;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      const weight = parseInt(style.fontWeight, 10) || 400;
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!text) continue;
      scored.push({
        text,
        size,
        weight,
        top: Math.round(r.top),
        score: size * (weight >= 700 ? 1.4 : 1) * (r.top < 200 ? 1.2 : 1),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8);
  });

  await context.close();
  return report;
}

async function main() {
  await ensureDir(OUT_DIR);
  // clear old pngs
  for (const f of await fs.readdir(OUT_DIR)) {
    if (f.endsWith('.png') || f.endsWith('.json')) await fs.unlink(path.join(OUT_DIR, f));
  }

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome', // usa Chrome del sistema (evita descargar Chromium)
  });
  const desktop = await auditViewport(browser, { width: 1440, height: 900 }, 'desktop');
  const mobile = await auditViewport(browser, { width: 390, height: 844 }, 'mobile');

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    mode: 'modo local (invitado/dev bypass)',
    desktop,
    mobile,
  };

  await fs.writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
