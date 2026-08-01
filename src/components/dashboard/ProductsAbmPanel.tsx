import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useInventory } from '../../hooks/useInventory';

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

const buildProductName = (draft: ProductDraft) => {
  const explicitName = draft.name.trim();

  if (explicitName) {
    return explicitName;
  }

  const parts = [draft.productType.trim(), draft.productModel.trim(), draft.size.trim()].filter(Boolean);

  if (parts.length) {
    return parts.join(' ');
  }

  return 'Nuevo Producto';
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
          ? 'border-rose-500/20 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200'
          : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white'
      }`}
    >
      {children}
    </button>
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
      <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-[#070707] p-6 text-slate-100 shadow-2xl shadow-black/70">
        <div className="flex items-start justify-between gap-3">
          <h4 className="text-[1.55rem] font-bold leading-none text-slate-100">{title}</h4>
          <button
            type="button"
            aria-label="Cerrar modal"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 text-slate-400 transition hover:bg-white/5 hover:text-white"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[2.1]">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block space-y-1.5 text-sm font-semibold text-slate-200">
            Tipo de Prenda
            <input
              className="erp-input h-11 rounded-xl text-[15px] placeholder:text-slate-500"
              value={draft.productType}
              onChange={(event) => onDraftChange({ ...draft, productType: event.target.value })}
              placeholder="Ej: Remera, Pantalón, Campera"
            />
          </label>

          <label className="block space-y-1.5 text-sm font-semibold text-slate-200">
            Modelo
            <input
              className="erp-input h-11 rounded-xl text-[15px] placeholder:text-slate-500"
              value={draft.productModel}
              onChange={(event) => onDraftChange({ ...draft, productModel: event.target.value })}
              placeholder="Ej: Básica, Cargo, Oversize"
            />
          </label>

          <div className="grid grid-cols-2 gap-3 sm:col-span-2 lg:col-span-2">
            <label className="block space-y-1.5 text-sm font-semibold text-slate-200">
              Talle
              <input
                className="erp-input h-11 rounded-xl text-[15px] placeholder:text-slate-500"
                value={draft.size}
                onChange={(event) => onDraftChange({ ...draft, size: event.target.value })}
                placeholder="S, M, L, XL..."
              />
            </label>

            <label className="block space-y-1.5 text-sm font-semibold text-slate-200">
              Precio
              <input
                className="erp-input h-11 rounded-xl text-[15px] placeholder:text-slate-500"
                type="number"
                min="0"
                value={draft.price}
                onChange={(event) => onDraftChange({ ...draft, price: event.target.value })}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:col-span-2 lg:col-span-2">
            <label className="block space-y-1.5 text-sm font-semibold text-slate-200">
              Stock Disponible
              <input
                className="erp-input h-11 rounded-xl text-[15px] placeholder:text-slate-500"
                type="number"
                min="0"
                value={draft.stockAvailable}
                onChange={(event) => onDraftChange({ ...draft, stockAvailable: event.target.value })}
              />
            </label>

            <label className="block space-y-1.5 text-sm font-semibold text-slate-200">
              Stock Reservado
              <input
                className="erp-input h-11 rounded-xl text-[15px] placeholder:text-slate-500"
                type="number"
                min="0"
                value={draft.stockReserved}
                onChange={(event) => onDraftChange({ ...draft, stockReserved: event.target.value })}
              />
            </label>
          </div>

          <label className="block space-y-1.5 text-sm font-semibold text-slate-200 sm:col-span-2 lg:col-span-3">
            Nombre (opcional)
            <input
              className="erp-input h-11 rounded-xl text-[15px] placeholder:text-slate-500"
              value={draft.name}
              onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
              placeholder="Se genera automáticamente si está vacío"
            />
          </label>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 font-semibold text-slate-200 transition hover:bg-white/10"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[2]">
              <path d="M19 12H5" />
              <path d="m11 18-6-6 6-6" />
            </svg>
            Cancelar
          </button>

          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[2.2]">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            {submitting ? 'Guardando...' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProductsAbmPanel() {
  const { products, createProductRecord, updateProductRecord, deleteProductRecord } = useInventory();
  const [draft, setDraft] = useState<ProductDraft>(() => emptyDraft());
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const editingProduct = useMemo(() => products.find((product) => product.id === editingProductId) ?? null, [products, editingProductId]);
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

  const openEditForm = (productId: string) => {
    const product = products.find((item) => item.id === productId);
    if (!product) {
      return;
    }

    setEditingProductId(productId);
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
        size: draft.size.trim() || undefined,
        stockAvailable: Number(draft.stockAvailable || 0),
        stockReserved: Number(draft.stockReserved || 0),
        price: Number(draft.price || 0),
      };

      if (editingProductId) {
        await updateProductRecord(editingProductId, payload);
      } else {
        await createProductRecord(payload as any);
      }

      setIsFormOpen(false);
      setEditingProductId(null);
      setDraft(emptyDraft());
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (productId: string) => {
    const product = products.find((item) => item.id === productId);
    if (!product || !window.confirm(`Eliminar ${product.name}?`)) {
      return;
    }

    await deleteProductRecord(productId);
  };

  return (
    <article className="erp-panel">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
        <h3 className="font-display text-xl font-bold text-slate-100">ABM Productos</h3>
        <button
          type="button"
          onClick={openCreateForm}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[2]">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          Nuevo Producto
        </button>
      </div>

      <div className="overflow-x-auto pt-4">
        <table className="min-w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-sm font-semibold text-slate-300">
              <th className="border-b border-white/10 px-3 py-4">Nombre</th>
              <th className="border-b border-white/10 px-3 py-4">Tipo</th>
              <th className="border-b border-white/10 px-3 py-4">Modelo</th>
              <th className="border-b border-white/10 px-3 py-4">Talle</th>
              <th className="border-b border-white/10 px-3 py-4 text-center">Disponible</th>
              <th className="border-b border-white/10 px-3 py-4 text-center">Reservado</th>
              <th className="border-b border-white/10 px-3 py-4 text-center">Precio</th>
              <th className="border-b border-white/10 px-3 py-4 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id} className="text-[15px] text-slate-100">
                <td className="border-b border-white/10 px-3 py-4 font-semibold">{product.name}</td>
                <td className="border-b border-white/10 px-3 py-4 text-slate-200">{product.productType ?? '-'}</td>
                <td className="border-b border-white/10 px-3 py-4 text-slate-200">{product.productModel ?? '-'}</td>
                <td className="border-b border-white/10 px-3 py-4 text-slate-200">{product.size ?? '-'}</td>
                <td className="border-b border-white/10 px-3 py-4 text-center font-semibold">{product.stockAvailable}</td>
                <td className="border-b border-white/10 px-3 py-4 text-center font-semibold">{product.stockReserved}</td>
                <td className="border-b border-white/10 px-3 py-4 text-center font-mono font-semibold">{formatCurrency(product.price)}</td>
                <td className="border-b border-white/10 px-3 py-4">
                  <div className="flex justify-end gap-3">
                    <IconButton label={`Editar ${product.name}`} onClick={() => openEditForm(product.id)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[1.9]">
                        <path d="M4 20h4l10.5-10.5a1.7 1.7 0 0 0 0-2.4l-1.6-1.6a1.7 1.7 0 0 0-2.4 0L4 16v4Z" />
                        <path d="m13.5 6.5 4 4" />
                      </svg>
                    </IconButton>
                    <IconButton label={`Eliminar ${product.name}`} danger onClick={() => void handleDelete(product.id)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[1.9]">
                        <path d="M4 7h16" />
                        <path d="M9 7V5h6v2" />
                        <path d="M6 7l1 13h10l1-13" />
                        <path d="M10 11v5" />
                        <path d="M14 11v5" />
                      </svg>
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {products.length === 0 && (
          <div className="px-3 py-6 text-sm text-slate-400">
            No hay productos cargados todavía.
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
    </article>
  );
}
