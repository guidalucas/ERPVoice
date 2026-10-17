import { InventoryOperationError } from './inventoryOperations.js';
import { operationRequestDigest } from './operationHash.js';

const fail = (code, message) => { throw new InventoryOperationError(code, message); };
const invalid = () => fail('INVALID_PARTY_OPERATION', 'El alta de cliente/proveedor contiene campos inválidos.');
const record = (value, keys) => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) invalid();
    result[key] = descriptor.value;
  }
  return result;
};
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid();
  return value.trim();
};
const nameOf = (value) => text(value, 200).split(/\s+/).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
const notesOf = (value) => {
  if (value !== null && (typeof value !== 'string' || value.length > 8000)) invalid();
  return value?.trim() || null;
};
const revisionOf = (value) => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) invalid();
  return value;
};
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

/** OperationPlan v1, metadata only: initial client accounts always start at zero. */
export function normalizePartyPlan(input) {
  const plan = record(input, ['contractVersion', 'operationId', 'businessId', 'actions', 'source']);
  if (plan.contractVersion !== 1) invalid();
  const result = { contractVersion: 1, operationId: text(plan.operationId, 180), businessId: text(plan.businessId, 180), actions: [] };
  if (!Array.isArray(plan.actions) || Object.getPrototypeOf(plan.actions) !== Array.prototype
    || !plan.actions.length || plan.actions.length > 100 || Reflect.ownKeys(plan.actions).length !== plan.actions.length + 1) invalid();
  const seen = new Set(), targets = new Set();
  result.actions = Array.from({ length: plan.actions.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(plan.actions, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    const action = record(descriptor.value, ['itemId', 'type', 'name', 'notas', 'target', 'changes']);
    if (!['client.create', 'supplier.create', 'client.update', 'supplier.update'].includes(action.type)) invalid();
    const itemId = text(action.itemId, 180);
    if (seen.has(itemId)) invalid();
    seen.add(itemId);
    if (action.type.endsWith('.create')) {
      if (Object.hasOwn(action,'target') || Object.hasOwn(action,'changes')) invalid();
      return { itemId, type: action.type, name: nameOf(action.name), notas: action.notas === undefined ? null : notesOf(action.notas) };
    }
    if (Object.hasOwn(action,'name') || Object.hasOwn(action,'notas')) invalid();
    const target = record(action.target, ['kind','partyId','expectedRevision']);
    if (target.kind !== 'existing') invalid();
    const normalizedTarget = {kind:'existing',partyId:text(target.partyId,180),expectedRevision:revisionOf(target.expectedRevision)};
    const key = JSON.stringify([action.type.split('.')[0],normalizedTarget.partyId]);
    if (targets.has(key)) invalid();
    targets.add(key);
    const changes = record(action.changes,['name','notas']), normalizedChanges = {};
    if (!Object.keys(changes).length) invalid();
    if (Object.hasOwn(changes,'name')) normalizedChanges.name = nameOf(changes.name);
    if (Object.hasOwn(changes,'notas')) normalizedChanges.notas = notesOf(changes.notas);
    return {itemId,type:action.type,target:normalizedTarget,changes:normalizedChanges};
  });
  if (plan.source !== undefined) {
    const source = record(plan.source, ['channel', 'text']);
    result.source = { channel: text(source.channel, 80) };
    if (source.text !== undefined) result.source.text = text(source.text, 16000);
  }
  return freeze(result);
}

export function validatePartyPlan(input, context) {
  if (typeof context?.businessId !== 'string' || !context.businessId.trim() || context.businessId === '__default__'
    || typeof context.actorId !== 'string' || !context.actorId.trim()) fail('BUSINESS_SCOPE_REQUIRED', 'Falta el negocio/actor autorizado.');
  if (!(Array.isArray(context.permissions) || context.permissions instanceof Set)) fail('FORBIDDEN', 'Faltan permisos de alta.');
  const plan = normalizePartyPlan(input);
  if (plan.businessId !== context.businessId) fail('BUSINESS_SCOPE_MISMATCH', 'El plan no pertenece al negocio autorizado.');
  if (plan.operationId.startsWith('order-party:') && !context.internalOrderBatch) fail('FORBIDDEN', 'ID reservado para los participantes de un pedido.');
  for (const action of plan.actions) {
    const [kind, verb] = action.type.split('.');
    if (![...context.permissions].includes(`${kind === 'client' ? 'clients' : 'suppliers'}:${verb}`)) fail('FORBIDDEN', 'No tenés permiso para esta operación.');
  }
  return plan;
}

export const partyPlanDigest = (input) => {
  const { source, ...semantic } = normalizePartyPlan(input);
  return operationRequestDigest(semantic);
};

/** Legacy HTTP shapes only adapt to the closed universal contract. */
export function partyCreationToPlan(kind, input, businessId) {
  if (!['client','supplier'].includes(kind)) invalid();
  const debt = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'debt') : undefined;
  if (kind === 'client' && debt && Object.hasOwn(debt, 'value') && debt.value !== undefined && debt.value !== 0)
    fail('ACCOUNT_OPERATION_REQUIRED', 'Creá el cliente con saldo cero y registrá el cargo con un plan de cuenta explícito.');
  if (input && typeof input === 'object') {
    const id = Object.getOwnPropertyDescriptor(input, 'operationId');
    if (!id || (Object.hasOwn(id, 'value') && (typeof id.value !== 'string' || !id.value.trim() || id.value.length > 180)))
      fail('OPERATION_ID_REQUIRED', 'El alta requiere un ID estable para reintentar.');
  }
  const body = record(input, kind === 'client' ? ['operationId', 'name', 'notas', 'debt'] : ['operationId', 'name', 'notas']);
  if (typeof body.operationId !== 'string' || !body.operationId.trim() || body.operationId.length > 180)
    fail('OPERATION_ID_REQUIRED', 'El alta requiere un ID estable para reintentar.');
  return normalizePartyPlan({ contractVersion: 1, businessId, operationId: body.operationId,
    actions: [{ itemId: 'party-1', type: kind === 'client' ? 'client.create' : 'supplier.create', name: body.name,
      ...(body.notas !== undefined ? { notas: body.notas } : {}) }] });
}

export function partyUpdateToPlan(kind, partyId, input, businessId) {
  if (!['client','supplier'].includes(kind)) invalid();
  const debt = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'debt') : undefined;
  if (kind === 'client' && debt) fail('ACCOUNT_OPERATION_REQUIRED', 'El saldo requiere un ajuste de cuenta explícito con motivo y revisión.');
  const id = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input,'operationId') : null;
  if (!id || (Object.hasOwn(id,'value') && (typeof id.value !== 'string' || !id.value.trim() || id.value.length > 180)))
    fail('OPERATION_ID_REQUIRED', 'La edición requiere un ID estable para reintentar.');
  const body = record(input,['operationId','expectedRevision','name','notas']);
  const changes = {};
  for (const key of ['name','notas']) if (Object.hasOwn(body,key)) changes[key] = body[key];
  return normalizePartyPlan({contractVersion:1,businessId,operationId:body.operationId,
    actions:[{itemId:'party-1',type:`${kind}.update`,target:{kind:'existing',partyId,expectedRevision:body.expectedRevision},changes}]});
}

/** Deterministic patch, independent from accounts, transport and storage. */
export function planPartyUpdate(action, current) {
  if (!current) fail('PARTY_NOT_FOUND', 'El cliente/proveedor no pertenece al negocio.');
  if (!Number.isSafeInteger(current.metadataRevision) || current.metadataRevision < 0 || current.metadataRevision >= Number.MAX_SAFE_INTEGER) invalid();
  if (Object.hasOwn(current,'debt') && (!Number.isSafeInteger(current.debt) || current.debt < 0 || !Number.isSafeInteger(current.accountRevision) || current.accountRevision < 0)) invalid();
  if (current.metadataRevision !== action.target.expectedRevision) fail('PARTY_REVISION_MISMATCH', 'El cliente/proveedor cambió. Revisá sus datos antes de editar.');
  return {...current,...action.changes,metadataRevision:current.metadataRevision + 1};
}

export const partyResultActions = (result) => result.items.map(({ itemId, type, party }) => ({ type, itemId,
  ...(type.startsWith('client.') ? { clientId: party.id, clientName: party.name } : { proveedorId: party.id, proveedorName: party.name }),
  notas: party.notas, metadataRevision: party.metadataRevision }));
