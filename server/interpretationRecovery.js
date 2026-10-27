// Backend-owned explanations. Never expose provider messages, SQL, IDs or raw errors.
const advice = new Map();
const register = (codes, why, action) => codes.split(' ').forEach(code => advice.set(code, { why, action }));
register('INVALID_EVIDENCE', 'la respuesta automática no pudo respaldar todos los cambios con lo que escribiste', 'enviá nuevamente la instrucción completa, con la acción, el nombre exacto y los valores que querés cambiar');
register('INVALID_MODEL_RESPONSE INVALID_INTERPRETER_DATA INVALID_MODEL_TARGET', 'el servicio de interpretación devolvió una respuesta con un formato inválido', 'reenviá la instrucción completa; si vuelve a fallar, realizá la operación desde el panel');
register('INTERPRETATION_UNAVAILABLE INTERPRETER_UNAVAILABLE', 'el servicio de interpretación no pudo responder correctamente en este intento', 'esperá un momento y reenviá el mismo mensaje completo; si sigue fallando, usá el panel');
register('INVALID_OPERATION_PLAN INVALID_ACCOUNT_OPERATION INVALID_PARTY_OPERATION INVALID_ORDER_OPERATION INVALID_QUERY', 'los datos interpretados no forman una operación válida', 'indicá una sola acción, el nombre exacto y los datos del cambio; por ejemplo, «Cambiá el precio de [producto] a [importe] [moneda]»');
register('UNKNOWN_CATALOG_REFERENCE INVALID_OPERATION_REFERENCE INVALID_ORDER_CLIENT_REFERENCE', 'una referencia del pedido no coincide con un producto, persona o alta previa válida', 'consultá los datos actuales y reenviá el pedido con los nombres exactos; si la persona o el producto es nuevo, indicá que querés darlo de alta');
register('INVALID_INVENTORY_UNIT UNIT_MISMATCH', 'la unidad solicitada no coincide con la unidad que usa el producto', 'consultá el inventario e indicá la cantidad en la misma unidad del producto, sin convertirla automáticamente');
register('INVALID_REVISION_PATCH INVALID_REVISION_CONTEXT', 'la corrección no pudo vincularse de forma válida con la propuesta anterior', 'indicá exactamente qué producto o ítem querés corregir y su nuevo valor; si persiste, cancelá el borrador y enviá la instrucción completa');
register('INVALID_CATALOG INVALID_CATALOG_REVISION', 'los datos actuales del negocio no pudieron validarse', 'actualizá el panel y revisá los datos del producto o persona; si continúa, consultá con quien administra el negocio');
register('CATALOG_TOO_LARGE INTERPRETER_DATA_TOO_LARGE MODEL_RESPONSE_TOO_LARGE DRAFT_PREVIEW_TOO_LARGE SELECTION_PREVIEW_TOO_LARGE SELECTION_TOO_LARGE', 'la información supera el tamaño que puedo procesar o mostrar completo', 'dividí la solicitud en grupos más pequeños o revisá la operación desde el panel');
register('FORBIDDEN', 'la operación interpretada no está habilitada para este canal o usuario', 'consultá con quien administra el negocio para verificar si esa operación está habilitada; reenviar el mismo pedido no cambia los permisos');
register('BUSINESS_SCOPE_REQUIRED BUSINESS_SCOPE_MISMATCH UNAUTHENTICATED', 'no pude vincular la operación con un negocio y usuario autorizados', 'volvé a iniciar sesión y verificá que estés en el negocio correcto antes de enviar el pedido');
register('DRAFT_EXPIRED SELECTION_EXPIRED', 'venció el plazo para confirmar esa propuesta', 'enviá de nuevo la instrucción completa para preparar una propuesta vigente y revisala antes de confirmar');
register('DRAFT_NOT_FOUND SELECTION_NOT_FOUND', 'no encontré una propuesta vigente que corresponda a este mensaje y usuario', 'enviá la instrucción completa para preparar una nueva propuesta');
register('DRAFT_NOT_READY', 'todavía falta responder la aclaración pendiente', 'respondé la última pregunta del borrador; después podrás revisar y confirmar la propuesta');
register('DRAFT_NOT_PENDING', 'esa conversación ya tiene un resultado definitivo y no admite más cambios', 'revisá el resultado en el historial; si necesitás otro cambio, enviá una instrucción nueva');
register('SELECTION_ALREADY_APPLIED', 'esa selección ya fue aplicada', 'revisá el resultado en el historial antes de preparar una operación nueva');
register('SELECTION_CANCELLED', 'esa selección fue cancelada', 'prepará una nueva selección y revisala antes de confirmar');
register('DRAFT_VERSION_MISMATCH SELECTION_CONFIRMATION_MISMATCH', 'la confirmación o respuesta corresponde a una versión anterior de la propuesta', 'recuperá la revisión vigente en el panel y leela antes de confirmar; en WhatsApp, cancelá la pendiente y enviá la instrucción completa para preparar otra');
register('REVISION_MISMATCH ACCOUNT_REVISION_MISMATCH PARTY_REVISION_MISMATCH ORDER_REVISION_MISMATCH SKU_FINGERPRINT_MISMATCH CONCURRENT_INVENTORY_CHANGE PRODUCT_CHANGED REVISION_CONFLICT', 'los datos cambiaron después de preparar la propuesta', 'consultá los valores actuales, cancelá el borrador pendiente y enviá la instrucción completa para revisar una nueva propuesta');
register('INSUFFICIENT_STOCK', 'no hay suficientes unidades disponibles para la cantidad solicitada', 'cancelá el borrador pendiente y consultá el stock actual con «Mostrame el stock de [producto y variante]»; después enviá una nueva instrucción con la cantidad corregida');
register('SKU_HAS_RESERVATIONS', 'el producto tiene unidades reservadas que impiden esa operación', 'revisá sus reservas y resolvelas explícitamente antes de volver a pedir el cambio');
register('SKU_NOT_FOUND CLIENT_NOT_FOUND SUPPLIER_NOT_FOUND PARTY_NOT_FOUND ORDER_NOT_FOUND RESOURCE_NOT_FOUND', 'el producto, persona o pedido indicado no existe o no pertenece a este negocio', 'consultá los registros del negocio y reenviá la instrucción con el nombre exacto y la variante o datos que permitan distinguirlo');
register('SKU_INACTIVE PRODUCT_ARCHIVED', 'el producto está dado de baja y no admite esa operación', 'revisá el producto en el panel y elegí un producto activo; si corresponde recuperar el anterior, consultá con quien administra el negocio');
register('DUPLICATE_SKU_IDENTITY SKU_IDENTITY_CONFLICT', 'ya existe un producto con esas características o sus datos de identidad se contradicen', 'consultá el inventario y elegí el producto existente; si es otro producto, indicá la característica que lo diferencia');
register('DUPLICATE_SKU_ID', 'no pude asignar un identificador único al producto nuevo', 'reintentá el alta desde el panel; si se repite, consultá con quien administra el negocio');
register('PRICE_CONFLICT CURRENCY_CONFLICT', 'el precio o la moneda solicitados no coinciden con los datos actuales del producto', 'consultá el precio actual y pedí explícitamente el cambio con importe y moneda; por ejemplo, «Cambiá el precio de [producto] a [importe] ARS»');
register('PAYMENT_EXCEEDS_DEBT', 'el pago solicitado supera la deuda actual del cliente', 'consultá su saldo desde el panel y corregí el importe del pago; para consultar por WhatsApp, cancelá primero el borrador y enviá «Mostrame la cuenta de [cliente]»');
register('CLIENT_HAS_BALANCE', 'el cliente todavía tiene saldo en su cuenta', 'consultá la cuenta y resolvé o transferí el saldo explícitamente antes de pedir la baja');
register('CLIENT_HAS_ORDERS', 'el cliente todavía tiene pedidos vinculados', 'consultá sus pedidos y resolvelos explícitamente antes de pedir la baja del cliente');
register('ACCOUNT_OPERATION_REQUIRED', 'el saldo del cliente debe modificarse mediante una operación de cuenta', 'pedí un cargo, pago o ajuste de cuenta explícito, con cliente, importe y motivo');
register('MONEY_UNCONFIRMED MONEY_CONFIRMATION_REQUIRED MONEY_POLICY_CONFLICT', 'la configuración monetaria necesaria no está confirmada o cambió', 'revisá y confirmá la moneda del negocio en el panel antes de registrar precios o importes');
register('STOCK_OVERFLOW MONEY_OVERFLOW', 'la cantidad o el importe exceden el rango que el sistema puede registrar con precisión', 'revisá los números enviados y corregilos antes de preparar otra propuesta');
register('PRODUCT_SCHEMA_NOT_FOUND PRODUCT_SCHEMA_VERSION_MISMATCH SKU_FAMILY_MISMATCH', 'la familia o versión indicada no coincide con la configuración del producto', 'revisá las familias disponibles en el panel y elegí la versión correcta sin cambiar automáticamente la unidad del producto');
register('INVALID_PRODUCT_SCHEMA PRODUCT_SCHEMA_MISMATCH', 'los atributos del producto no cumplen la definición de su familia', 'revisá en el panel los atributos requeridos, sus tipos y unidades, y completá los que correspondan');
register('ORDER_RECONCILIATION_REQUIRED ORDER_RECONCILIATION_MISMATCH ORDER_POSTING_INVALID', 'los movimientos históricos del pedido necesitan una revisión antes de continuar', 'abrí el pedido en el panel y revisá su conciliación de inventario antes de solicitar otro cambio');
register('ORDER_RECONCILIATION_NOT_REQUIRED INVALID_TRANSITION', 'el estado actual del pedido no admite el cambio solicitado', 'consultá el pedido y elegí una acción válida para su estado actual');
register('SELECTION_REQUIRED SKU_SELECTION_REQUIRED CLIENT_SELECTION_REQUIRED PARTY_SELECTION_REQUIRED ORDER_SELECTION_REQUIRED SELECTION_SCOPE_MISMATCH SELECTION_OPERATION_MISMATCH INVALID_SELECTION EMPTY_SELECTION', 'no hay una selección válida y revisada para los registros que querés modificar', 'seleccioná los registros exactos en el panel y revisá una nueva propuesta antes de confirmar');
register('UNSUPPORTED_OPERATION UNSUPPORTED_OPERATION_ORDER UNSUPPORTED_MIXED_OPERATION MIXED_OPERATION_PLAN_UNSUPPORTED', 'la acción o combinación de cambios solicitados no está admitida en ese formato', 'separá las acciones en mensajes individuales, indicando en cada uno qué registro y qué dato querés cambiar');
register('INVALID_DRAFT_REQUEST INVALID_COMMAND INVALID_INTERPRETER_REQUEST OPERATION_ID_REQUIRED', 'el mensaje o la referencia de la propuesta está incompleto o no es válido', 'enviá la instrucción completa; si hay un borrador pendiente, respondé su aclaración o escribí «cancelar» para descartarlo');
register('IDEMPOTENCY_CONFLICT', 'el mismo mensaje o intento ya quedó asociado a otra instrucción', 'recuperá el resultado anterior en el historial antes de enviar una instrucción nueva, para evitar duplicar cambios');
register('LEGACY_WRITER_RETIRED LEGACY_INTERPRETER_RETIRED', 'esa operación pertenece a un flujo anterior que ya no se puede continuar', 'enviá «REVISAR OPERACION [instrucción completa]» para preparar una nueva revisión');
register('INVALID_RECOVERY_REQUEST LEGACY_RECEIPT_AMBIGUOUS LEGACY_RECEIPT_UNVERIFIABLE PERSISTED_EFFECT_MISMATCH', 'no pude verificar de forma confiable el resultado guardado de la operación', 'consultá el historial y recuperá el estado desde el panel antes de repetir el pedido; si no aparece un resultado claro, contactá a quien administra el negocio');
register('UNIVERSAL_FOUNDATION_REQUIRED UNIVERSAL_SCHEMA_INCOMPLETE UNIVERSAL_SCHEMA_NOT_READY', 'el negocio todavía no tiene lista la configuración necesaria para estas operaciones', 'consultá con quien administra el negocio para completar la configuración antes de volver a intentar');
register('transcription_not_configured', 'la transcripción de audio no está configurada', 'enviá el pedido por escrito y avisá a quien administra el negocio para habilitar el audio');
register('transcription_timeout', 'el servicio de transcripción tardó demasiado en responder', 'enviá el pedido por escrito o grabá un audio más corto');
register('transcription_provider_error invalid_transcription_response TRANSCRIPTION_UNAVAILABLE', 'el servicio de audio no pudo devolver una transcripción válida', 'enviá el pedido por escrito o reintentá con un audio breve y claro');
register('unsupported_audio_type', 'el formato del audio no está admitido', 'grabá otro audio o enviá la instrucción por escrito');
register('empty_audio', 'el archivo de audio está vacío', 'grabá otro audio y verificá que se escuche antes de enviarlo, o escribí el pedido');
register('audio_too_large AUDIO_TOO_LARGE', 'el archivo de audio supera el tamaño máximo permitido', 'grabá un audio más corto o enviá la instrucción por escrito');
register('invalid_audio INVALID_AUDIO', 'no pude obtener un archivo de audio válido para procesar', 'volvé a adjuntar el audio o enviá la instrucción por escrito');
register('STATE_UNAVAILABLE', 'no pude leer los datos guardados del negocio', 'conservá tu vista actual y actualizá el panel en unos momentos; verificá el estado antes de repetir cualquier operación');
register('EMPTY_MESSAGE', 'el mensaje no contiene texto ni audio que pueda procesar', 'enviá el pedido por escrito o como nota de voz, indicando qué querés hacer y sobre qué producto o persona');
register('MESSAGE_NOT_UNDERSTOOD', 'no pude identificar una acción y los datos necesarios en el mensaje', 'indicá la acción, el producto o persona exactos y la cantidad o importe; por ejemplo, «Ingresá 2 unidades de [producto], variante [talle o tamaño]»');

const unknownAdvice = { why: 'ocurrió un error cuya causa exacta no pude determinar', action: 'recuperá el estado de la operación y revisá el historial desde el panel antes de repetirla; si persiste, consultá con quien administra el negocio' };
const stockRemovalHint = sourceText => {
  const text = sourceText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\b(borra\w*|elimina\w*|quita\w*|retira\w*|desconta\w*|saca\w*)\b/.test(text)
    && !/\b(cliente|proveedor|pedido)\b/.test(text);
};

// Only presentation hints are retained; no user text or model payload enters error details.
export const interpretationRecoveryContext = (sourceText, reply) => ({ stockRemoval: stockRemovalHint(sourceText), reply });

/** Presentation only: suggestions never supply or change an executable plan. */
export function interpretationRecoveryMessage({ reason, sourceText = '', channel = 'panel', reply = false, stockRemoval = stockRemovalHint(sourceText) } = {}) {
  const text = sourceText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const cause = advice.get(reason) ?? { why: 'la respuesta automática no pasó las validaciones y no pude identificar un motivo más específico', action: 'reenviá la instrucción completa; si vuelve a fallar, usá el panel' };
  let explanation = `No pude preparar la operación porque ${cause.why}. No apliqué cambios.`;
  let guidance = `${cause.action}. Indicá la instrucción completa en un solo mensaje: qué querés hacer, sobre qué producto, cliente, proveedor o pedido, y los datos del cambio.`;
  let example = 'Ejemplo de formato: «[Acción que querés realizar] sobre [nombre exacto del producto, cliente, proveedor o pedido]: [datos del cambio, cantidad o importe y moneda]».';

  if (reason === 'FORBIDDEN') {
    explanation = 'No pude preparar la operación porque ese tipo de cambio no está habilitado para este canal o usuario. No apliqué cambios.';
    guidance = 'Reformular el mismo pedido no habilita una operación restringida. Si necesitás esa operación, consultá con quien administra el negocio.';
  }
  if (stockRemoval) {
    guidance = `${reason === 'FORBIDDEN' ? 'El retiro directo de unidades no está habilitado en este canal. ' : ''}Si querés corregir el stock, indicá cuántas unidades disponibles deben quedar, el producto exacto y su variante si corresponde. Indicá el saldo final, no la cantidad que querés quitar. Para dar de baja el producto completo, pedilo explícitamente.`;
    example = 'Ejemplo de ajuste: «Ajustá el stock disponible de [nombre exacto del producto], variante [talle o tamaño], a [cantidad final] unidades. Motivo: [motivo del ajuste]».';
  } else if (reason !== 'FORBIDDEN' && /\b(pedido\w*)\b/.test(text)) {
    example = 'Ejemplo de formato: «[Creá / Modificá / Eliminá] el pedido de [nombre completo del cliente]: [cantidad] unidades de [producto], variante [talle o tamaño]». Elegí la acción que necesitás e identificá el pedido si ya existe.';
  } else if (reason !== 'FORBIDDEN' && /\b(cuenta|pago\w*|fiado|deuda|cobr\w*)\b/.test(text)) {
    example = 'Ejemplo de formato: «[Cargá una deuda / Registrá un pago] de [importe] en la cuenta de [nombre completo del cliente]. Motivo: [motivo]». Elegí la acción que necesitás.';
  } else if (reason !== 'FORBIDDEN' && /\b(ingres\w*|recib\w*|vend\w*|reserv\w*)\b/.test(text)) {
    example = 'Ejemplo de formato: «[Ingresá / Vendé / Reservá] [cantidad] unidades de [nombre exacto del producto], variante [talle o tamaño]». Elegí una sola acción.';
  }

  const nextStep = channel === 'whatsapp'
    ? reply
      ? 'El borrador anterior sigue pendiente mientras esté vigente. Volvé a responder en este chat con la instrucción completa, o escribí «cancelar» para descartarlo.'
      : 'Enviá un nuevo mensaje con la instrucción completa.'
    : reply
      ? 'El borrador anterior sigue pendiente mientras esté vigente. Corregí tu respuesta y volvé a enviarla, o cancelá el borrador para comenzar otra operación.'
      : 'Corregí la solicitud y volvé a enviarla.';
  return [explanation, `Probá: ${guidance}`, `${example} Reemplazá los datos entre corchetes y omití la variante si no corresponde.`, nextStep].join('\n\n');
}

/** Shared by WhatsApp rejections and operation HTTP errors. Unknown failures do
 * not claim rollback: their result must be recovered before retrying a write. */
export function operationErrorMessage(error, { channel = 'panel', sourceText = '', noChanges = false } = {}) {
  if (error?.code === 'INTERPRETATION_INVALID') return interpretationRecoveryMessage({
    reason: error.details?.reason, channel, sourceText,
    ...(typeof error.details?.recovery?.stockRemoval === 'boolean' ? { stockRemoval: error.details.recovery.stockRemoval } : {}),
    reply: error.details?.recovery?.reply === true,
  });
  const cause = (error?.code === 'INTERPRETATION_UNAVAILABLE' ? advice.get(error.details?.reason) : undefined)
    ?? advice.get(error?.code) ?? unknownAdvice;
  const action = channel === 'panel' ? cause.action.replace('escribí «cancelar»', 'cancelá el borrador desde el panel') : cause.action;
  return `No pude completar la operación porque ${cause.why}.${noChanges ? ' No apliqué cambios.' : ''}\n\nProbá: ${action}.`;
}
