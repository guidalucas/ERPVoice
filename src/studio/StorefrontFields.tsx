import { useEffect, useState } from 'react';
import { query } from './api';
import type { Appearance, Product } from './types';
import './storefront.css';

const emptyInfo = { address: '', instagram: '', payments: '', shipping: '', sizeGuide: '' };
function CollectionPicker({ title, products, selected, onChange, loading }: {
  title: string; products: Product[]; selected: string[]; onChange: (slugs: string[]) => void; loading: boolean;
}) {
  const [search, setSearch] = useState('');
  const options = [...products.map(product => ({ slug: product.slug, title: product.title })),
    ...selected.filter(slug => !products.some(product => product.slug === slug)).map(slug => ({ slug, title: `${slug} · no disponible` }))];
  const normalize = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
  const visible = options.filter(product => normalize(product.title).includes(normalize(search.trim())));
  return <fieldset className="storefront-picker" aria-label={title}>
    <legend>{title}</legend><div className="storefront-picker-heading"><span aria-live="polite">{selected.length} de 24 seleccionados</span><button type="button" disabled={!selected.length} aria-label={`Quitar todos de ${title}`} onClick={() => onChange([])}>Quitar todos</button></div>
    <label className="field"><span>Buscar en {title.toLocaleLowerCase('es')}</span><input type="search" maxLength={120} value={search} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} onChange={event => setSearch(event.target.value)} placeholder="Nombre del producto"/></label>
    <div className="storefront-picker-list">{visible.map(product => <label className="storefront-picker-option" key={product.slug}>
      <input type="checkbox" aria-label={`${title}: ${product.title}`} checked={selected.includes(product.slug)} disabled={!selected.includes(product.slug) && selected.length >= 24}
        onChange={event => onChange(event.target.checked ? [...selected, product.slug] : selected.filter(slug => slug !== product.slug))}/><span>{product.title}</span>
    </label>)}{!visible.length && <p role="status">{loading ? 'Cargando productos…' : search ? 'No hay productos con ese nombre.' : 'Todavía no hay fichas preparadas.'}</p>}</div>
  </fieldset>;
}
export function StorefrontFields({ value, onChange }: { value: Appearance; onChange: (value: Appearance) => void }) {
  const info = { ...emptyInfo, ...value.storeInfo };
  const [products, setProducts] = useState<Product[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void (async () => {
      const items: Product[] = []; let cursor: string | null = null;
      do {
        const page: { items: Product[]; nextCursor: string | null } = await query('/products?' + new URLSearchParams({ status: 'ready', limit: '50', ...(cursor ? { cursor } : {}) }));
        items.push(...page.items); cursor = page.nextCursor;
      } while (active && cursor);
      if (active) setProducts(items);
    })().catch(() => { if (active) setError('No pudimos cargar los productos. Se conservan tus colecciones; recargá para editarlas.'); }).finally(() => { if (active) setLoading(false); });
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
    <h2>Colecciones comerciales</h2><p>Novedades muestra automáticamente las fichas más recientes con foto. Para Destacados y Promociones, marcá o desmarcá las casillas de cada producto. El precio se toma de Stocky; esta selección no aplica descuentos.</p>
    {error && <p role="status">{error}</p>}
    {(['featuredSlugs', 'promotionSlugs'] as const).map(key => <CollectionPicker key={key} title={key === 'featuredSlugs' ? 'Destacados' : 'Promociones'} products={products} selected={value[key] ?? []} loading={loading} onChange={slugs => onChange({ ...value, [key]: slugs })}/>)}
    <p>Publicá la Mystery Box como cualquier otro producto: cargá su descripción, precio, variantes y stock, y después publicala en el catálogo.</p>
  </>;
}
