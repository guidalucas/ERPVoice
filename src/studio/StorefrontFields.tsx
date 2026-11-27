import { useEffect, useState } from 'react';
import { query } from './api';
import type { Appearance, Product } from './types';

const emptyInfo = { address: '', instagram: '', payments: '', shipping: '', sizeGuide: '' };
export function StorefrontFields({ value, onChange }: { value: Appearance; onChange: (value: Appearance) => void }) {
  const info = { ...emptyInfo, ...value.storeInfo };
  const [products, setProducts] = useState<Product[]>([]), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      const items: Product[] = []; let cursor: string | null = null;
      do {
        const page: { items: Product[]; nextCursor: string | null } = await query('/products?' + new URLSearchParams({ status: 'ready', limit: '50', ...(cursor ? { cursor } : {}) }));
        items.push(...page.items); cursor = page.nextCursor;
      } while (active && cursor);
      if (active) setProducts(items);
    })().catch(() => { if (active) setError('No pudimos cargar los productos. Se conservan tus colecciones; recargá para editarlas.'); });
    return () => { active = false; };
  }, []);
  const fields = [
    ['address', 'Dirección y retiro', 300, 'Dirección, ciudad y cómo coordinar el retiro'],
    ['payments', 'Medios de pago', 1000, 'Medios aceptados y condiciones que quieras comunicar'],
    ['shipping', 'Envíos', 1500, 'Zonas, costos, plazos y cómo se coordinan'],
    ['sizeGuide', 'Guía de talles', 3000, 'Medidas por modelo o instrucciones para elegir talle'],
  ] as const;
  return <>
    <h2>Información para tus clientes</h2><p>Se muestra en el catálogo. Completá solo datos confirmados; podés cambiarlos cuando lo necesites.</p>
    {fields.map(([key, label, max, placeholder]) => <label className="field" key={key}><span>{label}</span><textarea aria-label={label} maxLength={max} rows={key === 'sizeGuide' ? 4 : 2} value={info[key]} placeholder={placeholder} onChange={event => onChange({ ...value, storeInfo: { ...info, [key]: event.target.value } })}/></label>)}
    <label className="field"><span>Instagram · usuario</span><input maxLength={30} value={info.instagram} placeholder="@tunegocio" onChange={event => onChange({ ...value, storeInfo: { ...info, instagram: event.target.value } })}/></label>
    <h2>Colecciones comerciales</h2><p>Novedades muestra las fichas más recientes. Elegí las publicaciones que querés destacar o mostrar en promociones. El precio se toma de Stocky; esta selección no aplica descuentos.</p>
    {error && <p role="status">{error}</p>}
    {(['featuredSlugs', 'promotionSlugs'] as const).map(key => <label className="field" key={key}><span>{key === 'featuredSlugs' ? 'Destacados' : 'Promociones'} · hasta 24 publicaciones</span><select aria-label={`${key === 'featuredSlugs' ? 'Destacados' : 'Promociones'} · hasta 24 publicaciones`} multiple size={5} disabled={Boolean(error) || !products.length} value={value[key] ?? []} onChange={event => onChange({ ...value, [key]: [...event.target.selectedOptions].map(option => option.value) })}>
      {[...(value[key] ?? []).filter(slug => !products.some(product => product.slug === slug)).map(slug => <option value={slug} key={slug}>{slug} · no disponible</option>), ...products.map(product => <option value={product.slug} key={product.slug}>{product.title}</option>)]}
    </select></label>)}
    <p>Publicá la Mystery Box como cualquier otro producto: cargá su descripción, precio, variantes y stock, y después publicala en el catálogo.</p>
  </>;
}
