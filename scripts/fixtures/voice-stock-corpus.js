export const incidentText = 'Cargé la camiseta suplente del Manchester City 2025 en talle L. Cargé la camiseta de Independiente, la anterior del Manchester City en versión jugador. Todas estas que te voy a mencionar son en versión jugador. Camiseta de Independiente suplente 2026 en versión jugador. Camiseta de Racing titular, 2026 en versión jugador. Camiseta de River 2025 en versión jugador, la titular también. Camiseta de Argentina, tercera equipación, 2025. Camiseta de Barcelona 2025 titular, en versión jugador también obvio. Tercera camiseta de Boca, tercera equipación en versión jugador. Camiseta de Italia 2025 en versión jugador titular también. Camiseta de la Roma 2025 titular en versión jugador. Camiseta del Real Madrid en versión jugador titular. Camiseta del Barcelona 2025 en versión jugador, la titular, mangas largas, todas las anteriores valen 65.000, esta manga larga vale 70.000.';
// The first Independiente mention is completed by the later Independiente 2026 item;
// "la anterior" updates Manchester City without adding a second unit.
export const ambiguousMention = 'Cargé la camiseta de Independiente, la anterior del Manchester City en versión jugador.';
export const clarifiedText = incidentText.replace(ambiguousMention, 'La anterior del Manchester City en versión jugador.');
const specifications = [
  ['Manchester City suplente 2025 versión jugador', 'camiseta suplente del Manchester City 2025 en talle L', 'L'],
  ['Independiente suplente 2026 versión jugador', 'Camiseta de Independiente suplente 2026 en versión jugador'],
  ['Racing titular 2026 versión jugador', 'Camiseta de Racing titular, 2026 en versión jugador'],
  ['River titular 2025 versión jugador', 'Camiseta de River 2025 en versión jugador, la titular también'],
  ['Argentina tercera equipación 2025 versión jugador', 'Camiseta de Argentina, tercera equipación, 2025'],
  ['Barcelona titular 2025 versión jugador', 'Camiseta de Barcelona 2025 titular, en versión jugador también obvio'],
  ['Boca tercera equipación versión jugador', 'Tercera camiseta de Boca, tercera equipación en versión jugador'],
  ['Italia titular 2025 versión jugador', 'Camiseta de Italia 2025 en versión jugador titular también'],
  ['Roma titular 2025 versión jugador', 'Camiseta de la Roma 2025 titular en versión jugador'],
  ['Real Madrid titular versión jugador', 'Camiseta del Real Madrid en versión jugador titular'],
  ['Barcelona titular 2025 versión jugador mangas largas', 'Camiseta del Barcelona 2025 en versión jugador, la titular, mangas largas'],
];
export const incidentActions = specifications.map(([model, evidence, size], index) => ({
  type: 'add_stock', productType: 'Camiseta', productModel: model, productName: `Camiseta ${model}`,
  evidence, size, qty: 1, price: index === 10 ? 70000 : 65000,
  fieldEvidence: { price: index === 10 ? 'esta manga larga vale 70.000' : 'todas las anteriores valen 65.000' },
}));
export const incidentCatalog = { products: [
  { id: 'arg-home', name: 'Camiseta Argentina titular 2026 versión jugador', productType: 'Camiseta', productModel: 'Argentina titular 2026 versión jugador' },
  { id: 'arg-away', name: 'Camiseta Argentina suplente 2026 versión jugador', productType: 'Camiseta', productModel: 'Argentina suplente 2026 versión jugador' },
  { id: 'norway', name: 'Camiseta Noruega suplente 2026 versión jugador', productType: 'Camiseta', productModel: 'Noruega suplente 2026 versión jugador' },
  { id: 'chelsea', name: 'Camiseta Chelsea titular 2025 versión jugador', productType: 'Camiseta', productModel: 'Chelsea titular 2025 versión jugador' },
] };
export const genericCases = [
  { id: 'hardware-variants', category: 'ferreteria', text: 'Ingresaron dos taladros Bosch 18V de 10 mm, a 65000 pesos.',
    actions: [{ type: 'add_stock', productType: 'Taladro', productModel: 'Bosch 18V', productName: 'Taladro Bosch 18V', size: '10 mm', qty: 2, price: 65000, evidence: 'taladros Bosch 18V de 10 mm', fieldEvidence: { qty: 'dos', price: 'a 65000 pesos' } }],
    catalog: { products: [{ id: 'bosch-13', name: 'Taladro Bosch 18V', productType: 'Taladro', productModel: 'Bosch 18V', size: '13 mm' }] } },
  { id: 'grocery-presentation', category: 'general', text: 'Recibí dos aceites Oliva Norte de 500 ml, cada uno a 8500 pesos.',
    actions: [{ type: 'add_stock', productName: 'Aceite Oliva Norte 500 ml', qty: 2, price: 8500, evidence: 'aceites Oliva Norte de 500 ml', fieldEvidence: { qty: 'dos', price: 'cada uno a 8500 pesos' } }],
    catalog: { products: [{ id: 'oil-liter', name: 'Aceite Oliva Norte 1 litro' }] } },
  { id: 'cosmetics-new-model', category: 'general', text: 'Llegó un serum Aurora vitamina C 30 ml a 12000 pesos.',
    actions: [{ type: 'add_stock', productName: 'Serum Aurora vitamina C 30 ml', qty: 1, price: 12000, evidence: 'serum Aurora vitamina C 30 ml', fieldEvidence: { price: 'a 12000 pesos' } }],
    catalog: { products: [{ id: 'aurora-hyaluronic', name: 'Serum Aurora ácido hialurónico 30 ml' }] } },
];
