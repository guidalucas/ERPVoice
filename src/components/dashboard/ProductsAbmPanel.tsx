import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { BusinessCategoryPreset } from '../../domain/businessCategories';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';
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
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full border transition ${
        danger
          ? 'border-rose-500/20 bg-rose-500/10 text-rose-600 hover:bg-rose-500/20 hover:text-rose-700 dark:text-rose-300 dark:hover:text-rose-200'
          : 'border-[color:var(--border)] bg-[color:var(--overlay-soft)] text-[color:var(--text)] hover:bg-slate-900/5 hover:text-[color:var(--text)] dark:hover:bg-white/10'
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
      <div className="w-full max-w-md rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-[color:var(--text)] shadow-2xl shadow-black/70">
        <h4 className="type-title text-xl text-[color:var(--text)]">Eliminar producto</h4>
        <p className="mt-3 text-sm leading-6 text-[color:var(--muted)]">
          Vas a eliminar <span className="type-subtitle text-[color:var(--text)]">{productName}</span>. Esta acción no se puede deshacer.
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
  preset,
}: {
  title: string;
  draft: ProductDraft;
  onDraftChange: (nextDraft: ProductDraft) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  submitLabel: string;
  submitting: boolean;
  preset: BusinessCategoryPreset;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-[color:var(--text)] shadow-2xl shadow-black/70">
        <div className="flex items-start justify-between gap-3">
          <h4 className="type-title text-[1.55rem] leading-none text-[color:var(--text)]">{title}</h4>
          <button type="button" aria-label="Cerrar modal" className="erp-button-secondary h-8 w-8 px-0" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
            {preset.productTypeLabel}
            <input className="erp-input h-11 rounded-xl text-[15px]" value={draft.productType} onChange={(event) => onDraftChange({ ...draft, productType: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
            {preset.productModelLabel}
            <input className="erp-input h-11 rounded-xl text-[15px]" value={draft.productModel} onChange={(event) => onDraftChange({ ...draft, productModel: event.target.value })} />
          </label>
          {preset.useVariants && preset.variantLabel && (
            <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
              {preset.variantLabel}
              <input className="erp-input h-11 rounded-xl text-[15px]" value={draft.size} onChange={(event) => onDraftChange({ ...draft, size: event.target.value })} />
            </label>
          )}
          <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
            Precio
            <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" value={draft.price} onChange={(event) => onDraftChange({ ...draft, price: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
            Stock Disponible
            <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" value={draft.stockAvailable} onChange={(event) => onDraftChange({ ...draft, stockAvailable: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
            Stock Reservado
            <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" value={draft.stockReserved} onChange={(event) => onDraftChange({ ...draft, stockReserved: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)] sm:col-span-2 lg:col-span-3">
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

export function ProductsAbmPanel({
  stockFilter = 'all',
  onStockFilterChange,
}: {
  stockFilter?: 'all' | 'low-stock';
  onStockFilterChange?: (filter: 'all' | 'low-stock') => void;
}) {
  const { products, createProductRecord, updateProductRecord, deleteProductRecord } = useInventory();
  const preset = useBusinessCategoryPreset();
  const variantLabelPlural = preset.variantLabel
    ? preset.variantLabel.toLowerCase() === 'número'
      ? 'números'
      : `${preset.variantLabel.toLowerCase()}s`
    : 'variantes';
  const [draft, setDraft] = useState<ProductDraft>(() => emptyDraft());
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [pendingDeleteProduct, setPendingDeleteProduct] = useState<ProductRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
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
      const typePart = product.productType?.trim() ?? '';
      const modelPart = product.productModel?.trim() ?? '';
      const key = typePart || modelPart ? `${typePart}||${modelPart}` : product.name;
      const displayName =
        typePart || modelPart
          ? [typePart, modelPart].filter(Boolean).join(' ')
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

  const flatProducts = useMemo(() => {
    const normalizedQuery = normalizeSearch(searchQuery);
    const bySearch = !normalizedQuery
      ? products
      : products.filter((product) => {
          const haystack = normalizeSearch(
            [product.name, product.productType, product.productModel, product.size].filter(Boolean).join(' '),
          );
          return haystack.includes(normalizedQuery);
        });

    if (!onlyLowStock) {
      return bySearch;
    }

    return bySearch.filter((product) => product.stockAvailable <= LOW_STOCK_THRESHOLD);
  }, [products, searchQuery, onlyLowStock]);

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

  const openEditForm = (product: ProductRow) => {
    setEditingProductId(product.id);
    setDraft(toDraft(product));
    setIsFormOpen(true);
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const payload = {
        name: editingProductId && !draft.name.trim() ? editingProduct?.name ?? buildProductName(draft) : buildProductName(draft),
        productType: draft.productType.trim() || undefined,
        productModel: draft.productModel.trim() || undefined,
        size: preset.useVariants ? draft.size.trim() || undefined : undefined,
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

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-12">
        <article className="kpi-card kpi-card-hero sm:col-span-2 xl:col-span-6">
          <p className="text-sm type-subtitle text-[color:var(--muted)]">Valor total</p>
          <p className="mt-6 type-metric-strong text-[2.15rem] leading-none erp-brand-gradient-text">
            {formatCurrency(stockSummary.totalValue)}
          </p>
          <p className="mt-2 text-sm text-[color:var(--muted)]">Inventario valorizado</p>
        </article>
        <article className="kpi-card xl:col-span-3">
          <p className="text-sm type-subtitle text-[color:var(--muted)]">Disponible</p>
          <p className="mt-6 type-metric-strong text-[2rem] leading-none text-[color:var(--text)]">{stockSummary.totalAvailable}</p>
          <p className="mt-2 text-sm text-[color:var(--muted)]">Listas para venta</p>
        </article>
        <article className="kpi-card xl:col-span-3">
          <p className="text-sm type-subtitle text-[color:var(--muted)]">Reservado</p>
          <p className="mt-6 type-metric-strong text-[2rem] leading-none text-[color:var(--text)]">{stockSummary.totalReserved}</p>
          <p className="mt-2 text-sm text-[color:var(--muted)]">Unidades apartadas</p>
        </article>
      </div>

      <article className="erp-panel">
        <div className="flex flex-col gap-3 border-b border-[color:var(--border)] pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="type-title text-xl text-[color:var(--text)]">Inventario</h3>
            <p className="mt-1 text-sm text-[color:var(--muted)]">
              {preset.useVariants
                ? `Agrupados por modelo. Usá el lápiz para editar stock, precio y datos del producto.`
                : 'Lista plana por producto. Usá el lápiz para editar stock, precio y datos del producto.'}
            </p>
          </div>
          <button type="button" onClick={openCreateForm} className="erp-button-primary inline-flex items-center gap-2 self-start">
            Nuevo producto
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end">
          <label className="min-w-0 flex-1 space-y-1.5 text-sm type-subtitle text-[color:var(--muted)]">
            Buscar
            <input
              className="erp-input"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={`Nombre, ${preset.productModelLabel.toLowerCase()} o ${preset.productTypeLabel.toLowerCase()}…`}
              autoComplete="off"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="activity-filter-chip"
              aria-pressed={!onlyLowStock}
              onClick={() => onStockFilterChange?.('all')}
            >
              Todos
            </button>
            <button
              type="button"
              className={`activity-filter-chip ${onlyLowStock ? '!bg-none !text-[#0b0b10]' : ''}`}
              aria-pressed={onlyLowStock}
              style={onlyLowStock ? { background: 'var(--warning)', borderColor: 'transparent', color: '#0b0b10' } : undefined}
              onClick={() => onStockFilterChange?.('low-stock')}
            >
              Stock bajo
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {preset.useVariants
            ? filteredGroups.map((group) => {
                const totalAvailable = group.products.reduce((sum, product) => sum + product.stockAvailable, 0);
                const totalReserved = group.products.reduce((sum, product) => sum + product.stockReserved, 0);
                const samePrice = group.products.every((product) => product.price === group.products[0]?.price);
                const isExpanded = Boolean(expandedGroups[group.key]);
                const sizeCount = group.products.length;

                return (
                  <div
                    key={group.key}
                    className={`inventory-row ${
                      group.products.some((product) => product.stockAvailable <= LOW_STOCK_THRESHOLD) ? 'inventory-row-low' : ''
                    }`}
                  >
                    <button
                      type="button"
                      className="flex w-full flex-col gap-3 text-left sm:flex-row sm:items-center sm:justify-between"
                      onClick={() => setExpandedGroups((current) => ({ ...current, [group.key]: !current[group.key] }))}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="type-title text-lg text-[color:var(--text)]">{group.displayName}</p>
                          {group.products.some((product) => product.stockAvailable <= LOW_STOCK_THRESHOLD) && (
                            <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-[#0b0b10]" style={{ background: 'var(--warning)' }}>
                              Stock bajo
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-[color:var(--muted)]">
                          {sizeCount} {sizeCount === 1 ? (preset.variantLabel?.toLowerCase() ?? 'variante') : variantLabelPlural}
                          {' · '}
                          {totalAvailable} disponible{totalAvailable === 1 ? '' : 's'}
                          {totalReserved > 0 ? ` · ${totalReserved} reservada${totalReserved === 1 ? '' : 's'}` : ''}
                          {samePrice && group.products[0] ? ` · ${formatCurrency(group.products[0].price)}` : ''}
                        </p>
                      </div>
                      <span className="erp-toggle-link text-xs">
                        {isExpanded ? `Ocultar ${variantLabelPlural}` : `Ver ${variantLabelPlural}`}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="space-y-3 border-t border-[color:var(--border)] pt-3">
                        <div className="flex flex-wrap gap-2">
                          {group.products.map((product) => {
                            const low = product.stockAvailable <= LOW_STOCK_THRESHOLD;

                            return (
                              <div
                                key={product.id}
                                className={`stock-chip ${low ? 'border-amber-400/30 bg-amber-400/10' : ''}`}
                              >
                                <span className="type-subtitle text-[color:var(--text)]">{product.size ?? '-'}:</span>
                                <span className="type-subtitle font-semibold text-emerald-700 dark:text-emerald-300">{product.stockAvailable}</span>
                                {product.stockReserved > 0 && (
                                  <>
                                    <span className="text-[color:var(--muted)]">·</span>
                                    <span className="text-xs font-medium text-cyan-700 dark:text-cyan-300" title="Stock reservado">
                                      R:{product.stockReserved}
                                    </span>
                                  </>
                                )}
                                <span className="text-[color:var(--muted)]">·</span>
                                <span className="type-subtitle font-semibold text-emerald-700 dark:text-emerald-300">{formatCurrency(product.price)}</span>
                                <IconButton label={`Editar ${product.name}`} onClick={() => openEditForm(product)}>
                                  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.9]">
                                    <path d="M4 20h4l10.5-10.5a1.5 1.5 0 0 0-2.1-2.1L5.9 17.9 4 20z" />
                                    <path d="M13.5 6.5l4 4" />
                                  </svg>
                                </IconButton>
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
              })
            : flatProducts.map((product) => {
                const low = product.stockAvailable <= LOW_STOCK_THRESHOLD;
                const meta = [product.productType, product.productModel].filter(Boolean).join(' · ');

                return (
                  <div key={product.id} className={`inventory-row ${low ? 'inventory-row-low' : ''}`}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="type-title text-lg text-[color:var(--text)]">{product.name}</p>
                          {low && (
                            <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-[#0b0b10]" style={{ background: 'var(--warning)' }}>
                              Stock bajo
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-[color:var(--muted)]">
                          {meta || 'Sin categoría'}
                          {product.stockReserved > 0 ? ` · ${product.stockReserved} reservada${product.stockReserved === 1 ? '' : 's'}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="stock-chip">
                          <span className="type-subtitle text-[color:var(--text)]">Stock:</span>
                          <span className="type-subtitle font-semibold text-emerald-700 dark:text-emerald-300">{product.stockAvailable}</span>
                          {product.stockReserved > 0 && (
                            <>
                              <span className="text-[color:var(--muted)]">·</span>
                              <span className="text-xs font-medium text-cyan-700 dark:text-cyan-300" title="Stock reservado">
                                R:{product.stockReserved}
                              </span>
                            </>
                          )}
                          <span className="text-[color:var(--muted)]">·</span>
                          <span className="type-subtitle font-semibold text-emerald-700 dark:text-emerald-300">{formatCurrency(product.price)}</span>
                        </div>
                        <IconButton label={`Editar ${product.name}`} onClick={() => openEditForm(product)}>
                          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.9]">
                            <path d="M4 20h4l10.5-10.5a1.5 1.5 0 0 0-2.1-2.1L5.9 17.9 4 20z" />
                            <path d="M13.5 6.5l4 4" />
                          </svg>
                        </IconButton>
                        <IconButton label={`Eliminar ${product.name}`} danger onClick={() => setPendingDeleteProduct(product)}>
                          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.9]">
                            <path d="M4 7h16" />
                            <path d="M9 7V5h6v2" />
                            <path d="M6 7l1 13h10l1-13" />
                          </svg>
                        </IconButton>
                      </div>
                    </div>
                  </div>
                );
              })}

          {products.length === 0 && <div className="px-1 py-6 text-sm text-[color:var(--muted)]">No hay productos cargados todavía.</div>}
          {products.length > 0 && (preset.useVariants ? filteredGroups.length === 0 : flatProducts.length === 0) && (
            <div className="rounded-2xl border border-dashed border-[color:var(--border)] bg-[color:var(--overlay-soft)] px-4 py-8 text-center text-sm text-[color:var(--muted)]">
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
            preset={preset}
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
