export const BUSINESS_CATEGORIES = [
  {
    id: 'indumentaria',
    label: 'Indumentaria / Ropa',
    productTypeLabel: 'Tipo de prenda',
    productModelLabel: 'Modelo',
    variantLabel: 'Talle',
    useVariants: true,
    promptExamples: [
      '"3 camisetas de boca titular, talle M" -> productType: "Camiseta", productModel: "Boca Titular", size: "M", productName: "Camiseta Boca Titular M"',
      '"¿Cuántas camisetas de Boca me quedan y qué talles tengo?" -> query_stock sin size',
      '"¿Cuáles son los pedidos pendientes?" -> query_pedidos estado pendiente',
      '"ingresaron buzos de boca retro en talle XXL" -> add_stock con size "XXL"',
      '"Juan me pidió una camiseta de Boca titular talle M" -> client_order con size "M"',
      '"la camiseta de boca titular vale 70000" -> update_product con price (sin size = todos los talles)',
      '"actualizar pedido de Camiseta Alemania, el talle es XL" -> update_pedido con size "XL"',
    ],
  },
  {
    id: 'calzado',
    label: 'Calzado',
    productTypeLabel: 'Tipo de calzado',
    productModelLabel: 'Modelo',
    variantLabel: 'Número',
    useVariants: true,
    promptExamples: [
      '"2 zapatillas Nike Air, número 42" -> productType: "Zapatilla", productModel: "Nike Air", size: "42", productName: "Zapatilla Nike Air 42"',
      '"qué números tengo de botitas Adidas" -> query_stock sin size',
      '"ingresaron 5 botas de seguridad número 40" -> add_stock con size "40"',
      '"Pedro me pidió zapatillas Puma número 41" -> client_order con size "41"',
      '"las zapatillas Nike Air valen 120000" -> update_product (sin número = todos los números)',
      '"actualizar pedido de botitas Adidas, el número es 43" -> update_pedido con size "43"',
    ],
  },
  {
    id: 'ferreteria',
    label: 'Ferretería',
    productTypeLabel: 'Rubro',
    productModelLabel: 'Modelo / Marca',
    variantLabel: 'Medida',
    useVariants: true,
    promptExamples: [
      '"10 canillas bronce medida 1/2" -> productType: "Canilla", productModel: "Bronce", size: "1/2", productName: "Canilla Bronce 1/2"',
      '"qué medidas tengo de prolongador" -> query_stock sin size',
      '"¿Cuáles son los pedidos pendientes?" -> query_pedidos',
      '"ingresaron tornillos hexagonales medida 8mm" -> add_stock con size "8mm"',
      '"pedido: canilla bronce" -> client_order',
      '"la canilla bronce vale 4500" -> update_product',
      '"actualiza el pedido de canilla, la cantidad son 5" -> update_pedido con qty 5',
    ],
  },
  {
    id: 'electronica',
    label: 'Electrónica / Tecnología',
    productTypeLabel: 'Categoría',
    productModelLabel: 'Modelo',
    variantLabel: 'Variante',
    useVariants: true,
    promptExamples: [
      '"3 auriculares Sony WH-1000, variante negro" -> productType: "Auriculares", productModel: "Sony WH-1000", size: "Negro"',
      '"qué variantes tengo de cargador USB-C" -> query_stock sin size',
      '"ingresaron 2 mouse Logitech MX Master" -> add_stock',
      '"María me pidió un teclado mecánico variante blue" -> client_order con size "Blue"',
      '"el cargador USB-C vale 15000" -> update_product',
    ],
  },
  {
    id: 'kiosco',
    label: 'Kiosco / Almacén',
    productTypeLabel: 'Categoría',
    productModelLabel: 'Marca',
    variantLabel: null,
    useVariants: false,
    promptExamples: [
      '"recibí 10 alfajores en cajas por 18 c/u" -> [{"type":"add_stock","productType":"Alfajor","productName":"Alfajores","qty":10,"price":18}]',
      '"recibí chocolates cofler aireado por 55 gramos 30 unidades" -> [{"type":"add_stock","productType":"Chocolate","productModel":"Cofler Aireado 55g","productName":"Chocolate Cofler Aireado 55g","qty":30}]. OJO: "55 gramos" es presentación del producto (va en productModel/productName), NO es price ni size. "30 unidades" es qty.',
      '"compré 24 cocas de 500ml a $800" -> add_stock qty 24 price 800; "500ml" va en el nombre del producto, SIN size',
      '"cuánto stock tengo de alfajores Havanna" -> query_stock',
      '"Juan me pidió 2 packs de cerveza" -> client_order',
      '"la coca de 500 vale 1500" -> update_product',
      'Nunca trates gramos/ml/kg/g como price. Price solo si dice plata: "por 18 c/u", "a $55", "valen 2000", "precio 18".',
    ],
  },
  {
    id: 'general',
    label: 'General / Otro rubro',
    productTypeLabel: 'Categoría',
    productModelLabel: 'Modelo',
    variantLabel: null,
    useVariants: false,
    promptExamples: [
      '"ingresaron 10 unidades de producto X" -> add_stock',
      '"cuánto stock tengo de producto Y" -> query_stock',
      '"¿Cuáles son los pedidos que tengo pendiente?" -> query_pedidos',
      '"pedido: producto Z cantidad 3" -> client_order',
      '"el producto X vale 2000" -> update_product',
    ],
  },
];

/** Keywords users may say for the `size` field across categories (normalized without accents). */
export const VARIANT_KEYWORDS = [
  'talle',
  'talles',
  'numero',
  'numeros',
  'nro',
  'num',
  'medida',
  'medidas',
  'variante',
  'variantes',
];

export const getBusinessCategoryPreset = (id) =>
  BUSINESS_CATEGORIES.find((category) => category.id === id) ??
  BUSINESS_CATEGORIES.find((category) => category.id === 'general');

export const getVariantWord = (preset) => {
  const label = preset?.variantLabel?.trim();
  if (label) {
    return label.toLowerCase();
  }
  return 'variante';
};

export const formatVariantRef = (preset, size) => {
  const value = String(size ?? '').trim();
  if (!value) {
    return '';
  }
  return `${getVariantWord(preset)} ${value}`;
};

export const formatAllVariantsScope = (preset) => {
  if (!preset?.useVariants) {
    return 'todas las presentaciones';
  }

  const word = getVariantWord(preset);
  if (word === 'talle') {
    return 'todos los talles';
  }
  if (word === 'número' || word === 'numero') {
    return 'todos los números';
  }
  if (word === 'medida') {
    return 'todas las medidas';
  }
  if (word === 'variante') {
    return 'todas las variantes';
  }

  return `todas las variantes`;
};

export const formatMissingVariantLabel = (preset) => {
  if (!preset?.useVariants) {
    return 'sin variante';
  }
  return `sin ${getVariantWord(preset)}`;
};

/**
 * Shared voice-prompt section injected per business category.
 * Keeps one base schema; only vocabulary/examples change.
 */
export const buildCategoryPromptContext = (preset) => {
  const resolved = preset ?? getBusinessCategoryPreset('general');
  const variantLine = resolved.useVariants
    ? `- Este rubro USA variantes. El campo JSON "size" representa "${resolved.variantLabel}". El usuario puede decir "${resolved.variantLabel.toLowerCase()}", talle, número, medida o variante: mapealo siempre a "size".`
    : `- Este rubro NO usa variantes tipicas. NO inventes "size". Solo completa "size" si el usuario lo pidio explicitamente como dato del producto.`;

  const examples = (resolved.promptExamples ?? []).map((example) => `- Ejemplo (${resolved.id}): ${example}`).join('\n');

  return `
Contexto del rubro del negocio:
- Rubro: ${resolved.label} (id: ${resolved.id})
- productType = "${resolved.productTypeLabel}"
- productModel = "${resolved.productModelLabel}"
- size / variante = ${resolved.useVariants ? `"${resolved.variantLabel}"` : 'no aplica por defecto'}
${variantLine}
- Si la frase incluye tipo, modelo y variante, separá productType, productModel y size.
- En query_stock NO pongas size salvo que el usuario pida una variante puntual: la consulta debe listar todas las variantes disponibles.
- Si pregunta por pedidos pendientes / qué le pidieron / lista de pedidos, usá query_pedidos (no client_order).
- update_product sin size aplica a TODAS las variantes del modelo. Solo incluí size si nombró una variante puntual.
${examples}
`.trim();
};

/** Regex fragment for variant keywords (with accents optional via normalize). Use on normalized text. */
export const VARIANT_KEYWORD_ALT = 'talle|talles|numero|numeros|nro|num|medida|medidas|variante|variantes';
