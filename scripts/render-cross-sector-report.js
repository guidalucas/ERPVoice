import fs from 'node:fs/promises';
import path from 'node:path';

const first=JSON.parse(await fs.readFile('scripts/test-results-cross-sector-final.json','utf8'));
const final=JSON.parse(await fs.readFile('scripts/test-results-cross-sector-verified.json','utf8'));
const followupPath='scripts/test-results-cross-sector-followup.json';
let followup;
try {followup=JSON.parse(await fs.readFile(followupPath,'utf8'));} catch(error) {if(error.code!=='ENOENT') throw error;}
let interrupted;
try {interrupted=JSON.parse(await fs.readFile('scripts/test-results-cross-sector-interrupted.json','utf8'));} catch(error) {if(error.code!=='ENOENT') throw error;}
const allFinal=final.cases.map(test=>followup?.cases.find(repeated=>repeated.id===test.id)??test);
const failures=allFinal.filter(test=>!test.passed);
const turns=final.cases.flatMap(test=>test.turns);
const formatRepairs=turns.filter(turn=>turn.trace?.formatRepairAttempts);
const when=value=>new Intl.DateTimeFormat('es-AR',{timeZone:'America/Montevideo',dateStyle:'long',timeStyle:'short'}).format(new Date(value));
const lines=[
  '# Stocky: correcciones y pruebas de varios rubros',
  '',
  `Última batería completa: ${when(final.startedAt)} a ${when(final.finishedAt)} (America/Montevideo).`,
  '',
  '## Cambios',
  '',
  '- Distinguir ingresos como «sumá/cargá productos» de ventas y cargos a cuenta.',
  '- Conservar unidades comerciales explícitas: par, caja, paquete, botella, kg y metro; preguntar por equivalencias de envases desconocidas.',
  '- Presentar las variantes del catálogo agrupadas, respetar el talle o medida de cada producto y consultar todos los datos compartidos que faltan en una sola pregunta.',
  '- Interpretar «dejale el precio en cero» como cambio de precio, conservando cero como valor válido.',
  '- Reconocer la moneda declarada en lenguaje común: pesos argentinos = ARS, pesos uruguayos = UYU.',
  '- Admitir productos de otros rubros sin exigir talle ni precio opcional, y ventas sin un cliente obligatorio.',
  '- Usar razonamiento medio en el intérprete universal, manteniendo el mismo modelo y los valores por defecto del resto del cliente de IA. El ajuste por petición usa el parámetro documentado por [Gemini](https://ai.google.dev/gemini-api/docs/openai#thinking).',
  '- Permitir una sola reparación de evidencia o formato: se vuelve a validar todo y se rechaza cualquier cambio en acciones, referencias, cantidades, atributos, unidades o precios. Solo se admite completar un motivo requerido ausente y corregir las citas literales. Los fallos de proveedor y las referencias o permisos inválidos no generan esa reparación.',
  '',
  '## Resultado con el modelo real',
  '',
  `- Modelo: **${final.provider}/${final.model}**, razonamiento solicitado **${final.reasoningEffort??'no registrado'}**.`,
  `- Primera pasada ampliada, antes de los últimos ajustes: **${first.passed}/${first.cases.length}** correctos. Se conservaron sus ${first.failed} fallos en el JSON de esa ejecución.`,
  `- Última pasada completa: **${final.passed}/${final.cases.length}** correctos, ${final.failed} fallos; **${final.wireCalls} llamadas** reales.`,
  `- Reparaciones de formato en la última pasada: ${formatRepairs.length}; exitosas: ${formatRepairs.filter(turn=>turn.trace.formatRepairSucceeded).length}. Cada reparación está incluida en el número de llamadas.`,
  ...(interrupted?[`- Un intento previo se detuvo tras ${interrupted.wireCalls} llamada por indisponibilidad del proveedor, antes de completar la batería. Se limpiaron sus tablas temporales. Una prueba posterior respondió correctamente y permitió iniciar la pasada completa indicada arriba.`]:[]),
  ...(followup?[`- Repetición focalizada adicional: **${followup.passed}/${followup.cases.length}** correctos, ${followup.wireCalls} llamadas; no sustituye una pasada completa.`,`- Estado del último intento disponible por escenario: **${allFinal.length-failures.length}/${allFinal.length}** correctos.`]:[]),
  `- Una petición activa a la vez, pausas de al menos ${final.minPauseMs/1000} segundos tras cada respuesta, sin reintentos de transporte ni cambio automático de proveedor en el evaluador.`,
  '',
  '## Cobertura',
  '',
  'Ropa: remeras, shorts, buzos, camperas, polleras, tops, medias por par, pantalones, musculosas y calzas. Ferretería: cable por metro, tornillos por kilo y medida, tarugos por caja y merma de rollos de cinta. Kiosco y almacén: bebidas por botella, yerba y fideos por paquete, alfajores y caramelos por caja.',
  '',
  'Operaciones: altas, ingresos, ventas, reservas, bajas por daño, cambios de precio, fiado, pagos, pedidos, consultas, respuestas breves, correcciones, cancelación, falta de stock y rollback de una operación que había cargado primero una cuenta.',
  '',
  '## Base de producción y persistencia',
  '',
  `Se copiaron ${final.productionSnapshot.activeProducts} productos activos de un catálogo real y se agregaron ${final.syntheticProducts} productos sintéticos, clientes y proveedor de prueba. Se usó la conexión de sesión de la base de producción con tablas temporales. Los ejecutores no tuvieron acceso a public por search_path al escribir. No se enviaron mensajes de WhatsApp ni se modificaron filas permanentes.`,
  '',
  `En la última pasada, ${final.cases.filter(test=>test.persistedEffectsVerified).length} escenarios compararon stock y saldos SQL contra los cambios pedidos, ${final.cases.filter(test=>test.replayWithoutDuplicateEffects).length} verificaron que repetir la confirmación no duplicara efectos y ${final.cases.filter(test=>test.expectedRejection).length} comprobaron rechazos esperados por falta de stock. Limpieza temporal: **${final.temporaryTablesRemoved?'verificada':'NO verificada'}**${followup?`; repetición: **${followup.temporaryTablesRemoved?'verificada':'NO verificada'}**`:''}.`,
  '',
  'Las tablas temporales copiaron columnas, valores por defecto, restricciones CHECK e índices. LIKE no copia claves foráneas, RLS ni triggers; esas capas no quedan validadas por esta batería. Las pruebas se ejecutaron con el código local y el proveedor real; no prueban el despliegue de Render, la interfaz web, la transcripción de audio ni el envío real de WhatsApp.',
  '',
  '## Regresiones automáticas',
  '',
  '- Suite de inventario: 165 pruebas correctas.',
  '- Comprobador independiente del evaluador: 5 pruebas correctas, incluyendo unidades, precios opcionales y cambios SQL incorrectos.',
  '- PostgreSQL temporal local: 339 comprobaciones de integración correctas, incluyendo borradores, concurrencia, atomicidad, recuperación y mensajes.',
  '',
  '## Escenarios de la última pasada completa',
  '',
];
for(const test of final.cases){
  lines.push(`### ${test.passed?'Correcto':'Falló'} · ${test.id} · ${test.category}`,'',`> ${test.text}`,'');
  for(const turn of test.turns.slice(1)) lines.push(`Respuesta/corrección: «${turn.text}».`,'');
  if(test.error) lines.push(`Error: ${test.error.message.replace(/\s+/g,' ').trim()}`,'');
  if(test.expectedRejection) lines.push(`Rechazo esperado: ${test.expectedRejection}; rollback verificado: ${test.rollbackVerified?'sí':'no'}.`,'');
  for(const turn of test.turns.filter(turn=>turn.trace?.formatRepairAttempts)) lines.push(`Reparación de formato: ${turn.trace.formatRepairSucceeded?'aceptada tras validación':'rechazada sin cambiar la operación'}.`,'');
}
lines.push('## Repetir','','```powershell','npm run test:argentine-evaluation','npm run eval:argentine:live -- --out scripts/test-results-cross-sector-verified.json','```','','Para un subconjunto: agregar `--only` con identificadores separados por comas. Las credenciales se toman de la configuración local y no se escriben en los resultados.','');
const out=path.resolve('scripts/test-results-cross-sector.md');await fs.writeFile(out,lines.join('\n'));
console.log(JSON.stringify({report:out,completePass:final.passed,completeTotal:final.cases.length,latestFailures:failures.map(test=>test.id)},null,2));
