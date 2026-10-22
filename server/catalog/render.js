import { appearanceOf } from '../commerce/appearance.js';
import { formatMoneyAmount as money } from '../commerce/moneyPresentation.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const json = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const price = product => product.priceRange ? `${product.priceRange.minAmountMinor !== product.priceRange.maxAmountMinor ? 'Desde ' : ''}${money(product.priceRange.minAmountMinor, product.priceRange.currency, product.priceRange.fractionDigits)}` : 'Consultá el precio';
const decimal = (amount, digits) => { const value = BigInt(amount), scale = 10n ** BigInt(digits); return `${value / scale}.${(value % scale).toString().padStart(digits, '0')}`; };
const labels = { home: 'Titular', away: 'Suplente', third: 'Tercera', goalkeeper: 'Arquero', special: 'Especial', fan: 'Hincha', player: 'Jugador', short: 'Manga corta', long: 'Manga larga', sleeveless: 'Sin mangas' };
const whatsapp = (catalog, title = '') => catalog.salesWhatsapp ? `https://wa.me/${catalog.salesWhatsapp}?text=${encodeURIComponent(title ? `Hola, consulto por ${title}.` : 'Hola, quiero consultar por un producto.')}` : null;
const initials = name => name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
const assetUrl = (catalog, id) => `/api/catalog/v1/${catalog.slug}/brand-assets/${id}`;
const brandMark = catalog => appearanceOf(catalog).logoId ? `<img class="shop-logo" src="${escape(assetUrl(catalog, appearanceOf(catalog).logoId))}" alt="${escape(catalog.brandName)}">` : `<span class="fm">${escape(initials(catalog.brandName))}</span>`;
const cover = product => product.photos.find(photo => photo.cover) ?? product.photos[0];
function layout({ catalog, title, description, path, image, origin = '', content, schema }) {
  const appearance = appearanceOf(catalog);
  const canonical = origin ? `${origin}${path}` : '', chat = whatsapp(catalog);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="${escape(appearance.primaryColor)}">
    <title>${escape(title)}</title><meta name="description" content="${escape(description)}"><meta property="og:type" content="${schema ? 'product' : 'website'}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}">${canonical ? `<link rel="canonical" href="${escape(canonical)}"><meta property="og:url" content="${escape(canonical)}">` : ''}${image ? `<meta property="og:image" content="${escape(origin + image)}">` : ''}<link rel="stylesheet" href="/catalog-assets/catalog.css"><link rel="stylesheet" href="/catalog-assets/${escape(catalog.slug)}/theme.css">${schema ? `<script type="application/ld+json">${json(schema)}</script>` : ''}</head>
    <body data-catalog="${escape(catalog.slug)}" data-preset="${escape(['editorial', 'technical', 'local'].includes(appearance.preset) ? appearance.preset : 'classic')}"><header class="shop-header"><a class="shop-brand" href="${escape(catalog.path)}">${brandMark(catalog)}<span>${escape(catalog.brandName)}<small>${escape(appearance.tagline)}</small></span></a><nav aria-label="Navegación del catálogo"><a href="${escape(catalog.path)}">Catálogo</a><a class="shop-cart" href="${escape(catalog.path)}/consulta">Mi consulta <span data-cart-count>0</span></a>${chat ? `<a class="header-chat" href="${escape(chat)}" target="_blank" rel="noopener noreferrer">Consultas ↗</a>` : ''}</nav></header><main>${content}</main><footer><span>${escape(catalog.brandName)}</span><p>Disponibilidad actualizada desde nuestro inventario. Consultá antes de comprar.</p>${chat ? `<a href="${escape(chat)}" target="_blank" rel="noopener noreferrer">Hablemos por WhatsApp ↗</a>` : ''}</footer><script src="/catalog-assets/cart.js" defer></script></body></html>`;
}
const option = (value, label, selected) => `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(label)}</option>`;
export function renderCatalogList(data, query, origin) {
  const { catalog, items, nextCursor, facets = {} } = data, appearance = appearanceOf(catalog);
  const next = new URLSearchParams(query); if (nextCursor) next.set('cursor', nextCursor);
  const active = Object.entries(query).filter(([key, value]) => !['cursor', 'limit'].includes(key) && value);
  const filter = (key, label, values) => values?.length ? `<label><span>${escape(label)}</span><select name="${key}">${option('', label, query[key])}${values.map(value => option(value.key ?? value, value.name ?? labels[value] ?? value, query[key])).join('')}</select></label>` : '';
  const cards = items.map(product => {
    const photo = cover(product);
    const redundant = product.sizes.length === 1 && product.sizes[0].size.trim().toLocaleLowerCase('es') === product.title.trim().toLocaleLowerCase('es');
    return `<article class="catalog-card"><a href="${escape(product.path)}">
      <div class="catalog-card-photo${photo ? '' : ' without-photo'}">${photo ? `<img src="${escape(photo.thumbnailUrl)}" alt="${escape(photo.alt || product.title)}" loading="lazy" width="480" height="560">` : '<span class="no-photo">Sin fotografía</span>'}<span class="availability ${product.available ? '' : 'sold-out'}">${product.available ? 'Disponible' : 'Sin stock'}</span></div>
      <div class="catalog-card-body"><p class="team">${escape(product.teamName || product.category || catalog.brandName)} <span aria-hidden="true">↗</span></p><h2>${escape(product.title)}</h2>
        ${[product.season, labels[product.versionKey]].some(Boolean) ? `<p class="product-meta">${escape([product.season, labels[product.versionKey]].filter(Boolean).join(' · '))}</p>` : ''}
        <strong>${escape(price(product))}</strong>
        ${!redundant ? `<div class="catalog-sizes">${product.sizes.map(size => `<span class="${size.available ? '' : 'unavailable'}">${escape(size.size)}${size.unit && size.unit !== 'unit' ? ' · ' + escape(size.unit) : ''}</span>`).join('')}</div>` : ''}
        ${product.sizes[0]?.specifications?.length ? `<p class="card-specs">${escape(product.sizes[0].specifications.slice(0, 3).map(spec => spec.label + ': ' + spec.value).join(' · '))}</p>` : ''}
        <span class="card-link">Ver producto ↗</span>
      </div></a></article>`;
  }).join('');
  const content = `<section class="catalog-hero ${appearance.coverId ? 'has-cover' : ''}${active.length ? ' filtered-hero' : ''}">${appearance.coverId ? `<img class="catalog-cover" src="${escape(assetUrl(catalog, appearance.coverId))}" alt="">` : ''}<div class="hero-copy"><p class="eyebrow">${escape(appearance.tagline)}</p><h1>${escape(appearance.heroTitle)}</h1><p>${escape(appearance.heroDescription)}</p><a class="primary" href="#coleccion">Explorar catálogo ↓</a></div></section>
    <section id="coleccion" class="collection"><div class="collection-heading"><div><h2>${escape(appearance.collectionTitle)}</h2><p class="shopping-help">Elegí tus productos y consultá al comercio. Sin cobros ni reservas desde esta página.</p></div><small>Stock y precios actualizados</small></div>
      ${facets.categories?.length > 1 ? `<nav class="category-nav" aria-label="Categorías"><a href="${escape(catalog.path)}#coleccion"${!query.category ? ' aria-current="page"' : ''}>Todo el catálogo</a>${facets.categories.map(category => `<a href="${escape(catalog.path)}?${escape(new URLSearchParams({ category }).toString())}#coleccion"${category === query.category ? ' aria-current="page"' : ''}>${escape(category)}</a>`).join('')}</nav>` : ''}
      <form class="catalog-filters" method="get" action="${escape(catalog.path)}#coleccion">
        <label class="search"><span class="sr-only">Buscar productos</span><input type="search" name="q" value="${escape(query.q)}" placeholder="¿Qué estás buscando?" maxlength="120"></label>
        <button type="submit">Buscar</button>
        <details class="catalog-filter-options"${active.some(([key]) => key !== 'q') ? ' open' : ''}><summary>Filtros${active.length ? ' · ' + active.length + ' activos' : ''}</summary><div class="catalog-filter-fields">
          ${filter('category', 'Todas las categorías', facets.categories)}${filter('team', 'Todos los equipos', facets.teams)}${filter('version', 'Todas las versiones', facets.versions)}${filter('variant', 'Todas las presentaciones', facets.variants)}
          <button type="submit">Aplicar filtros</button>
        </div></details>
      </form>
      ${active.length ? `<div class="active-filters"><span>${escape(active.map(([key, value]) => key === 'q' ? 'Búsqueda: ' + value : (labels[value] || value)).join(' · '))} · ${items.length}${nextCursor ? '+' : ''} resultados</span><a href="${escape(catalog.path)}#coleccion">Limpiar filtros</a></div>` : ''}
      <div class="catalog-grid ${!nextCursor && items.length <= 2 ? 'small-collection' : ''}">${cards || (active.length ? `<div class="no-results"><h3>No encontramos productos para esta búsqueda.</h3><p>Probá otro nombre o quitá los filtros.</p><a class="primary" href="${escape(catalog.path)}#coleccion">Ver catálogo completo</a></div>` : '<div class="no-results"><h3>Todavía no hay productos publicados.</h3><p>Los productos de este comercio aparecerán acá.</p></div>')}</div>
      ${nextCursor ? `<a class="more" href="${escape(catalog.path)}?${escape(next.toString())}#coleccion">Ver más productos ↓</a>` : ''}
    </section>`;
  return layout({ catalog, origin, path: catalog.path, title: `${catalog.brandName} · Catálogo`, description: appearance.heroDescription || `Explorá los productos de ${catalog.brandName}. Precios y disponibilidad actualizados.`, image: items[0] && cover(items[0])?.url, content });
}
export function renderCatalogProduct(data, origin) {
  const { catalog, product } = data, photo = cover(product), chat = whatsapp(catalog, product.title), variantTitle = product.variantLabel || 'Presentación';
  const schema = { '@context': 'https://schema.org', '@type': 'Product', name: product.title, description: product.description || product.title,
    image: product.photos.map(image => origin + image.url), brand: { '@type': 'Brand', name: catalog.brandName },
    ...(product.priceRange ? { offers: product.priceRange.minAmountMinor === product.priceRange.maxAmountMinor
      ? { '@type': 'Offer', price: decimal(product.priceRange.minAmountMinor, product.priceRange.fractionDigits), priceCurrency: product.priceRange.currency,
        availability: `https://schema.org/${product.available ? 'InStock' : 'OutOfStock'}`, ...(origin ? { url: origin + product.path } : {}) }
      : { '@type': 'AggregateOffer', lowPrice: decimal(product.priceRange.minAmountMinor, product.priceRange.fractionDigits), highPrice: decimal(product.priceRange.maxAmountMinor, product.priceRange.fractionDigits), priceCurrency: product.priceRange.currency, offerCount: product.sizes.length } } : {}) };
  const available = product.sizes.filter(size => size.available);
  const selected = available.length === 1 ? available[0].size : '';
  const gallery = photo ? [photo, ...product.photos.filter(image => image !== photo)] : [];
  const heading = `<div class="public-product-heading"><p class="eyebrow dark">${escape([product.teamName || product.category, product.season].filter(Boolean).join(' ／ '))}</p><h1>${escape(product.title)}</h1>${[labels[product.kitKey], product.versionKey, labels[product.sleeveKey]].some(Boolean) ? `<p class="public-details">${escape([labels[product.kitKey], product.versionKey ? 'Versión ' + labels[product.versionKey] : null, labels[product.sleeveKey]].filter(Boolean).join(' · '))}</p>` : ''}<strong class="public-price" data-default-price="${escape(price(product))}">${escape(selected && available[0].price ? money(available[0].price.amountMinor, available[0].price.currency, available[0].price.fractionDigits) : price(product))}</strong><span class="stock-note ${product.available ? '' : 'sold-out'}">${product.available ? 'Disponible para consultar' : 'Sin stock por el momento'}</span></div>`;
  const content = `<section class="product-page"><a class="back" href="${escape(catalog.path)}#coleccion">← Volver a la colección</a>
    <div class="public-product-layout${photo ? '' : ' no-product-photo'}">
      ${heading}
      <div class="public-gallery"><div class="main-photo">${photo ? `<a href="${escape(photo.url)}" target="_blank" rel="noopener noreferrer" data-gallery-zoom aria-label="Ampliar fotografía"><img data-gallery-main src="${escape(photo.url)}" alt="${escape(photo.alt || product.title)}" width="928" height="1100"></a>` : '<span class="no-photo">Sin fotografía disponible</span>'}</div>
        ${gallery.length > 1 ? `<nav class="public-thumbnails" aria-label="Fotografías del producto">${gallery.map((image, index) => `<a href="${escape(image.url)}" data-gallery-image data-image-alt="${escape(image.alt || product.title)}" aria-label="Ver fotografía ${index + 1}"${index === 0 ? ' aria-current="true"' : ''}><img src="${escape(image.thumbnailUrl)}" alt="" loading="lazy" width="150" height="180"></a>`).join('')}</nav><p class="gallery-status" data-gallery-status role="status">Foto 1 de ${gallery.length}</p>` : ''}
        ${photo ? `<dialog class="photo-dialog" aria-label="Fotografía ampliada"><form method="dialog"><button autofocus>Cerrar fotografía</button></form><img src="${escape(photo.url)}" alt="${escape(photo.alt || product.title)}"></dialog>` : ''}
      </div>
      <div class="public-product-info">
        <form data-add-inquiry data-product="${escape(product.slug)}" class="add-inquiry">
          <label>${escape(variantTitle)} para tu consulta<select name="size" required aria-label="${escape(variantTitle)} para tu consulta">${selected ? '' : '<option value="">Elegir presentación</option>'}${product.sizes.map(size => `<option value="${escape(size.size)}"${size.size === selected ? ' selected' : ''}${size.available ? '' : ' disabled'}${size.price ? ` data-price="${escape(money(size.price.amountMinor, size.price.currency, size.price.fractionDigits))}"` : ''}>${escape(size.size)}${size.unit && size.unit !== 'unit' ? ' · ' + escape(size.unit) : ''}${!size.available ? ' · Agotado' : product.priceRange && product.priceRange.minAmountMinor !== product.priceRange.maxAmountMinor && size.price ? ' · ' + escape(money(size.price.amountMinor, size.price.currency, size.price.fractionDigits)) : ''}</option>`).join('')}</select></label>
          <label>Cantidad<input type="number" name="quantity" min="1" max="10" step="1" value="1" required aria-label="Cantidad para tu consulta"></label>
          <button type="submit"${product.available ? '' : ' disabled'}>Agregar a mi consulta ＋</button><small data-inquiry-status role="status"></small>
        </form>
        <p class="stock-help">Sumá productos a Mi consulta o consultá por este producto. El comercio confirma disponibilidad y condiciones por WhatsApp.</p>
        ${chat ? `<a class="inquiry direct-inquiry" data-direct-inquiry href="${escape(chat)}" target="_blank" rel="noopener noreferrer">${product.available ? 'Consultar por WhatsApp' : 'Consultar próximas reposiciones'} ↗</a>` : ''}
        ${!product.available ? '<p class="stock-help">Este producto no puede agregarse a tu consulta mientras no tenga stock.</p>' : ''}
        <div class="product-description"><h2>Sobre este producto</h2><p>${escape(product.description || 'Consultanos para conocer más detalles de este producto.')}</p>
          ${product.sizes.some(item => item.specifications?.length) ? `<dl class="product-specifications">${product.sizes.map(item => (item.specifications ?? []).map(spec => `<div><dt>${escape(spec.label)}${product.sizes.length > 1 ? ' · ' + escape(item.size) : ''}</dt><dd>${escape(spec.value)}</dd></div>`).join('')).join('')}</dl>` : ''}
        </div>
        <div class="trust-note">${escape(catalog.brandName)}<span>${escape(appearanceOf(catalog).tagline)}</span></div>
      </div>
    </div>
  </section>`;
  return layout({ catalog, origin, path: product.path, title: `${product.title} · ${catalog.brandName}`, description: (product.description || `${product.title}. ${price(product)}. Presentaciones y disponibilidad actualizadas.`).slice(0, 300), image: photo?.url, content, schema });
}
export function renderCatalogError(status, catalogPath = '/') {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Catálogo no disponible · Stocky</title><link rel="stylesheet" href="/catalog-assets/catalog.css"></head><body><main class="catalog-error"><span class="fm">S<i>／</i></span><h1>${status === 404 ? 'Este enlace no está disponible.' : 'Volvé a intentarlo en un momento.'}</h1><p>${status === 404 ? 'El catálogo o el producto puede estar oculto temporalmente.' : 'No pudimos consultar la colección.'}</p><a class="primary" href="${escape(catalogPath)}">Volver al catálogo</a></main></body></html>`;
}
export function renderInquiryPage(catalog, origin) {
  return layout({ catalog, origin, path: `${catalog.path}/consulta`, title: `Mi consulta · ${catalog.brandName}`, description: 'Revisá productos, presentaciones y precios actuales antes de consultar al comercio.',
    content: `<section class="inquiry-page"><a class="back" href="${escape(catalog.path)}#coleccion">← Seguir explorando</a><p class="eyebrow dark">TU SELECCIÓN</p><h1>Mi consulta</h1><p class="inquiry-intro">Revisá tu selección. Confirmamos disponibilidad y condiciones al responderte.</p><div class="inquiry-layout"><div><div id="inquiry-message" class="inquiry-message" role="status" aria-live="polite"></div><div id="inquiry-lines"></div><div id="inquiry-empty" hidden><h2>Tu consulta está esperando un producto.</h2><p>Explorá la colección y elegí los productos que te interesan.</p><a class="primary" href="${escape(catalog.path)}#coleccion">Ver colección ↗</a></div><button type="button" id="inquiry-clear" class="clear-inquiry">Vaciar mi consulta</button></div><aside class="inquiry-summary"><h2>Resumen orientativo</h2><div class="inquiry-total"><span>Total de productos</span><strong id="inquiry-total">—</strong></div><p>No incluye envío. No se realiza ningún cobro desde esta pantalla.</p><button type="button" id="inquiry-refresh">Actualizar precios y disponibilidad</button><button type="button" class="primary" id="inquiry-contact" disabled>Consultar por WhatsApp ↗</button><small id="inquiry-checked"></small><hr><small>Esta consulta no crea un pedido ni reserva unidades. El comercio confirma la compra por WhatsApp.</small></aside></div><noscript><p>Activá JavaScript para conservar y revisar varios productos. También podés consultar individualmente desde cada ficha.</p></noscript></section>` });
}
