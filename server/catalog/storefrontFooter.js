import { appearanceOf } from '../../src/shared/catalogAppearance.js';
import { paymentMethods, shippingMethods, selectedPaymentMethods } from '../../src/shared/storefrontOptions.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = name => `<img class="footer-icon" src="/catalog-assets/icons/${name}.svg" alt="" width="20" height="20" loading="lazy">`;
const chatUrl = catalog => catalog.salesWhatsapp ? `https://wa.me/${catalog.salesWhatsapp}?text=${encodeURIComponent('Hola, quiero hacer un pedido.')}` : null;
const external = 'target="_blank" rel="noopener noreferrer"';
const methodList = methods => `<ul class="footer-methods">${methods.map(method => `<li class="${method.brand ? 'footer-brand-mark' : ''}">${method.brand
  ? `<img src="/catalog-assets/icons/${method.icon}.svg" alt="${escape(method.label)}" width="58" height="36" loading="lazy">`
  : `${icon(method.icon)}<span>${escape(method.label)}</span>`}</li>`).join('')}</ul>`;

export function renderStorefrontFooter(catalog, garments) {
  const info = appearanceOf(catalog).storeInfo ?? {}, chat = chatUrl(catalog), instagram = info.instagram?.replace(/^@/, '');
  const payments = selectedPaymentMethods(info);
  const shipping = info.shippingMethods ?? ['coordinate'];
  const help = `${catalog.path}/ayuda`;
  return `<footer class="shop-footer" aria-label="Información del comercio"><div class="shop-footer-inner"><div class="shop-footer-columns">
    <div class="footer-commerce"><section aria-labelledby="footer-payments"><h2 id="footer-payments">Medios de pago</h2>
      ${payments.length ? methodList(paymentMethods.filter(method => payments.includes(method.key))) : ''}
      <p>${escape(info.payments || 'Consultá los medios de pago disponibles antes de confirmar tu pedido.')}</p>
    </section><section aria-labelledby="footer-shipping"><h2 id="footer-shipping">Medios de envío</h2>
      ${shipping.length ? methodList(shippingMethods.filter(method => shipping.includes(method.key))) : ''}
      <p>${escape(info.shipping || 'Consultá las opciones, el costo y el plazo para tu localidad.')}</p>
    </section></div>
    <div class="footer-contact">${instagram ? `<section aria-labelledby="footer-social"><h2 id="footer-social">Nuestras redes sociales</h2><a class="footer-contact-link" aria-label="Encontranos en Instagram · @${escape(instagram)}" href="https://www.instagram.com/${escape(encodeURIComponent(instagram))}/" ${external}>${icon('instagram')}<span>@${escape(instagram)}</span></a></section>` : ''}
      <section aria-labelledby="footer-contact"><h2 id="footer-contact">Contacto</h2>
        ${info.email ? `<a class="footer-contact-link" href="mailto:${escape(encodeURIComponent(info.email))}">${icon('mail')}<span>${escape(info.email)}</span></a>` : ''}
        ${chat ? `<a class="footer-contact-link" aria-label="Hablemos por WhatsApp" href="${escape(chat)}" ${external}>${icon('whatsapp')}<span>WhatsApp · +${escape(catalog.salesWhatsapp)}</span></a>` : ''}
        ${info.address ? `<a class="footer-contact-link" href="https://www.google.com/maps/search/?api=1&amp;query=${escape(encodeURIComponent(info.address))}" ${external}>${icon('pin')}<span>${escape(info.address)}</span></a>` : ''}
      </section></div></div>
    <div class="shop-footer-bottom"><span class="footer-brand-name">${escape(catalog.brandName)}</span><nav aria-label="Ayuda para comprar"><a href="${escape(help)}#como-comprar">Cómo comprar</a>${garments ? `<a href="${escape(help)}#guia-talles">Guía de talles</a><a href="${escape(help)}#versiones">Versión jugador e hincha</a>` : ''}</nav><p>Pedidos por WhatsApp.</p></div>
  </div></footer>`;
}

export function renderHelpContent(catalog, garments) {
  const info = appearanceOf(catalog).storeInfo ?? {}, chat = chatUrl(catalog);
  return `<section class="store-help"><a class="back" href="${escape(catalog.path)}#coleccion">Volver al catálogo</a><h1>Información para comprar</h1>
    <section id="como-comprar"><h2>Cómo comprar</h2><p>Elegí tus productos, agregalos a Mi pedido y revisá el total. Al finalizar se abre WhatsApp con el detalle listo para enviar. Confirmamos disponibilidad, envío y pago por ese medio.</p></section>
    ${garments ? `<section id="guia-talles"><h2>Guía de talles</h2><p>${escape(info.sizeGuide || 'El calce puede cambiar entre modelos y versiones. Medí el ancho de axila a axila y el largo de una prenda que te quede cómoda, extendida sobre una superficie plana. Pedinos las medidas del modelo que te interesa antes de elegir tu talle.')}</p></section><section id="versiones"><h2>Versión jugador e hincha</h2><p>La versión jugador suele tener un corte más ajustado. La versión hincha suele ofrecer un calce más holgado para uso diario. Los materiales y las medidas dependen de cada modelo; consultá los detalles de la publicación antes de elegir.</p></section>` : ''}
    ${chat ? `<a class="primary" href="${escape(chat)}" ${external}>Consultar por WhatsApp</a>` : ''}</section>`;
}
