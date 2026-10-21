import { moneyLabel, type Money } from './types';
export type StorySettings = { templateId: string; templateVersion: number; imageId: string; expectedImageRevision: number;
  skuIds: string[]; showPrice: boolean; fit: 'contain' | 'cover'; zoom: number; focalX: number; focalY: number; caption: string; cta: string };
export type StorySnapshot = { snapshotId: string; schemaVersion: number; rendererVersion: number; width: number; height: number; createdAt: string; expiresAt: string;
  content: { productId: string; title: string; teamName: string; season: string; versionKey: string; brandName: string;
    heading: string; assertion: string; availableQuantity: number; imageId: string; variants: { skuId: string; size: string; stockAvailable: number; price: Money }[];
    price: { currency: string; fractionDigits: number; minAmountMinor: string; maxAmountMinor: string }; settings: StorySettings } };

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
export async function renderStory(canvas: HTMLCanvasElement, snapshot: StorySnapshot, photo: Blob, format: 'png' | 'jpeg') {
  if (snapshot.rendererVersion !== 1 || snapshot.width !== 1080 || snapshot.height !== 1920) throw new Error('Actualizá Studio para usar esta versión de historia.');
  await document.fonts.ready;
  const bitmap = await createImageBitmap(photo), ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); throw new Error('Este navegador no permite renderizar la historia.'); }
  canvas.width = 1080; canvas.height = 1920;
  const content = snapshot.content, settings = content.settings, last = settings.templateId === 'last_unit';
  try {
    ctx.fillStyle = '#001A4D'; ctx.fillRect(0, 0, 1080, 1920);
    ctx.strokeStyle = '#18386a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(1080, 1820, 520, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = 'italic 900 76px Arial'; ctx.fillText('FM', 76, 150);
    ctx.fillStyle = '#FF6A00'; ctx.font = '900 70px Arial'; ctx.fillText('／', 190, 150);
    ctx.fillStyle = '#b3c0d6'; fittedText(ctx, content.brandName.toUpperCase(), 300, 135, 680, 25, 18, 1);
    ctx.fillStyle = last ? '#FF6A00' : '#ffffff';
    fittedText(ctx, content.heading, 76, 300, 928, last ? 57 : 48, 30, 2, '900');
    ctx.fillStyle = '#ffffff'; fittedText(ctx, content.title, 76, 409, 928, 54, 30, 2, '800');
    ctx.fillStyle = '#a2b4d3'; ctx.font = '400 25px Arial';
    ctx.fillText(`${content.season}  ·  ${content.versionKey === 'player' ? 'VERSIÓN JUGADOR' : 'VERSIÓN HINCHA'}`, 76, 495);
    const box = { x: 76, y: 545, w: 928, h: 750 };
    ctx.fillStyle = '#f4f5f7'; ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
    const scale = (settings.fit === 'cover' ? Math.max(box.w / bitmap.width, box.h / bitmap.height) : Math.min(box.w / bitmap.width, box.h / bitmap.height)) * settings.zoom;
    const width = bitmap.width * scale, height = bitmap.height * scale;
    ctx.drawImage(bitmap, box.x + (box.w - width) * settings.focalX, box.y + (box.h - height) * settings.focalY, width, height); ctx.restore();
    ctx.fillStyle = '#FF6A00'; ctx.fillRect(76, 545, 7, 90);
    if (settings.showPrice) {
      const price = `${content.price.minAmountMinor !== content.price.maxAmountMinor ? 'Desde ' : ''}${moneyLabel({ amountMinor: content.price.minAmountMinor, currency: content.price.currency, fractionDigits: content.price.fractionDigits })}`;
      ctx.fillStyle = '#ffffff'; fittedText(ctx, price, 76, 1395, 928, 62, 30, 1, '800');
    }
    ctx.fillStyle = '#96aacd'; ctx.font = '700 20px Arial'; ctx.fillText('TALLES DISPONIBLES', 76, 1460);
    ctx.fillStyle = '#ffffff'; fittedText(ctx, content.variants.map(variant => variant.size).join('   ·   '), 76, 1515, 928, 37, 22, 1);
    ctx.fillStyle = '#bdcbe1'; fittedText(ctx, settings.caption, 76, 1570, 928, 25, 18, 1, '400');
    ctx.fillStyle = '#FF6A00'; ctx.fillRect(76, 1620, 928, 88);
    ctx.fillStyle = '#ffffff'; fittedText(ctx, settings.cta || 'CONSULTANOS POR WHATSAPP', 112, 1675, 856, 30, 20, 1);
    ctx.fillStyle = '#5f7cae'; ctx.font = '700 19px Arial'; ctx.fillText('CASACAS CON HISTORIA. PASIÓN POR EL FÚTBOL.', 76, 1810);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No pude exportar la imagen.')), `image/${format}`, format === 'jpeg' ? 0.93 : undefined));
  } finally { bitmap.close(); }
}
