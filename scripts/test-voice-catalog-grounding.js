import dotenv from 'dotenv';
import { parseLocalText } from '../server/metaWebhookProcessor.js';
import { groundActionsAgainstCatalog, formatCatalogPromptSection } from '../server/voiceCatalogContext.js';
import { getBusinessCategoryPreset } from '../server/businessCategories.js';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const DELETE_TEXT =
  'eran 11 camisetas en total, pusiste un par de camisetas de más, la de River suplente no existe, esa está de más, eliminarla y también la que se llama camiseta River en versión jugador también está de más, eliminarla esa';

const CATALOG_TEXT =
  'ok seguí cargando camisetas todo lo que te voy a mencionar ahora está en talle s y todo vale 65.000 y todo es en versión jugador así que el nombre va a tener en versión jugador camiseta de argentina titular 2025 2026 camiseta de racing titular 2026 camiseta de vélez titular 2026 Camiseta suplente de Argentina, 2026. Camiseta suplente del PSG, 2026. Camiseta suplente de Argentina, 2026. Camiseta titular del Real Madrid, 2025. Y camiseta titular del Inter, 2025. Todo esto en talle M y todo vale 65.000 euros.';

const catalog = {
  products: [
    {
      name: 'Camiseta River Suplente S',
      productType: 'Camiseta',
      productModel: 'River Suplente',
      size: 'S',
      stockAvailable: 1,
    },
    {
      name: 'Camiseta River Suplente M',
      productType: 'Camiseta',
      productModel: 'River Suplente',
      size: 'M',
      stockAvailable: 1,
    },
    {
      name: 'Camiseta River versión jugador M',
      productType: 'Camiseta',
      productModel: 'River versión jugador',
      size: 'M',
      stockAvailable: 1,
    },
    {
      name: 'Camiseta Boca Titular M',
      productType: 'Camiseta',
      productModel: 'Boca Titular',
      size: 'M',
      stockAvailable: 2,
    },
  ],
  clients: [{ name: 'Juan' }],
  pedidos: [],
};

const line = (title) => {
  console.log(`\n=== ${title} ===`);
};

line('Prompt incluye inventario (sin ejemplos de ropa hardcodeados)');
const promptBit = formatCatalogPromptSection(catalog, DELETE_TEXT);
console.log(promptBit.slice(0, 700));
console.log('category examples gone?', !JSON.stringify(getBusinessCategoryPreset('indumentaria')).includes('promptExamples'));

line('DELETE local + grounding');
const deleted = parseLocalText(DELETE_TEXT, [], catalog);
console.log(
  JSON.stringify(
    {
      intent: deleted?.intent,
      hold: deleted?.missingFields,
      names: deleted?.actions?.map((action) => `${action.type}:${action.productName}`),
    },
    null,
    2,
  ),
);

line('DELETE ambiguo: solo "River"');
const ambiguous = groundActionsAgainstCatalog(
  [{ type: 'delete_product', productName: 'Camiseta River' }],
  catalog,
);
console.log(
  JSON.stringify(
    {
      hold: ambiguous.requiresConfirmation,
      missing: ambiguous.missingFields,
      suggested: ambiguous.suggestedPhrases,
      names: ambiguous.actions.map((action) => action.productName),
    },
    null,
    2,
  ),
);

line('LISTADO local (productos nuevos, no están en inventario)');
const loaded = parseLocalText(CATALOG_TEXT, [], catalog);
console.log(
  JSON.stringify(
    {
      intent: loaded?.intent,
      count: loaded?.actions?.length,
      names: loaded?.actions?.map((action) => `${action.productName} $${action.price} ${action.size}`),
    },
    null,
    2,
  ),
);

const mashed = loaded?.actions?.some((action) => (action.productName.match(/camiseta/gi) || []).length > 1);
console.log('¿algún nombre mashup con varias camisetas?', mashed);

if (process.env.VITE_VOICE_MODEL_API_KEY) {
  line('LLM + catálogo (Groq)');
  const { parseVoiceText } = await import('../server/metaWebhookProcessor.js');
  const llmDelete = await parseVoiceText(DELETE_TEXT, {
    businessCategory: 'indumentaria',
    catalog,
  });
  console.log(
    JSON.stringify(
      {
        intent: llmDelete?.intent,
        names: llmDelete?.actions?.map((action) => `${action.type}:${action.productName}`),
        missing: llmDelete?.missingFields,
      },
      null,
      2,
    ),
  );

  const llmLoad = await parseVoiceText(CATALOG_TEXT, {
    businessCategory: 'indumentaria',
    catalog,
  });
  console.log(
    JSON.stringify(
      {
        intent: llmLoad?.intent,
        count: llmLoad?.actions?.length,
        names: llmLoad?.actions?.map((action) => action.productName),
      },
      null,
      2,
    ),
  );
} else {
  console.log('\n(sin VITE_VOICE_MODEL_API_KEY: no se prueba el LLM)');
}
