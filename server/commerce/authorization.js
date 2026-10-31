import { normalizePhone } from '../phone.js';
import { fail } from './errors.js';

export function authorizeCommerce(context, { enabled, permission = 'commerce:read' } = {}) {
  const actor = normalizePhone(context?.actorId), business = normalizePhone(context?.businessId);
  if (!actor || !business || actor !== context?.actorId || business !== context?.businessId) fail('UNAUTHENTICATED', 'La sesión no es válida.', 401);
  const owner = actor === business && context?.role === 'owner';
  const admin = actor !== business && context?.role === 'admin';
  if ((!owner && !admin) || enabled !== true) fail('COMMERCE_FORBIDDEN', 'No tenés acceso a Stocky Studio.', 403);
  if (!['commerce:read', 'commerce:write', 'commerce:media', 'commerce:story', 'commerce:settings'].includes(permission)) fail('COMMERCE_FORBIDDEN', 'Permiso no disponible.', 403);
  return { actorId: actor, businessId: business, permission };
}

// Check the stored membership inside the same transaction as the commercial work.
// JWT claims and an older session cannot retain a revoked administrator role.
export async function requireCommerceIdentity(client, context, { permission, lock = false } = {}) {
  authorizeCommerce(context, { enabled: true, permission });
  const membership = (await client.query(`SELECT tenant_phone,role FROM business_members WHERE member_phone=$1${lock ? ' FOR SHARE' : ''}`, [context.actorId])).rows[0];
  const allowed = context.role === 'admin'
    ? membership?.tenant_phone === context.businessId && membership.role === 'admin'
    : !membership || membership.tenant_phone === context.businessId;
  if (!allowed) fail('COMMERCE_FORBIDDEN', 'Tu acceso a Studio cambió. Actualizá la sesión desde Stocky.', 403);
}
