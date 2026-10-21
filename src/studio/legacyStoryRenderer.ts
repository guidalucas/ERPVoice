import { moneyLabel, brandInitials, textOnColor } from './types';
import { studioFetch } from './api';
import type { StorySnapshot } from './storyRenderer';

function fittedText(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, width: number, maxSize: number, minSize: number, maxLines: number, weight = '700') {
  for (let size = maxSize; size >= minSize; size -= 2) {
    ctx.font = `${weight} ${size}px Arial`;
    const lines: string[] = []; let line = '', tooWide = false;
    for (const word of value.split(/\s+/)) {
      if (ctx.measureText(word).width > width) { tooWide = true; break; }
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    if (!tooWide && lines.length <= maxLines) { lines.forEach((text, index) => ctx.fillText(text, x, y + index * size * 1.15)); return; }
  }
  throw new Error('El texto no entra en la plantilla. Acortá el título o el mensaje y volvé a generar.');
}

/** One native Canvas, actual photo pixels and deterministic versioned layout. */
export async function renderLegacyStory(canvas: HTMLCanvasElement, snapshot: StorySnapshot, photo: Blob, format: 'png' | 'jpeg') {
  if (![1, 2, 3].includes(snapshot.rendererVersion) || snapshot.width !== 1080 || snapshot.height !== 1920) throw new Error('Actualizá Studio para usar esta versión de historia.');
  await document.fonts.ready;
  const bitmap = await createImageBitmap(photo), ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); throw new Error('Este navegador no permite renderizar la historia.'); }
  canvas.width = 1080; canvas.height = 1920;
  const content = snapshot.content, settings = content.settings, last = settings.templateId === 'last_unit', promo = content.promotion;
  const appearance = content.appearance, primary = appearance?.primaryColor ?? '#001A4D', accent = appearance?.accentColor ?? '#FF6A00';
  const ink = appearance ? textOnColor(primary) : '#ffffff', accentInk = appearance ? textOnColor(accent) : '#ffffff';
  let logo: ImageBitmap | null = null;
  try {
    if (appearance?.logoId) logo = await createImageBitmap(await (await studioFetch(`/brand-assets/${appearance.logoId}`)).blob());
    ctx.fillStyle = primary; ctx.fillRect(0, 0, 1080, 1920);
    ctx.strokeStyle = '#18386a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(1080, 1820, 520, 0, Math.PI * 2); ctx.stroke();
    if (logo) { const scale = Math.min(160 / logo.width, 110 / logo.height); ctx.drawImage(logo, 76 + (160 - logo.width * scale) / 2, 60 + (110 - logo.height * scale) / 2, logo.width * scale, logo.height * scale); }
    else { ctx.fillStyle = ink; ctx.font = 'italic 900 76px Arial'; ctx.fillText(appearance ? brandInitials(content.brandName) : 'FM', 76, 150); }
    ctx.fillStyle = accent; ctx.font = '900 70px Arial'; ctx.fillText('／', 240, 150);
    ctx.fillStyle = appearance ? ink : '#b3c0d6'; fittedText(ctx, content.brandName.toUpperCase(), 300, 135, 680, 25, 18, 1);
    ctx.fillStyle = ink;
    fittedText(ctx, content.heading, 76, 300, promo ? 660 : 928, last ? 57 : 48, 28, promo ? 1 : 2, '900');
    if (promo) { ctx.fillStyle = accent; ctx.fillRect(790, 242, 214, 85); ctx.fillStyle = accentInk; fittedText(ctx, `${promo.percentage}% OFF`, 805, 298, 185, 40, 28, 1, '900'); }
    if (settings.templateId === 'matchday') { ctx.fillStyle = accent; ctx.save(); ctx.translate(1004, 230); ctx.rotate(0.12); ctx.fillRect(-280, -55, 280, 12); ctx.restore(); }
    ctx.fillStyle = ink; fittedText(ctx, content.title, 76, 409, 928, 54, 30, 2, '800');
    ctx.fillStyle = appearance ? ink : '#a2b4d3'; ctx.font = '400 25px Arial';
    ctx.fillText(`${content.season}  ·  ${content.versionKey === 'player' ? 'VERSIÓN JUGADOR' : 'VERSIÓN HINCHA'}`, 76, 495);
    const box = { x: 76, y: 545, w: 928, h: promo ? 710 : 750 };
    ctx.fillStyle = '#f4f5f7'; ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
    const scale = (settings.fit === 'cover' ? Math.max(box.w / bitmap.width, box.h / bitmap.height) : Math.min(box.w / bitmap.width, box.h / bitmap.height)) * settings.zoom;
    const width = bitmap.width * scale, height = bitmap.height * scale;
    ctx.drawImage(bitmap, box.x + (box.w - width) * settings.focalX, box.y + (box.h - height) * settings.focalY, width, height); ctx.restore();
    ctx.fillStyle = accent; ctx.fillRect(76, 545, 7, 90);
    if (promo && settings.showPrice) {
      ctx.fillStyle = appearance ? ink : '#91a5c7'; ctx.font = '400 25px Arial';
      const original = `Antes ${content.price.minAmountMinor !== content.price.maxAmountMinor ? 'desde ' : ''}${moneyLabel({ amountMinor: content.price.minAmountMinor, currency: content.price.currency, fractionDigits: content.price.fractionDigits })}`;
      ctx.fillText(original, 76, 1320); ctx.fillRect(76, 1310, ctx.measureText(original).width, 2);
    }
    if (settings.showPrice) {
      const range = promo ?? content.price;
      const price = `${range.minAmountMinor !== range.maxAmountMinor ? 'Desde ' : ''}${moneyLabel({ amountMinor: range.minAmountMinor, currency: content.price.currency, fractionDigits: content.price.fractionDigits })}`;
      ctx.fillStyle = ink; fittedText(ctx, price, 76, 1395, 928, 62, 30, 1, '800');
    }
    ctx.fillStyle = appearance ? ink : '#96aacd'; ctx.font = '700 20px Arial'; ctx.fillText('TALLES DISPONIBLES', 76, 1460);
    ctx.fillStyle = ink; fittedText(ctx, content.variants.map(variant => variant.size).join('   ·   '), 76, 1515, 928, 37, 22, 1);
    ctx.fillStyle = appearance ? ink : '#bdcbe1'; fittedText(ctx, settings.caption, 76, 1570, 928, 25, 18, 1, '400');
    if (promo) { ctx.fillStyle = appearance ? ink : '#91a5c7'; ctx.font = '400 18px Arial'; const until = new Intl.DateTimeFormat('es', { timeZone: promo.timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(promo.endsAt)); ctx.fillText(`Promoción vigente hasta ${until}`, 76, 1598); }
    ctx.fillStyle = accent; ctx.fillRect(76, 1620, 928, 88);
    ctx.fillStyle = accentInk; fittedText(ctx, settings.cta || 'CONSULTANOS POR WHATSAPP', 112, 1675, 856, 30, 20, 1);
    ctx.fillStyle = appearance ? ink : '#b3c0d6'; fittedText(ctx, appearance?.tagline ?? 'CASACAS CON HISTORIA. PASIÓN POR EL FÚTBOL.', 76, 1810, 928, 24, 16, 2);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No pude exportar la imagen.')), `image/${format}`, format === 'jpeg' ? 0.93 : undefined));
  } finally { bitmap.close(); logo?.close(); }
}
