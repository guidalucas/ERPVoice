const ANONYMOUS_CLIENT = 'sin cliente';

const normalizeText = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const includesNormalized = (candidate, query) => {
  const candidateNorm = normalizeText(candidate).replace(/\s+/g, ' ').trim();
  const queryNorm = normalizeText(query).replace(/\s+/g, ' ').trim();
  if (!candidateNorm || !queryNorm) {
    return false;
  }
  return candidateNorm.includes(queryNorm) || queryNorm.includes(candidateNorm);
};

const resolveEstado = (action) => {
  if (action?.estado === 'todos') {
    return null;
  }
  if (action?.estado === 'conseguido' || action?.estado === 'descartado' || action?.estado === 'pendiente') {
    return action.estado;
  }
  return 'pendiente';
};

const estadoLabel = (estado, count) => {
  const plural = count !== 1;
  if (estado === 'conseguido') {
    return plural ? 'conseguidos' : 'conseguido';
  }
  if (estado === 'descartado') {
    return plural ? 'descartados' : 'descartado';
  }
  if (estado === 'pendiente') {
    return plural ? 'pendientes' : 'pendiente';
  }
  return '';
};

const resolveClientName = (pedido, clientsById) => clientsById[pedido.clienteId]?.name?.trim() || 'Sin cliente';

const resolveProveedorName = (pedido, proveedoresById) =>
  (pedido.proveedorId ? proveedoresById[pedido.proveedorId]?.name?.trim() : '') || '';

export const answerPedidosQuery = (pedidos, clients, proveedores, action = {}, options = {}) => {
  const estado = resolveEstado(action);
  const clientsById = Object.fromEntries((clients ?? []).map((client) => [client.id, client]));
  const proveedoresById = Object.fromEntries((proveedores ?? []).map((proveedor) => [proveedor.id, proveedor]));

  let matches = Array.isArray(pedidos) ? [...pedidos] : [];
  if (estado) {
    matches = matches.filter((pedido) => pedido.estado === estado);
  }

  if (action.clientName?.trim()) {
    const query = action.clientName.trim();
    matches = matches.filter((pedido) => includesNormalized(resolveClientName(pedido, clientsById), query));
  }

  if (action.proveedorName?.trim()) {
    const query = action.proveedorName.trim();
    matches = matches.filter((pedido) => includesNormalized(resolveProveedorName(pedido, proveedoresById), query));
  }

  if (action.productName?.trim()) {
    const query = action.productName.trim();
    matches = matches.filter((pedido) => includesNormalized(pedido.producto, query));
  }

  const scope = action.clientName?.trim()
    ? ` de ${action.clientName.trim()}`
    : action.proveedorName?.trim()
      ? ` del proveedor ${action.proveedorName.trim()}`
      : action.productName?.trim()
        ? ` de ${action.productName.trim()}`
        : '';

  if (!matches.length) {
    const emptyLabel = estadoLabel(estado, 2);
    if (emptyLabel) {
      return `No tenés pedidos ${emptyLabel}${scope}.`;
    }
    return `No tenés pedidos registrados${scope}.`;
  }

  matches.sort((left, right) => String(right.fechaPedido ?? '').localeCompare(String(left.fechaPedido ?? '')));

  const variantWord =
    typeof options.variantLabel === 'string' && options.variantLabel.trim()
      ? options.variantLabel.trim().toLowerCase()
      : 'variante';

  const groups = new Map();
  for (const pedido of matches) {
    const clientName = resolveClientName(pedido, clientsById);
    const proveedorName = resolveProveedorName(pedido, proveedoresById);
    const title =
      normalizeText(clientName) === ANONYMOUS_CLIENT
        ? proveedorName
          ? `Proveedor ${proveedorName}`
          : 'Sin cliente'
        : clientName;
    const key = normalizeText(title);
    const current = groups.get(key) ?? { title, items: [] };
    current.items.push(pedido);
    groups.set(key, current);
  }

  const lines = [...groups.values()].map((group) => {
    const items = group.items.map((pedido) => {
      const qty = Number(pedido.qty ?? 1);
      const size = pedido.talle?.trim() ? ` ${variantWord} ${pedido.talle.trim()}` : '';
      const proveedorName = resolveProveedorName(pedido, proveedoresById);
      const clientName = resolveClientName(pedido, clientsById);
      const showProveedor = Boolean(proveedorName) && normalizeText(clientName) !== ANONYMOUS_CLIENT;
      const estadoSuffix = !estado && pedido.estado !== 'pendiente' ? ` (${pedido.estado})` : '';
      return `• ${qty} ${pedido.producto}${size}${showProveedor ? ` · proveedor ${proveedorName}` : ''}${estadoSuffix}`;
    });
    return `${group.title}:\n${items.join('\n')}`;
  });

  const count = matches.length;
  const totalQty = matches.reduce((sum, pedido) => sum + Number(pedido.qty ?? 1), 0);
  const label = estadoLabel(estado, count);
  const header = label
    ? `Tenés ${count} pedido${count === 1 ? '' : 's'} ${label}${scope} (${totalQty} unidad${totalQty === 1 ? '' : 'es'}):`
    : `Tenés ${count} pedido${count === 1 ? '' : 's'}${scope} (${totalQty} unidad${totalQty === 1 ? '' : 'es'}):`;

  return `${header}\n\n${lines.join('\n\n')}`;
};
