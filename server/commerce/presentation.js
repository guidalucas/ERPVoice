// Read-only commercial presentation of Stocky's existing typed attributes.
// Deliberate public allowlist: never publish arbitrary inventory attributes.
const publicKeys = new Set(['marca', 'brand', 'modelo', 'model', 'medida', 'medidas', 'material', 'potencia', 'capacidad', 'contenido', 'contenido neto', 'presentacion', 'presentación', 'sabor', 'color', 'talle']);
export function commercialSpecifications(attributes = {}) {
  return Object.entries(attributes ?? {}).flatMap(([key, attribute]) => {
    if (!publicKeys.has(key.toLocaleLowerCase('es')) || attribute?.state !== 'known' || !['text', 'number', 'boolean'].includes(attribute.type)) return [];
    const value = attribute.value;
    if (!['string', 'number', 'boolean'].includes(typeof value)) return [];
    return [{ label: key, value: `${typeof value === 'boolean' ? value ? 'Sí' : 'No' : value}${attribute.unit ? ` ${attribute.unit}` : ''}` }];
  });
}
export const variantLabel = sku => sku.size?.trim() || sku.name?.trim() || 'Producto';
