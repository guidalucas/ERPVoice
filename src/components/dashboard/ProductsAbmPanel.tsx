import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useInventory } from '../../hooks/useInventory';
import { LOW_STOCK_THRESHOLD } from './dashboardTypes';

type ProductDraft = {
  name: string;
  productType: string;
  productModel: string;
  size: string;
  stockAvailable: string;
  stockReserved: string;
  price: string;
};

type ProductRow = {
  id: string;
  name: string;
  productType?: string | null;
  productModel?: string | null;
  size?: string | null;
  stockAvailable: number;
  stockReserved: number;
  price: number;
};

type ProductGroup = {
  key: string;
  displayName: string;
  productType?: string | null;
  productModel?: string | null;
  products: ProductRow[];
};

type InlineField = 'stockAvailable' | 'price';

const emptyDraft = (): ProductDraft => ({
  name: '',
  productType: '',
  productModel: '',
  size: '',
  stockAvailable: '0',
  stockReserved: '0',
  price: '0',
});

const toDraft = (product: ProductRow): ProductDraft => ({
  name: product.name ?? '',
  productType: product.productType ?? '',
  productModel: product.productModel ?? '',
  size: product.size ?? '',
  stockAvailable: String(product.stockAvailable ?? 0),
  stockReserved: String(product.stockReserved ?? 0),
  price: String(product.price ?? 0),
});

const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;

const normalizeSearch = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();

const buildProductName = (draft: ProductDraft) => {
  const explicitName = draft.name.trim();
  if (explicitName) {
    return explicitName;
  }

  const parts = [draft.productType.trim(), draft.productModel.trim(), draft.size.trim()].filter(Boolean);
  return parts.length ? parts.join(' ') : 'Nuevo Producto';
};

function IconButton({
  label,
  onClick,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-full border transition ${
        danger
          ? 'border-rose-500/20 bg-rose-500/10 text-rose-600 hover:bg-rose-500/20 hover:text-rose-700 dark:text-rose-300 dark:hover:text-rose-200'
          : 'border-[color:var(--border)] bg-[color:var(--overlay-soft)] text-slate-800 hover:bg-slate-900/5 hover:text-slate-900 dark:text-slate-200 dark:hover:bg-white/10 dark:hover:text-white'
      }`}
    >
      <span className="pointer-events-none">{children}</span>
    </button>
  );
}

function ConfirmDeleteModal({
  productName,
  onCancel,
  onConfirm,
  confirming,
}: {
  productName: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-slate-900 dark:text-slate-100 shadow-2xl shadow-black/70">
        <h4 className="text-xl font-bold text-slate-900 dark:text-slate-100">Eliminar producto</h4>
        <p className="mt-3 text-sm leading-6 text-slate-700 dark:text-slate-300">
          Vas a eliminar <span className="font-semibold text-slate-900 dark:text-white">{productName}</span>. Esta acción no se puede deshacer.
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onCancel} className="erp-button-secondary">
            Cancelar
          </button>
          <button type="button" onClick={onConfirm} disabled={confirming} className="erp-button-danger">
            {confirming ? 'Eliminando...' : 'Eliminar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProductFormModal({
  title,
  draft,
  onDraftChange,
  onClose,
  onSubmit,
  submitLabel,
  submitting,
}: {
  title: string;
  draft: ProductDraft;
  onDraftChange: (nextDraft: ProductDraft) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  submitLabel: string;
  submitting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-slate-900 dark:text-slate-100 shadow-2xl shadow-black/70">
        <div className="flex items-start justify-between gap-3">
          <h4 className="text-[1.55rem] font-bold leading-none text-slate-900 dark:text-slate-100">{title}</h4>
          <button type="button" aria-label="Cerrar modal" className="erp-button-secondary h-8 w-8 px-0" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block space-y-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">
            Tipo de Prenda
            <input className="erp-input h-11 rounded-xl text-[15px]" value={draft.productType} onChange={(event) => onDraftChange({ ...draft, productType: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">
            Modelo
            <input className="erp-input h-11 rounded-xl text-[15px]" value={draft.productModel} onChange={(event) => onDraftChange({ ...draft, productModel: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">
            Talle
            <input className="erp-input h-11 rounded-xl text-[15px]" value={draft.size} onChange={(event) => onDraftChange({ ...draft, size: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">
            Precio
            <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" value={draft.price} onChange={(event) => onDraftChange({ ...draft, price: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">
            Stock Disponible
            <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" value={draft.stockAvailable} onChange={(event) => onDraftChange({ ...draft, stockAvailable: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">
            Stock Reservado
            <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" value={draft.stockReserved} onChange={(event) => onDraftChange({ ...draft, stockReserved: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200 sm:col-span-2 lg:col-span-3">
            Nombre (opcional)
            <input className="erp-input h-11 rounded-xl text-[15px]" value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} />
          </label>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="erp-button-secondary">
            Cancelar
          </button>
          <button type="button" onClick={() => void onSubmit()} disabled={submitting} className="erp-button-primary">
            {submitting ? 'Guardando...' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function InlineNumber({
  value,
  editing,
  draftValue,
  onStart,
  onChange,
  onCommit,
  onCancel,
  formatDisplay,
}: {
  value: number;
  editing: boolean;
  draftValue: string;
  onStart: () => void;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  formatDisplay?: (value: number) => string;
}) {
  if (editing) {
    return (
      <input
        autoFocus
        className="stock-chip-input"
        value={draftValue}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => void onCommit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void onCommit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
    );
  }

  return (
    <button type="button" className="font-semibold text-emerald-700 dark:text-emerald-300 underline-offset-2 hover:underline" onClick={onStart}>
      {formatDisplay ? formatDisplay(value) : value}
    </button>
  );
}

export function ProductsAbmPanel({
  stockFilter = 'all',
  onStockFilterChange,
}: {
  stockFilter?: 'all' | 'low-stock';
  onStockFilterChange?: (filter: 'all' | 'low-stock') => void;
}) {
  const { products, createProductRecord, updateProductRecord, deleteProductRecord } = useInventory();
  const [draft, setDraft] = useState<ProductDraft>(() => emptyDraft());
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [pendingDeleteProduct, setPendingDeleteProduct] = useState<ProductRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [inlineEdit, setInlineEdit] = useState<{ productId: string; field: InlineField; value: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const onlyLowStock = stockFilter === 'low-stock';

  const editingProduct = useMemo(() => products.find((product) => product.id === editingProductId) ?? null, [products, editingProductId]);

  const stockSummary = useMemo(() => {
    const totalAvailable = products.reduce((total, product) => total + product.stockAvailable, 0);
    const totalReserved = products.reduce((total, product) => total + product.stockReserved, 0);
    const totalValue = products.reduce((total, product) => total + (product.stockAvailable + product.stockReserved) * product.price, 0);

    return { totalAvailable, totalReserved, totalValue };
  }, [products]);

  const groupedProducts = useMemo(() => {
    const groups: Record<string, ProductGroup> = {};

    for (const product of products) {
      const key = `${product.productType ?? ''}||${product.productModel ?? ''}`.trim() || product.name;
      const displayName =
        product.productType || product.productModel
          ? [product.productType, product.productModel].filter(Boolean).join(' ')
          : product.name;

      groups[key] = groups[key] ?? {
        key,
        displayName,
        productType: product.productType,
        productModel: product.productModel,
        products: [],
      };

      groups[key]!.products.push(product);
    }

    return Object.values(groups).map((group) => ({
      ...group,
      products: group.products.sort((a, b) =>
        String(a.size ?? '').localeCompare(String(b.size ?? ''), undefined, { numeric: true, sensitivity: 'base' }),
      ),
    }));
  }, [products]);

  const filteredGroups = useMemo(() => {
    const normalizedQuery = normalizeSearch(searchQuery);
    const bySearch = !normalizedQuery
      ? groupedProducts
      : groupedProducts.filter((group) => {
          const haystack = normalizeSearch(
            [group.displayName, group.productType, group.productModel, ...group.products.map((product) => product.name)]
              .filter(Boolean)
              .join(' '),
          );
          return haystack.includes(normalizedQuery);
        });

    if (!onlyLowStock) {
      return bySearch;
    }

    return bySearch
      .map((group) => ({
        ...group,
        products: group.products.filter((product) => product.stockAvailable <= LOW_STOCK_THRESHOLD),
      }))
      .filter((group) => group.products.length > 0);
  }, [groupedProducts, searchQuery, onlyLowStock]);

  const lowStockGroupKeys = useMemo(
    () => (onlyLowStock ? filteredGroups.map((group) => group.key).join('\0') : ''),
    [onlyLowStock, filteredGroups],
  );

  useEffect(() => {
    if (!onlyLowStock || !lowStockGroupKeys) {
      return;
    }

    const keys = lowStockGroupKeys.split('\0').filter(Boolean);
    setExpandedGroups((current) => {
      const next = { ...current };
      let changed = false;
      for (const key of keys) {
        if (!next[key]) {
          next[key] = true;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [onlyLowStock, lowStockGroupKeys]);

  const isEditing = Boolean(editingProductId);

  useEffect(() => {
    if (!isFormOpen) {
      setEditingProductId(null);
      setDraft(emptyDraft());
      setSaving(false);
    }
  }, [isFormOpen]);

  useEffect(() => {
    if (editingProduct) {
      setDraft(toDraft(editingProduct));
      return;
    }

    if (!isEditing) {
      setDraft(emptyDraft());
    }
  }, [editingProduct, isEditing]);

  const openCreateForm = () => {
    setEditingProductId(null);
    setDraft(emptyDraft());
    setIsFormOpen(true);
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const payload = {
        name: editingProductId && !draft.name.trim() ? editingProduct?.name ?? buildProductName(draft) : buildProductName(draft),
        productType: draft.productType.trim() || undefined,
        productModel: draft.productModel.trim() || undefined,
        size: draft.size.trim() || undefined,
        stockAvailable: Number(draft.stockAvailable || 0),
        stockReserved: Number(draft.stockReserved || 0),
        price: Number(draft.price || 0),
      };

      if (editingProductId) {
        await updateProductRecord(editingProductId, payload);
      } else {
        await createProductRecord(payload as ProductRow & { name: string });
      }

      setIsFormOpen(false);
      setEditingProductId(null);
      setDraft(emptyDraft());
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDeleteProduct) {
      return;
    }

    setDeleting(true);
    try {
      await deleteProductRecord(pendingDeleteProduct.id);
      setPendingDeleteProduct(null);
    } finally {
      setDeleting(false);
    }
  };

  const commitInlineEdit = async () => {
    if (!inlineEdit) {
      return;
    }

    const product = products.find((entry) => entry.id === inlineEdit.productId);
    if (!product) {
      setInlineEdit(null);
      return;
    }

    const nextValue = Number(inlineEdit.value);
    if (!Number.isFinite(nextValue) || nextValue < 0) {
      setInlineEdit(null);
      return;
    }

    const currentValue = inlineEdit.field === 'price' ? product.price : product.stockAvailable;
    if (currentValue === nextValue) {
      setInlineEdit(null);
      return;
    }

    await updateProductRecord(product.id, { [inlineEdit.field]: nextValue });
    setInlineEdit(null);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <article className="min-h-[144px] rounded-[1.35rem] border border-sky-500/10 bg-[color:var(--overlay-soft)] p-5 shadow-lg shadow-sky-950/20">
          <p className="text-[15px] font-medium text-slate-600 dark:text-slate-400">Stock Disponible</p>
          <div className="mt-10">
            <p className="font-display text-[2rem] font-bold tracking-tight text-sky-600 dark:text-sky-400">{stockSummary.totalAvailable}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">unidades listas para venta</p>
          </div>
        </article>

        <article className="min-h-[144px] rounded-[1.35rem] border border-sky-500/10 bg-[color:var(--overlay-soft)] p-5 shadow-lg shadow-sky-950/20">
          <p className="text-[15px] font-medium text-slate-600 dark:text-slate-400">Stock Reservado</p>
          <div className="mt-10">
            <p className="font-display text-[2rem] font-bold tracking-tight text-cyan-600 dark:text-cyan-400">{stockSummary.totalReserved}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">unidades apartadas</p>
          </div>
        </article>

        <article className="min-h-[144px] rounded-[1.35rem] border border-sky-500/10 bg-[color:var(--overlay-soft)] p-5 shadow-lg shadow-sky-950/20">
          <p className="text-[15px] font-medium text-slate-600 dark:text-slate-400">Valor Total</p>
          <div className="mt-10">
            <p className="font-display text-[2rem] font-bold tracking-tight text-slate-900 dark:text-slate-100">{formatCurrency(stockSummary.totalValue)}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">inventario valorizado</p>
          </div>
        </article>
      </div>

      <article className="erp-panel">
        <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border)] pb-4">
          <div>
            <h3 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">Productos</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Agrupados por modelo. Click en stock o precio para editar inline.</p>
          </div>
          <button type="button" onClick={openCreateForm} className="erp-button-primary inline-flex min-h-11 items-center gap-2">
            <span aria-hidden>+</span>
            Nuevo Producto
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-[12rem] flex-1 space-y-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300">
            Buscar modelo
            <input
              className="erp-input min-h-11"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Ej: river, argentina, boca…"
              autoComplete="off"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`rounded-full px-3 py-2 text-xs font-semibold transition ${
                !onlyLowStock ? 'bg-emerald-500 text-slate-950' : 'text-slate-600 dark:text-slate-300'
              }`}
              style={onlyLowStock ? { background: 'var(--overlay-soft)' } : undefined}
              onClick={() => onStockFilterChange?.('all')}
            >
              Todos
            </button>
            <button
              type="button"
              className={`rounded-full px-3 py-2 text-xs font-semibold transition ${
                onlyLowStock ? 'bg-amber-400 text-slate-950' : 'text-slate-600 dark:text-slate-300'
              }`}
              style={!onlyLowStock ? { background: 'var(--overlay-soft)' } : undefined}
              onClick={() => onStockFilterChange?.('low-stock')}
            >
              Stock bajo
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {filteredGroups.map((group) => {
            const totalAvailable = group.products.reduce((sum, product) => sum + product.stockAvailable, 0);
            const samePrice = group.products.every((product) => product.price === group.products[0]?.price);
            const isExpanded = Boolean(expandedGroups[group.key]);
            const sizeCount = group.products.length;

            return (
              <div key={group.key} className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--overlay-soft)]">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left"
                  onClick={() => setExpandedGroups((current) => ({ ...current, [group.key]: !current[group.key] }))}
                >
                  <div>
                    <p className="font-display text-lg font-bold text-slate-900 dark:text-white">{group.displayName}</p>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                      {sizeCount} talle{sizeCount === 1 ? '' : 's'} — {totalAvailable} disponible{totalAvailable === 1 ? '' : 's'}
                      {samePrice && group.products[0] ? ` · ${formatCurrency(group.products[0].price)}` : ''}
                      {group.products.some((product) => product.stockAvailable <= LOW_STOCK_THRESHOLD) ? ' · stock bajo' : ''}
                    </p>
                  </div>
                  <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">{isExpanded ? 'Ocultar talles' : 'Ver talles'}</span>
                </button>

                {isExpanded && (
                  <div className="space-y-3 border-t border-[color:var(--border)] px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {group.products.map((product) => {
                        const isEditingStock = inlineEdit?.productId === product.id && inlineEdit.field === 'stockAvailable';
                        const isEditingPrice = inlineEdit?.productId === product.id && inlineEdit.field === 'price';
                        const low = product.stockAvailable <= LOW_STOCK_THRESHOLD;

                        return (
                          <div
                            key={product.id}
                            className={`stock-chip ${low ? 'border-amber-400/30 bg-amber-400/10' : ''}`}
                          >
                            <span className="font-semibold text-slate-800 dark:text-slate-200">{product.size ?? '-'}:</span>
                            <InlineNumber
                              value={product.stockAvailable}
                              editing={Boolean(isEditingStock)}
                              draftValue={inlineEdit?.value ?? ''}
                              onStart={() => setInlineEdit({ productId: product.id, field: 'stockAvailable', value: String(product.stockAvailable) })}
                              onChange={(value) => setInlineEdit({ productId: product.id, field: 'stockAvailable', value })}
                              onCommit={() => void commitInlineEdit()}
                              onCancel={() => setInlineEdit(null)}
                            />
                            <span className="text-slate-600">·</span>
                            <InlineNumber
                              value={product.price}
                              editing={Boolean(isEditingPrice)}
                              draftValue={inlineEdit?.value ?? ''}
                              onStart={() => setInlineEdit({ productId: product.id, field: 'price', value: String(product.price) })}
                              onChange={(value) => setInlineEdit({ productId: product.id, field: 'price', value })}
                              onCommit={() => void commitInlineEdit()}
                              onCancel={() => setInlineEdit(null)}
                              formatDisplay={formatCurrency}
                            />
                            <IconButton label={`Eliminar ${product.name}`} danger onClick={() => setPendingDeleteProduct(product)}>
                              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.9]">
                                <path d="M4 7h16" />
                                <path d="M9 7V5h6v2" />
                                <path d="M6 7l1 13h10l1-13" />
                              </svg>
                            </IconButton>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {products.length === 0 && <div className="px-1 py-6 text-sm text-slate-600 dark:text-slate-400">No hay productos cargados todavía.</div>}
          {products.length > 0 && filteredGroups.length === 0 && (
            <div className="rounded-2xl border border-dashed border-[color:var(--border)] bg-[color:var(--overlay-soft)] px-4 py-8 text-center text-sm text-slate-600 dark:text-slate-400">
              {onlyLowStock
                ? 'No hay productos con stock bajo o agotado.'
                : `No se encontraron productos para '${searchQuery.trim()}'`}
            </div>
          )}
        </div>

        {isFormOpen && (
          <ProductFormModal
            title={isEditing ? 'Editar Producto' : 'Nuevo Producto'}
            draft={draft}
            onDraftChange={setDraft}
            onClose={() => setIsFormOpen(false)}
            onSubmit={handleSubmit}
            submitLabel={isEditing ? 'Guardar' : 'Crear'}
            submitting={saving}
          />
        )}

        {pendingDeleteProduct && (
          <ConfirmDeleteModal
            productName={pendingDeleteProduct.name}
            onCancel={() => setPendingDeleteProduct(null)}
            onConfirm={() => void confirmDelete()}
            confirming={deleting}
          />
        )}
      </article>
    </div>
  );
}
