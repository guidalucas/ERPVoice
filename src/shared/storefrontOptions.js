export const paymentMethods = Object.freeze([
  { key: 'mercado-pago', label: 'Mercado Pago', icon: 'mercado-pago' },
  { key: 'visa', label: 'Visa', icon: 'visa', brand: true },
  { key: 'mastercard', label: 'Mastercard', icon: 'mastercard', brand: true },
  { key: 'amex', label: 'American Express', icon: 'amex', brand: true },
  { key: 'transfer', label: 'Transferencia bancaria', icon: 'bank' },
  { key: 'cash', label: 'Efectivo', icon: 'cash' },
]);
export const shippingMethods = Object.freeze([
  { key: 'coordinate', label: 'Envío a coordinar', icon: 'truck' },
  { key: 'pickup', label: 'Retiro en el local', icon: 'store' },
  { key: 'correo-argentino', label: 'Correo Argentino', icon: 'package' },
  { key: 'andreani', label: 'Andreani', icon: 'package' },
  { key: 'oca', label: 'OCA', icon: 'package' },
]);
export const selectedPaymentMethods = info => info?.paymentMethods ?? (/todos los medios de pago/i.test(info?.payments ?? '') ? paymentMethods.map(method => method.key) : []);
export const storefrontIconNames = [...new Set([...paymentMethods, ...shippingMethods].map(method => method.icon)), 'instagram', 'whatsapp', 'mail', 'pin'];
