import { toCanvas } from 'html-to-image';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/700.css';
import './stories.css';
import { moneyLabel, brandInitials, textOnColor, type Money, type Appearance } from './types';
import { studioFetch } from './api';
import { renderLegacyStory } from './legacyStoryRenderer';
export type Promotion = { percentage: number; startsAt: string; endsAt: string; timeZone: string; label: string };
export type StorySettings = { templateId: string; templateVersion: number; imageId: string; expectedImageRevision: number;
  skuIds: string[]; showPrice: boolean; fit: 'contain' | 'cover'; zoom: number; focalX: number; focalY: number; caption: string; cta: string; promotion?: Promotion | null };
export type StorySnapshot = { snapshotId: string; schemaVersion: number; rendererVersion: number; width: number; height: number; createdAt: string; expiresAt: string;
  content: { productId: string; title: string; teamName: string; season: string; versionKey: string; brandName: string; appearance?: Pick<Appearance, 'logoId' | 'primaryColor' | 'accentColor' | 'tagline'>;
    heading: string; assertion: string; availableQuantity: number; imageId: string; variants: { skuId: string; size: string; stockAvailable: number; price: Money }[];
    price: { currency: string; fractionDigits: number; minAmountMinor: string; maxAmountMinor: string };
    promotion?: (Promotion & { minAmountMinor: string; maxAmountMinor: string }) | null; settings: StorySettings } };

const STAGE_H = 1300;
const esc = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const overflowMessage = 'El texto no entra en la plantilla. Acortá el título o el mensaje y volvé a generar.';

/** Fit against actual browser metrics, including unbroken prices and CTA text. */
function fitText(element: HTMLElement, minSize: number, maxHeight = Infinity) {
  let size = parseFloat(getComputedStyle(element).fontSize);
  while ((element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > maxHeight) && size > minSize) {
    size = Math.max(minSize, size - 2); element.style.fontSize = `${size}px`;
  }
  if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > maxHeight) throw new Error(overflowMessage);
}

/** HTML/CSS en un nodo fuera de pantalla → imagen 1080×1920. La foto usa los píxeles reales y el mismo encuadre (fit, zoom, focal) que antes. */
export async function renderStory(canvas: HTMLCanvasElement, snapshot: StorySnapshot, photo: Blob, format: 'png' | 'jpeg') {
  if ([1, 2, 3].includes(snapshot.rendererVersion)) return renderLegacyStory(canvas, snapshot, photo, format);
  if (snapshot.rendererVersion !== 4 || snapshot.width !== 1080 || snapshot.height !== 1920) throw new Error('Actualizá Studio para usar esta versión de historia.');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Este navegador no permite renderizar la historia.');
  const content = snapshot.content, settings = content.settings, promo = content.promotion, appearance = content.appearance;
  const primary = appearance?.primaryColor ?? '#001A4D', accent = settings.templateId === 'last_unit' ? '#ff2d55' : appearance?.accentColor ?? '#FF6A00';
  const ink = textOnColor(primary), accentInk = textOnColor(accent);
  const bitmap = await createImageBitmap(photo), urls: string[] = [], holder = document.createElement('div'), node = document.createElement('div');
  try {
    const url = (blob: Blob) => { const value = URL.createObjectURL(blob); urls.push(value); return value; };
    const scale = (settings.fit === 'cover' ? Math.max(1080 / bitmap.width, STAGE_H / bitmap.height) : Math.min(1080 / bitmap.width, STAGE_H / bitmap.height)) * settings.zoom;
    const width = bitmap.width * scale, height = bitmap.height * scale, left = (1080 - width) * settings.focalX, top = (STAGE_H - height) * settings.focalY;
    const logo = appearance?.logoId ? url(await (await studioFetch(`/brand-assets/${appearance.logoId}`)).blob()) : null;
    const money = (amountMinor: string) => moneyLabel({ amountMinor, currency: content.price.currency, fractionDigits: content.price.fractionDigits });
    const range = promo ?? content.price, from = range.minAmountMinor !== range.maxAmountMinor;
    const until = promo ? new Intl.DateTimeFormat('es', { timeZone: promo.timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(promo.endsAt)) : '';
    const initials = appearance ? brandInitials(content.brandName) : 'FM';
    node.className = `st st-${esc(settings.templateId)}`;
    ([['--primary', primary], ['--accent', accent], ['--ink', ink], ['--accent-ink', accentInk]] as const).forEach(([key, value]) => node.style.setProperty(key, value));
    node.innerHTML = `
      <div class="st-stage"><img class="st-shot" alt="" src="${url(photo)}" style="width:${width}px;height:${height}px;left:${left}px;top:${top}px">
        <header class="st-head"><div class="st-logo">${logo ? `<img src="${logo}">` : esc(initials)}</div><span class="st-brand">${esc(content.brandName)}</span></header>
        <span class="st-badge">${esc(content.heading)}</span>
        ${settings.templateId === 'last_unit' ? `<div class="st-ribbon">${content.assertion === 'last_total' ? 'SOLO QUEDA 1' : 'ÚLTIMA EN ESTE TALLE'}</div>` : ''}
        ${promo ? `<div class="st-burst"><b>${promo.percentage}%</b><span>OFF</span></div>` : ''}</div>
      <div class="st-panel">
        <h1 class="st-title">${esc(content.title)}</h1>
        <p class="st-meta">${esc(content.season)} · ${content.versionKey === 'player' ? 'VERSIÓN JUGADOR' : 'VERSIÓN HINCHA'}</p>
        <div class="st-info"><div class="st-price">${settings.showPrice ? `${promo ? `<small>Antes ${content.price.minAmountMinor !== content.price.maxAmountMinor ? 'desde ' : ''}${esc(money(content.price.minAmountMinor))}</small>` : ''}<b>${from ? '<i>Desde</i> ' : ''}${esc(money(range.minAmountMinor))}</b>` : ''}</div>
          <div class="st-sizes"><p>TALLES DISPONIBLES</p><div class="st-chips">${content.variants.map(variant => `<span class="st-chip">${esc(variant.size)}</span>`).join('')}</div></div></div>
        ${settings.caption ? `<p class="st-note">${esc(settings.caption)}</p>` : ''}
        ${promo ? `<p class="st-note st-until">Promoción vigente hasta ${esc(until)}</p>` : ''}
        <div class="st-cta">${esc(settings.cta || 'CONSULTANOS POR WHATSAPP')}</div>
        <footer class="st-foot">${esc(appearance?.tagline ?? 'CASACAS CON HISTORIA. PASIÓN POR EL FÚTBOL.')}</footer></div>`;
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none';
    holder.setAttribute('aria-hidden', 'true'); holder.inert = true;
    holder.append(node); document.body.append(holder);
    await document.fonts.ready;
    await Promise.all(['800 74px "Barlow Condensed"', '700 28px "Barlow Condensed"', '700 20px Barlow', '500 26px Barlow'].map(font => document.fonts.load(font)));
    await Promise.all([...node.querySelectorAll('img')].map(image => image.decode()));
    fitText(node.querySelector<HTMLElement>('.st-brand')!, 18);
    fitText(node.querySelector<HTMLElement>('.st-badge')!, 24, 150);
    fitText(node.querySelector<HTMLElement>('.st-title')!, 42, 150);
    const price = node.querySelector<HTMLElement>('.st-price b');
    if (price) fitText(price, 36);
    const originalPrice = node.querySelector<HTMLElement>('.st-price small');
    if (originalPrice) fitText(originalPrice, 20);
    fitText(node.querySelector<HTMLElement>('.st-cta')!, 26);
    const panel = node.querySelector<HTMLElement>('.st-panel')!;
    if (panel.scrollHeight > panel.clientHeight + 1 || panel.scrollWidth > panel.clientWidth + 1) throw new Error(overflowMessage);
    const rendered = await toCanvas(node, { width: 1080, height: 1920, pixelRatio: 1 });
    canvas.width = 1080; canvas.height = 1920; ctx.drawImage(rendered, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No pude exportar la imagen.')), `image/${format}`, format === 'jpeg' ? 0.93 : undefined));
  } finally { bitmap.close(); holder.remove(); urls.forEach(item => URL.revokeObjectURL(item)); }
}
