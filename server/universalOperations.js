import { InventoryOperationError, validateOperationPlan, operationDigest } from './inventoryOperations.js';
import { validateAccountPlan, accountPlanDigest } from './accountOperations.js';
import { validatePartyPlan, partyPlanDigest } from './partyOperations.js';
import { requireReviewedUpdateSelection } from './inventorySelections.js';
import { operationRequestDigest } from './operationHash.js';
import { validateUniversalOrderPlan, universalOrderPlanDigest } from './universalOrderOperations.js';

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
  ...['order.create','order.update','order.delete','order.reconcile'].map((type) => [type,'orders']),
]);

const validators = {inventory:validateOperationPlan,accounts:validateAccountPlan,parties:validatePartyPlan,orders:validateUniversalOrderPlan};
const digests = {inventory:operationDigest,accounts:accountPlanDigest,parties:partyPlanDigest,orders:universalOrderPlanDigest};

/** One entry contract; each contiguous domain block uses its existing validator. */
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
  const selected = new Set(), blocks = [];
  for (let index = 0; index < actions.length; index++) {
    const action = valueOf(actions,String(index)), type = valueOf(action,'type');
    if (!domains.has(type)) invalid();
    const domain = domains.get(type);
    if (blocks.at(-1)?.domain !== domain) {
      if (selected.has(domain)) fail('UNSUPPORTED_OPERATION_ORDER','Cada dominio debe aparecer en un único bloque contiguo. No apliqué ningún cambio.');
      blocks.push({domain,actions:[]});
      selected.add(domain);
    }
    blocks.at(-1).actions.push(action);
  }
  const candidate = {...input,operationId:operationId.trim()};
  const prepareBlock = (domain, blockCandidate) => {
    const plan = validators[domain](blockCandidate,context);
    if (domain === 'inventory') requireReviewedUpdateSelection(plan);
    return plan;
  };
  if (selected.size === 1) {
    const domain = blocks[0].domain, plan = prepareBlock(domain,candidate);
    return Object.freeze({domain,plan,requestHash:operationRequestDigest({domain,digest:digests[domain](plan)})});
  }
  const itemIds = new Set();
  for (const block of blocks) for (const action of block.actions) {
    const itemId = valueOf(action,'itemId');
    if (itemIds.has(itemId)) invalid();
    itemIds.add(itemId);
  }
  const segments = Object.freeze(blocks.map(({domain,actions}) => Object.freeze({domain,plan:prepareBlock(domain,{...candidate,actions})})));
  const plan = Object.freeze({...segments[0].plan,actions:Object.freeze(segments.flatMap(({plan}) => plan.actions))});
  if (new Set(plan.actions.map((action) => action.itemId)).size !== plan.actions.length) invalid();
  const requestHash = operationRequestDigest({segments:segments.map(({domain,plan}) => ({domain,digest:digests[domain](plan)}))});
  return Object.freeze({domain:'mixed',plan,segments,requestHash});
}
