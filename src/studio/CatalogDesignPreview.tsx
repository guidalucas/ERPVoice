import { useEffect, useMemo, useRef, useState } from 'react';
import { renderCatalogList } from '../../server/catalog/render.js';
import catalogCss from '../../server/catalog/assets/catalog.css?raw';
import templateCss from '../../server/catalog/assets/templates.css?raw';
import { catalogDesigns, catalogThemeCss, defaultHeroLayout, type Appearance, type HeroBlock, type HeroLayout } from '../shared/catalogAppearance.js';
import { studioFetch } from './api';
import './catalogDesign.css';

export { catalogDesigns } from '../shared/catalogAppearance.js';

export function useBrandAssetUrls(value: Appearance) {
  const [assets, setAssets] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    setAssets({});
    for (const id of new Set([value.logoId, value.coverId].filter((id): id is string => Boolean(id)))) {
      studioFetch(`/brand-assets/${id}`).then(response => response.blob()).then(blob => {
        if (!active) return;
        const url = URL.createObjectURL(blob); urls.push(url);
        setAssets(current => ({ ...current, [id]: url }));
      }).catch(() => {});
    }
    return () => { active = false; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [value.logoId, value.coverId]);
  return assets;
}

const samplePhoto = (index: number) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="560"><rect width="480" height="560" fill="${['#e6e4df', '#e1e7e5', '#e6e3e8', '#e5e7eb'][index]}"/><rect x="145" y="140" width="190" height="240" rx="22" fill="#fff" opacity=".65"/><path d="M200 140v-20a40 40 0 0 1 80 0v20" fill="none" stroke="#fff" stroke-width="12"/><text x="240" y="440" text-anchor="middle" font-family="Arial" font-size="15" fill="#526174">Imagen de ejemplo</text></svg>`)}`;
const sampleItems = Array.from({ length: 4 }, (_, index) => ({
  title: `Producto de ejemplo ${index + 1}`, path: '#', available: true, priceRange: null,
  category: index % 2 ? 'Accesorios' : 'Novedades',
  photos: [{ thumbnailUrl: samplePhoto(index), url: samplePhoto(index), alt: 'Imagen de ejemplo' }], sizes: [],
}));

export function CatalogDesignPreview({ value, brandName, assets, miniature = false, mobile = false, editing = false, disabled = false, selectedBlock, onSelectBlock, onLayoutChange }: {
  value: Appearance; brandName: string; assets: Record<string, string>; miniature?: boolean; mobile?: boolean;
  editing?: boolean; disabled?: boolean; selectedBlock?: HeroBlock; onSelectBlock?: (block: HeroBlock) => void; onLayoutChange?: (layout: HeroLayout) => void;
}) {
  const container = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(0);
  const viewport = mobile ? 390 : 1200, height = miniature ? 1350 : mobile ? 950 : 1100;
  const callbacks = useRef({ onSelectBlock, onLayoutChange, value, disabled, selectedBlock });
  const restoreKeyboardFocus = useRef<HeroBlock | null>(null);
  callbacks.current = { onSelectBlock, onLayoutChange, value, disabled, selectedBlock };
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const document = useMemo(() => {
    // The preview uses the public renderer and stylesheet, with example products.
    const appearance = { ...value, logoId: value.logoId && assets[value.logoId] ? value.logoId : null, coverId: value.coverId && assets[value.coverId] ? value.coverId : null };
    let html = renderCatalogList({ catalog: { slug: 'preview', brandName: brandName || 'Tu negocio', path: '#', appearance }, items: sampleItems, facets: { categories: ['Novedades', 'Accesorios'] } }, {});
    html = html.replace(/<link rel="stylesheet"[^>]+>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    for (const [id, url] of Object.entries(assets)) html = html.split(`/api/catalog/v1/preview/brand-assets/${id}`).join(url);
    const editorCss = editing && !mobile ? '.catalog-hero [data-hero-block]{cursor:grab;touch-action:none;outline:1px dashed currentColor;outline-offset:5px}.catalog-hero [data-hero-block]:focus{outline:3px solid currentColor}.catalog-hero [data-hero-block]:active{cursor:grabbing}' : '';
    return html.replace('</head>', `<style>${catalogCss}\n${templateCss}\n${catalogThemeCss(value)}\n${editorCss}</style></head>`);
  }, [value, brandName, assets, editing, mobile]);

  const connectEditor = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    // Links/forms are illustrative; previewing never navigates or submits.
    doc.addEventListener('click', event => event.preventDefault());
    doc.addEventListener('submit', event => event.preventDefault());
    if (!editing || mobile) return;
    const hero = doc.querySelector<HTMLElement>('.catalog-hero');
    if (!hero) return;
    doc.querySelectorAll<HTMLElement>('[data-hero-block]').forEach(element => {
      const key = element.dataset.heroBlock as HeroBlock;
      element.style.outlineWidth = key === callbacks.current.selectedBlock ? '3px' : '';
      element.tabIndex = 0;
      element.setAttribute('role', 'button');
      element.setAttribute('aria-label', `Mover bloque: ${{ tagline: 'frase de marca', title: 'título', description: 'descripción', button: 'botón' }[key]}`);
      element.addEventListener('focus', () => callbacks.current.onSelectBlock?.(key));
      element.addEventListener('keydown', event => {
        if (callbacks.current.disabled) return;
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return;
        event.preventDefault();
        restoreKeyboardFocus.current = key;
        const layout = callbacks.current.value.heroLayout ?? defaultHeroLayout, position = layout[key];
        callbacks.current.onLayoutChange?.({ ...layout, [key]: { ...position, x: Math.max(0, Math.min(100, position.x + delta[0])), y: Math.max(0, Math.min(100, position.y + delta[1])) } });
      });
      element.addEventListener('pointerdown', event => {
        if (event.button !== 0 || callbacks.current.disabled) return;
        event.preventDefault(); callbacks.current.onSelectBlock?.(key);
        const startX = event.clientX, startY = event.clientY, bounds = hero.getBoundingClientRect(), blockBounds = element.getBoundingClientRect();
        const layout = callbacks.current.value.heroLayout ?? defaultHeroLayout, initial = layout[key];
        let position = initial;
        element.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => {
          position = { ...initial,
            x: Math.round(Math.max(0, Math.min(100, initial.x + (moveEvent.clientX - startX) / Math.max(1, bounds.width - blockBounds.width) * 100))),
            y: Math.round(Math.max(0, Math.min(100, initial.y + (moveEvent.clientY - startY) / Math.max(1, bounds.height - blockBounds.height) * 100))) };
          element.style.left = `${position.x}%`; element.style.top = `${position.y}%`;
          element.style.transform = `translate(-${position.x}%, -${position.y}%)`;
        };
        const finish = () => {
          element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', finish); element.removeEventListener('pointercancel', finish);
          callbacks.current.onLayoutChange?.({ ...layout, [key]: position });
        };
        element.addEventListener('pointermove', move); element.addEventListener('pointerup', finish); element.addEventListener('pointercancel', finish);
      });
      if (restoreKeyboardFocus.current === key) { restoreKeyboardFocus.current = null; element.focus({ preventScroll: true }); }
    });
  };
  useEffect(() => {
    frame.current?.contentDocument?.querySelectorAll<HTMLElement>('[data-hero-block]').forEach(element => {
      element.style.outlineWidth = element.dataset.heroBlock === selectedBlock ? '3px' : '';
    });
  }, [selectedBlock, document]);
  const scale = width / viewport;
  return <div ref={container} className={`catalog-design-preview ${miniature ? 'miniature' : ''}`} style={{ height: width ? height * scale : 180 }}>
    <iframe ref={frame} title={miniature ? `Vista previa: ${catalogDesigns.find(design => design.id === value.preset)?.name ?? 'Esencial'}` : 'Vista previa de tu tienda'}
      sandbox="allow-same-origin" srcDoc={document} tabIndex={miniature ? -1 : 0} aria-hidden={miniature || undefined}
      onLoad={connectEditor} style={{ width: viewport, height, transform: `scale(${scale})`, visibility: width ? 'visible' : 'hidden', pointerEvents: disabled ? 'none' : undefined }}/>
  </div>;
}
