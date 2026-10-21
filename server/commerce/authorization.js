import { normalizePhone } from '../phone.js';
import { fail } from './errors.js';

export function authorizeCommerce(context, { enabled, permission = 'commerce:read' } = {}) {
  const actor = normalizePhone(context?.actorId), business = normalizePhone(context?.businessId);
  if (!actor || !business || actor !== context?.actorId || business !== context?.businessId) fail('UNAUTHENTICATED', 'La sesión no es válida.', 401);
  if (actor !== business || context?.role !== 'owner' || enabled !== true) fail('COMMERCE_FORBIDDEN', 'No tenés acceso a FullMatch Studio.', 403);
  if (!['commerce:read', 'commerce:write', 'commerce:media', 'commerce:story', 'commerce:settings'].includes(permission)) fail('COMMERCE_FORBIDDEN', 'Permiso no disponible.', 403);
  return { actorId: actor, businessId: business, permission };
}
