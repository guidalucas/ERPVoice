import fs from 'node:fs/promises';
import path from 'node:path';
import {garments} from './fixtures/argentine-live-corpus.js';

const base=JSON.parse(await fs.readFile('scripts/test-results-argentine-live.json','utf8'));
const repeated=JSON.parse(await fs.readFile('scripts/test-results-argentine-retest.json','utf8'));
const pilot=JSON.parse(await fs.readFile('scripts/test-results-argentine-smoke.json','utf8'));
const repeats=new Map(repeated.cases.map(test=>[test.id,test]));
const when=value=>new Intl.DateTimeFormat('es-AR',{timeZone:'America/Montevideo',dateStyle:'long',timeStyle:'short'}).format(new Date(value));
const title={
  '03-polleras-y-tops-nuevos':'Carga de polleras y tops: rechazo intermitente del contrato',
  '05-medias-por-par':'Medias: la unidad «par» termina como unidad genérica',
  '16-conservar-talle-previo':'«Sumá»: interpreta una venta y elige un talle sin aclararlo',
  '21-mixta-sin-stock-atomica':'Operación mixta: pide una aclaración de cliente que no hacía falta',
};
const counts={firstPass:{passed:base.passed,total:base.cases.length},repeat:{passed:repeated.passed,total:repeated.cases.length},persistent:base.cases.filter(test=>!test.passed&&repeats.get(test.id)?.passed===false).length,intermittent:base.cases.filter(test=>!test.passed&&repeats.get(test.id)?.passed===true).length,calls:base.wireCalls+repeated.wireCalls+pilot.wireCalls};
const output=[
  '# Pruebas de Stocky con lenguaje argentino',
  '',
  `Ejecución: ${when(base.startedAt)} a ${when(repeated.finishedAt)} (America/Montevideo).`,
  '',
  `Modelo real: **${base.provider}/${base.model}**. Código del intérprete y ejecutores locales, conectado a Supabase de producción.`,
  '',
  '## Resultado',
  '',
  `- Primera pasada: **${base.passed}/${base.cases.length} correctos**; ${base.failed} fallos.`,
  `- Se repitieron únicamente los cuatro fallidos, una vez: **${repeated.passed}/${repeated.cases.length} correctos**.`,
  `- **${counts.persistent} fallos se repitieron y ${counts.intermittent} fue intermitente**. Los casos que pasaron de primera no se repitieron, por lo que esta batería no mide su tasa de intermitencia.`,
  `- **${counts.calls} llamadas** en total: ${base.wireCalls} en la batería, ${repeated.wireCalls} en la repetición y ${pilot.wireCalls} en el piloto. Una llamada a la vez, pausas mínimas de ${base.minPauseMs/1000} segundos dentro de cada pasada, sin reintentos automáticos ni proveedores alternativos.`,
  `- Tokens registrados en batería y repetición: ${(base.usage.promptTokens+repeated.usage.promptTokens).toLocaleString('es-AR')} de entrada y ${(base.usage.completionTokens+repeated.usage.completionTokens).toLocaleString('es-AR')} de salida.`,
  '',
  '## Cómo se usó producción',
  '',
  `Se leyó una copia de ${base.productionSnapshot.activeProducts} productos activos del catálogo real y se agregaron ${base.syntheticProducts} variantes sintéticas de ropa, dos clientes ficticios y un proveedor ficticio. Los casos incluyeron remeras, shorts, buzos, camperas, polleras, tops, medias, pantalones cargo, musculosas, calzas y camisetas.`,
  '',
  'Las escrituras ocurrieron en tablas temporales de esa misma base. Cada confirmación se ejecutó con los validadores, el ejecutor universal y la persistencia de historial de la aplicación; luego se hizo rollback del escenario. No se actualizaron filas permanentes de negocios reales ni se enviaron mensajes de WhatsApp. Se verificó que las tablas resueltas por el ejecutor fueran temporales y se impidió el acceso por search_path a las tablas públicas durante las escrituras.',
  '',
  `Limpieza explícita de tablas temporales al finalizar: batería **${base.temporaryTablesRemoved?'verificada':'NO verificada'}**; repetición **${repeated.temporaryTablesRemoved?'verificada':'NO verificada'}**. El piloto necesitó limpieza explícita adicional al detectar que la conexión inicial usaba pooling por transacción. La batería final usó una conexión de sesión, como indica la [documentación de Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres).`,
  '',
  '## Hallazgos',
  '',
  '### 1. Carga conjunta de productos nuevos: intermitencia',
  '',
  'La solicitud de dos polleras y tres tops, con precios diferentes en «lucas», produjo INVALID_OPERATION_PLAN en la primera pasada. La misma solicitud pasó en la repetición, incluyendo confirmación e historial. No se pudo atribuir el primer rechazo a un campo concreto porque esa primera respuesta inválida no se había guardado en bruto; el evaluador ahora conserva ese JSON cuando el contrato falla.',
  '',
  '### 2. Medias vendidas por par: unidad genérica',
  '',
  'En ambas pasadas, cuatro pares se interpretaron con cantidad 4 y precio 4.000 ARS, pero la unidad del producto fue unit en lugar de par. «Talle único» y «único» son equivalentes para esta evaluación; esa diferencia de formato no se considera un error. El fallo que persiste es la pérdida de la unidad declarada.',
  '',
  '### 3. Ingreso abreviado: intención y variante ambiguas',
  '',
  '«Sumá una remera oversize negra M y un short running azul» devolvió una propuesta lista en ambas pasadas. En la primera eligió stock.sell para los dos productos y tomó M para el short, aunque la frase no declaraba una venta y el short tenía dos talles disponibles. Se esperaba aclarar el alcance antes de proponer cambios. El evaluador detuvo la confirmación al detectar la diferencia.',
  '',
  '### 4. Venta y fiado: aclaración innecesaria',
  '',
  'En «Vendí 99 camisetas… y a Mica Rojas sumale 5 lucas…», la primera respuesta sostuvo que no encontraba a Mica, aunque estaba en el catálogo ofrecido. La segunda exigió identificar al cliente de la venta. Ese dato no es obligatorio para stock.sell, y el cargo ya identificaba a Mica. El caso no llegó a probar la atomicidad de esa operación porque el modelo no generó un plan listo. El rechazo de una venta individual sin stock sí se verificó.',
  '',
  '## Controles que pasaron',
  '',
  `- ${base.cases.filter(test=>test.confirmed).length} casos confirmaron cambios y comprobaron que repetir la confirmación no duplicara efectos.`,
  '- Ingresos de varias prendas, ventas con precio en lucas, reservas sin confundirlas con ventas, fiado y pagos de clientes.',
  '- Venta y cargo a cuenta en una misma operación, alta y cambio de pedidos, alta de clienta con notas.',
  '- Consulta de variantes y consulta sobre un producto copiado del catálogo real.',
  '- Respuesta corta a una venta ambigua y respuesta «talle L» para dos productos sin repetir la pregunta.',
  '- Corrección «Pará, fue uno solo», precio cero, omisión de precios opcionales y cancelación sin efectos.',
  '- Rechazo de una venta de 99 unidades contra solo 3 disponibles, con rollback comprobado.',
  '',
  '## Límites de esta batería',
  '',
  'Se probaron interpretación, contratos, borradores, revisión de WhatsApp, confirmación, escritura, historial e idempotencia con datos temporales. No se probaron envío real de WhatsApp, transcripción de audio, interfaz web ni el código desplegado en Render. Las tablas LIKE copiaron columnas, valores por defecto, restricciones CHECK e índices de producción; PostgreSQL no copia sus claves foráneas, políticas RLS ni triggers con LIKE. Por eso esta prueba no valida esas tres capas.',
  '',
  '## Casos completos',
  '',
];
for(const test of base.cases){
  const repeat=repeats.get(test.id);
  output.push(`### ${test.id} — ${test.category}`,'',`Primera pasada: **${test.passed?'CORRECTO':'FALLÓ'}**.${repeat?` Repetición: **${repeat.passed?'CORRECTO':'FALLÓ'}**.`:''}`,'',`> ${test.text}`,'');
  if(test.turns.length>1) output.push(`Respuesta/corrección: «${test.turns[1].text}».`,'');
  if(test.error) output.push(`Error inicial: ${test.error.message.replace(/\n+/g,' ').trim()}`,'');
  if(repeat?.error) output.push(`Error repetido: ${repeat.error.message.replace(/\n+/g,' ').trim()}`,'');
  if(test.persisted?.newProducts?.length) output.push(`Productos creados en la prueba: ${test.persisted.newProducts.map(p=>`${p.name}, ${p.size}, ${p.available} disponibles, ${p.price.toLocaleString('es-AR')} ${p.currency}`).join('; ')}.`,'');
  if(test.persisted?.accountChanges?.length) output.push(`Saldos finales verificados antes del rollback: ${test.persisted.accountChanges.map(p=>`${p.name}: ${p.balance.toLocaleString('es-AR')}`).join('; ')}.`,'');
  if(test.expectedRejection) output.push(`Rechazo esperado del backend: ${test.expectedRejection}; estado restaurado por rollback.`,'');
}
output.push('## Repetir la batería','','```powershell','node --use-system-ca scripts/evaluate-argentine-production.js --live --production-temp --out scripts/test-results-argentine-live.json','```','','Se requiere la configuración local de la base y del proveedor. Las credenciales no se escriben en el informe. La opción --only permite repetir identificadores concretos separados por comas sin ejecutar todo el corpus.','');
const target=path.resolve('scripts/test-results-argentine-live.md');await fs.writeFile(target,output.join('\n'));
console.log(JSON.stringify({report:target,...counts,cleanupVerified:base.temporaryTablesRemoved&&repeated.temporaryTablesRemoved},null,2));
