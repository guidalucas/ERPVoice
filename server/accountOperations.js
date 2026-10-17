import { InventoryOperationError } from './inventoryOperations.js';
import { operationRequestDigest } from './operationHash.js';
const fail = (code, message) => { throw new InventoryOperationError(code, message); };
const invalid = (message) => fail('INVALID_ACCOUNT_OPERATION', message);
const record = (value, allowed) => {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        invalid('Se requiere un objeto de cuenta.');
    const copy = {};
    for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!allowed.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value') || property.value === undefined)
            invalid(`Campo de cuenta no permitido: ${String(key)}`);
        copy[key] = property.value;
    }
    return copy;
};
const text = (value) => { if (typeof value !== 'string' || !value.trim())
    invalid('Se requiere texto no vacío.'); return value; };
const integer = (value, min = 0) => { if (!Number.isSafeInteger(value) || value < min)
    invalid('Importe/revisión debe ser un entero seguro no negativo.'); return value; };
const freeze = (value) => { if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
} return value; };
/** Same OperationPlan v1 envelope, independent account domain; legacy monetary units are explicit. */
export function normalizeAccountPlan(input) {
    const plan = record(input, ['contractVersion', 'operationId', 'businessId', 'actions', 'source']);
    if (plan.contractVersion !== 1)
        invalid('contractVersion debe ser 1.');
    const result = { contractVersion: 1, operationId: text(plan.operationId), businessId: text(plan.businessId), actions: [] };
    if (!Array.isArray(plan.actions) || Object.getPrototypeOf(plan.actions) !== Array.prototype || !plan.actions.length || plan.actions.length > 100 || Reflect.ownKeys(plan.actions).length !== plan.actions.length + 1)
        invalid('El plan admite entre 1 y 100 acciones densas.');
    const seen = new Set();
    result.actions = Array.from({ length: plan.actions.length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(plan.actions, String(index));
        if (!property || !Object.hasOwn(property, 'value'))
            invalid('Acción de cuenta inválida.');
        const action = record(property.value, ['itemId', 'type', 'target', 'destination', 'amount', 'reason']);
        if (!['account.charge', 'account.payment', 'account.adjust', 'account.transfer'].includes(action.type))
            invalid('Operación de cuenta desconocida.');
        const itemId = text(action.itemId);
        if (seen.has(itemId))
            invalid('itemId duplicado.');
        seen.add(itemId);
        const target = record(action.target, ['kind', 'clientId', 'expectedRevision']);
        if (target.kind !== 'existing')
            invalid('Se requiere cliente existente explícito.');
        const normalizedTarget = { kind: 'existing', clientId: text(target.clientId) };
        if (Object.hasOwn(target, 'expectedRevision'))
            normalizedTarget.expectedRevision = integer(target.expectedRevision);
        if (['account.adjust', 'account.transfer'].includes(action.type) && normalizedTarget.expectedRevision === undefined)
            invalid('La operación requiere expectedRevision.');
        const amount = record(action.amount, ['value', 'unit']);
        if (amount.unit !== 'legacy-money')
            invalid('Esta cuenta solo admite unidades monetarias históricas, sin conversión de moneda.');
        const normalized = { itemId, type: action.type, target: normalizedTarget, amount: { value: integer(amount.value, action.type === 'account.adjust' ? 0 : 1), unit: amount.unit }, reason: text(action.reason) };
        if (action.type === 'account.transfer') {
            const destination = record(action.destination, ['clientId', 'expectedRevision']);
            normalized.destination = { clientId: text(destination.clientId), expectedRevision: integer(destination.expectedRevision) };
            if (normalized.destination.clientId === normalizedTarget.clientId)
                invalid('Las cuentas de transferencia deben ser distintas.');
        }
        else if (Object.hasOwn(action, 'destination'))
            invalid('Solo una transferencia admite destino.');
        return normalized;
    });
    if (plan.source !== undefined) {
        const source = record(plan.source, ['channel', 'text', 'requestHash']);
        result.source = { channel: text(source.channel) };
        for (const key of ['text', 'requestHash'])
            if (Object.hasOwn(source, key))
                result.source[key] = text(source[key]);
    }
    return freeze(result);
}
export const accountPlanDigest = (input) => { const { source, ...plan } = normalizeAccountPlan(input); return operationRequestDigest({ ...plan, ...(source?.requestHash ? { requestHash: source.requestHash } : {}) }); };
export function validateAccountPlan(input, context) {
    if (typeof context?.businessId !== 'string' || !context.businessId.trim() || context.businessId === '__default__' || typeof context.actorId !== 'string' || !context.actorId.trim())
        fail('BUSINESS_SCOPE_REQUIRED', 'Falta el negocio/actor autorizado.');
    if (!(Array.isArray(context.permissions) || context.permissions instanceof Set))
        fail('FORBIDDEN', 'Faltan permisos de cuenta.');
    const plan = normalizeAccountPlan(input);
    if ((plan.operationId.startsWith('client-merge:') || plan.operationId.startsWith('client-merge-transfer:')) && !context.internalClientMerge)
        fail('FORBIDDEN', 'Los IDs internos de fusión están reservados al ejecutor de clientes.');
    if (plan.businessId !== context.businessId)
        fail('BUSINESS_SCOPE_MISMATCH', 'El plan no pertenece al negocio autorizado.');
    for (const action of plan.actions)
        if (![...context.permissions].includes(`accounts:${action.type.split('.')[1]}`))
            fail('FORBIDDEN', 'No tenés permiso para esta operación de cuenta.');
    return plan;
}
export function planAccountOperation(input, clients) {
    const plan = normalizeAccountPlan(input), byId = new Map(), originals = new Map(), changed = new Map(), items = [], movements = [];
    for (const row of clients) {
        if (byId.has(row.id))
            invalid('Cliente duplicado.');
        const client = { ...row, debt: integer(row.debt), accountRevision: integer(row.accountRevision ?? 0) };
        byId.set(client.id, client);
        originals.set(client.id, client.accountRevision);
    }
    const resolve = (target) => { const client = byId.get(target.clientId); if (!client)
        fail('CLIENT_NOT_FOUND', 'El cliente no pertenece al negocio.'); if (target.expectedRevision !== undefined && target.expectedRevision !== originals.get(client.id))
        fail('ACCOUNT_REVISION_MISMATCH', 'La cuenta cambió. Revisá el saldo actual.'); return client; };
    for (const action of plan.actions) {
        const client = resolve(action.target), before = client.debt, value = action.amount.value;
        if (['account.payment', 'account.transfer'].includes(action.type) && value > before)
            fail('PAYMENT_EXCEEDS_DEBT', 'El importe supera la deuda; no apliqué el lote.');
        const next = action.type === 'account.adjust' ? value : action.type === 'account.charge' ? before + value : before - value;
        if (!Number.isSafeInteger(next))
            fail('MONEY_OVERFLOW', 'El saldo excede el rango monetario seguro.');
        let destination;
        if (action.type === 'account.transfer') {
            destination = resolve(action.destination);
            if (!Number.isSafeInteger(destination.debt + value))
                fail('MONEY_OVERFLOW', 'El saldo de destino excede el rango seguro.');
            destination.debt += value;
            changed.set(destination.id, destination);
            movements.push({ itemId: action.itemId, clientId: destination.id, delta: value });
        }
        client.debt = next;
        changed.set(client.id, client);
        movements.push({ itemId: action.itemId, clientId: client.id, delta: next - before });
        items.push({ itemId: action.itemId, type: action.type, clientId: client.id, clientName: client.name, amount: value, unit: 'legacy-money', balance: next, reason: action.reason,
            ...(destination ? { destinationId: destination.id, destinationName: destination.name, destinationBalance: destination.debt } : {}) });
    }
    return { changedClients: [...changed.values()], items, movements };
}
export const accountResultActions = (result) => result.items.map((item) => ({
    type: { 'account.charge': 'add_debt', 'account.payment': 'payment_received', 'account.adjust': 'account_adjustment', 'account.transfer': 'account_transfer' }[item.type],
    clientId: item.clientId, clientName: item.clientName, amount: item.amount, unit: item.unit, balance: item.balance, reason: item.reason, revision: item.revision,
    ...(item.destinationId ? { destinationId: item.destinationId, destinationBalance: item.destinationBalance } : {})
}));
export const accountResultReply = (result) => result.items.map((item) => `${{ 'account.charge': 'Cargo registrado', 'account.payment': 'Pago registrado', 'account.adjust': 'Saldo ajustado', 'account.transfer': 'Transferencia registrada' }[item.type]}: ${item.clientName}; importe ${item.amount}; saldo ${item.balance}${item.destinationId ? `; destino ${item.destinationName}: ${item.destinationBalance}` : ''}.`).join('\n');
