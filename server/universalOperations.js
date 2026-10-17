import { InventoryOperationError, validateOperationPlan, operationDigest } from './inventoryOperations.js';
import { validateAccountPlan, accountPlanDigest } from './accountOperations.js';
import { validatePartyPlan, partyPlanDigest } from './partyOperations.js';
import { requireReviewedUpdateSelection } from './inventorySelections.js';
import { operationRequestDigest } from './operationHash.js';

const fail = (code, message) => { throw new InventoryOperationError(code,message); };
const invalid = () => fail('INVALID_OPERATION_PLAN','El plan universal contiene campos o acciones inválidos.');
const valueOf = (record, key) => {
  const descriptor = record && typeof record === 'object' ? Object.getOwnPropertyDescriptor(record,key) : null;
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor,'value')) invalid();
  return descriptor.value;
};
const domains = new Map([
  ...['stock.receive','stock.sell','stock.reserve','stock.withdraw','stock.adjust','sku.create','sku.update','sku.deactivate'].map((type) => [type,'inventory']),
  ...['account.charge','account.payment','account.adjust','account.transfer'].map((type) => [type,'accounts']),
  ...['client.create','client.update','client.delete','supplier.create','supplier.update','supplier.delete','supplier.merge'].map((type) => [type,'parties']),
]);

/** One entry contract, existing domain validators. Cross-domain composition is not enabled yet. */
export function prepareUniversalOperation(input, context) {
  if (typeof context?.businessId !== 'string' || !context.businessId.trim() || context.businessId === '__default__'
    || typeof context.actorId !== 'string' || !context.actorId.trim()) fail('BUSINESS_SCOPE_REQUIRED','Falta el negocio/actor autorizado.');
  if (!(Array.isArray(context.permissions) || context.permissions instanceof Set)) fail('FORBIDDEN','Faltan permisos de operación.');
  if (!input || typeof input !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) invalid();
  for (const key of Reflect.ownKeys(input)) {
    if (!['contractVersion','businessId','operationId','source','actions'].includes(key)) invalid();
    valueOf(input,key);
  }
  if (valueOf(input,'contractVersion') !== 1) invalid();
  const operationId = Object.hasOwn(input,'operationId') ? valueOf(input,'operationId') : undefined;
  if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 180)
    fail('OPERATION_ID_REQUIRED','La operación requiere un ID estable para reintentar.');
  const actions = valueOf(input,'actions');
  if (!Array.isArray(actions) || Object.getPrototypeOf(actions) !== Array.prototype || !actions.length || actions.length > 100
    || Reflect.ownKeys(actions).length !== actions.length + 1) invalid();
  const selected = new Set();
  for (let index = 0; index < actions.length; index++) {
    const action = valueOf(actions,String(index)), type = valueOf(action,'type');
    if (!domains.has(type)) invalid();
    selected.add(domains.get(type));
  }
  if (selected.size !== 1) fail('MIXED_OPERATION_PLAN_UNSUPPORTED','El lote combina dominios que todavía requieren planes separados. No apliqué ningún cambio.');
  const domain = [...selected][0], candidate = {...input,operationId:operationId.trim()};
  const validate = {inventory:validateOperationPlan,accounts:validateAccountPlan,parties:validatePartyPlan}[domain];
  const plan = validate(candidate,context);
  if (domain === 'inventory') requireReviewedUpdateSelection(plan);
  const digest = {inventory:operationDigest,accounts:accountPlanDigest,parties:partyPlanDigest}[domain];
  return Object.freeze({domain,plan,requestHash:operationRequestDigest({domain,digest:digest(plan)})});
}
