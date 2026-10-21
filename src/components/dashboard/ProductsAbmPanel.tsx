import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, CaretRight, Circle, MagnifyingGlass, X } from '@phosphor-icons/react';
import type { InventorySelectionPreview, InventorySelectionRequest, ProductAdjustment, ProductInput, ProductModelInput } from '../../services/productService';
import { getVariantWord, type BusinessCategoryPreset } from '../../domain/businessCategories';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';
import { useInventory } from '../../hooks/useInventory';
import { LOW_STOCK_THRESHOLD } from './dashboardTypes';
import { StockSetAdjustmentForm } from './StockSetAdjustmentForm';
import { ProductFamilyPanel } from './ProductFamilyPanel';
import { ProductFamilyAssignmentPanel } from './ProductFamilyAssignmentPanel';
import { DataGrid, type DataGridColumn, type DataGridSection } from '../ui/DataGrid';
import { fetchBusinessMoneyPolicy } from '../../services/businessMoneyService';

type ProductDraft = {
  name: string;
  productType: string;
  productModel: string;
  size: string;
  stockAvailable: string;
  stockReserved: string;
  price: string;
};

type NewVariantDraft = {
  key: string;
  size: string;
  stockAvailable: string;
  price: string;
};

const emptyVariantDraft = (price = '0'): NewVariantDraft => ({
  key: Math.random().toString(36).slice(2),
  size: '',
  stockAvailable: '0',
  price,
});

type ProductRow = {
  revision?: number;
  identityFingerprint?: string;
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

type InventoryGrouping = 'model' | 'size' | 'productType' | 'none';
type InventoryGridRow = { kind: 'model'; group: ProductGroup } | { kind: 'product'; product: ProductRow };
const UNDEFINED_FILTER_VALUE = '__undefined__';

const SIZE_ORDER = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl'];

const normalizeSearch = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();

const compareVariantValues = (left: string | null | undefined, right: string | null | undefined) => {
  const leftSize = normalizeSearch(left ?? '');
  const rightSize = normalizeSearch(right ?? '');
  const leftIndex = SIZE_ORDER.indexOf(leftSize);
  const rightIndex = SIZE_ORDER.indexOf(rightSize);
  if (leftIndex >= 0 && rightIndex >= 0) {
    return leftIndex - rightIndex;
  }
  if (leftIndex >= 0) {
    return -1;
  }
  if (rightIndex >= 0) {
    return 1;
  }
  return String(left ?? '').localeCompare(String(right ?? ''), 'es', { numeric: true, sensitivity: 'base' });
};

const productLineName = (product: ProductRow) => {
  const typePart = product.productType?.trim() ?? '';
  const modelPart = product.productModel?.trim() ?? '';
  if (typePart || modelPart) {
    return [typePart, modelPart].filter(Boolean).join(' ');
  }
  return product.name;
};

const productSearchHaystack = (product: ProductRow) =>
  [product.name, product.productType, product.productModel, product.size].filter(Boolean).join(' ');

const pluralizeVariantLabel = (label: string | null | undefined) => {
  const singular = label?.trim().toLowerCase() || 'variante';
  if (singular === 'número' || singular === 'numero') {
    return 'números';
  }
  return `${singular}s`;
};

const buildProductGroups = (products: ProductRow[]): ProductGroup[] => {
  const groups: Record<string, ProductGroup> = {};

  for (const product of products) {
    const typePart = product.productType?.trim() ?? '';
    const modelPart = product.productModel?.trim() ?? '';
    const key = typePart || modelPart
      ? `model||${normalizeSearch(typePart)}||${normalizeSearch(modelPart)}`
      : `model||name||${normalizeSearch(product.name)}`;
    const displayName = typePart || modelPart ? [typePart, modelPart].filter(Boolean).join(' ') : product.name;
    groups[key] = groups[key] ?? {
      key,
      displayName,
      productType: product.productType,
      productModel: product.productModel,
      products: [],
    };
    groups[key]!.products.push(product);
  }

  return Object.values(groups)
    .map((group) => ({
      ...group,
      products: group.products.slice().sort((left, right) => compareVariantValues(left.size, right.size)),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'es', { sensitivity: 'base' }));
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

const toDraft = (product: ProductRow): ProductDraft => {
  const size = product.size?.trim() ?? '';
  const name = product.name?.trim() ?? '';
  const nameWithoutSize = size && name.toLowerCase().endsWith(` ${size.toLowerCase()}`)
    ? name.slice(0, -(size.length + 1)).trim()
    : name;

  return {
    name: nameWithoutSize,
    productType: product.productType ?? '',
    productModel: product.productModel ?? '',
    size,
    stockAvailable: String(product.stockAvailable ?? 0),
    stockReserved: String(product.stockReserved ?? 0),
    price: String(product.price ?? 0),
  };
};

const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;

const buildProductName = (draft: ProductDraft) => {
  const explicitName = draft.name.trim();
  if (explicitName) {
    return explicitName;
  }

  const parts = [draft.productType.trim(), draft.productModel.trim()].filter(Boolean);
  return parts.length ? parts.join(' ') : 'Nuevo Producto';
};

function DeactivateModal({ ids, reason, onReasonChange, preview, stale, error, busy, onCancel, onSubmit }: {
  ids: string[]; reason: string; onReasonChange: (reason: string) => void;
  preview: InventorySelectionPreview | null; stale: boolean; error: string | null; busy: boolean;
  onCancel: () => void; onSubmit: (refresh?: boolean) => Promise<void>;
}) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 backdrop-blur-sm">
    <div role="dialog" aria-modal="true" aria-label="Desactivar productos" className="max-h-full overflow-y-auto w-full max-w-lg rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-[color:var(--text)] shadow-2xl">
      <h4 className="type-title text-xl">Desactivar {ids.length === 1 ? 'producto' : 'selección'}</h4>
      <p className="mt-3 text-sm">Se desactivarán y saldrán del inventario activo; se conservan stock e historial.</p>
      <p className="mt-2 text-sm">{ids.length} productos seleccionados: {ids.join(', ')}</p>
      <label className="mt-4 block text-sm">Motivo de la desactivación
        <input className="erp-input" required disabled={busy} value={reason} onChange={(event) => onReasonChange(event.target.value)} />
      </label>
      {preview && <section aria-label="Vista previa de desactivación" className="mt-4 space-y-3 text-sm">
        <p>Motivo: {preview.mutation.reason}</p>
        <ul className="space-y-2">{preview.members.map((member) => <li key={member.skuId} className="rounded-xl border border-[color:var(--border)] p-3">
          <strong>{member.name}</strong> · Variante: {member.size || 'Sin definir'}
          <p>Código: {member.skuId} · Revisión: {member.revision}</p>
          <p>Disponible: {member.stockAvailable} · Reservado: {member.stockReserved} · Precio: {member.price} {member.priceCurrency}</p>
        </li>)}</ul>
        <p>Vence: {preview.expiresAt}</p>
      </section>}
      {error && <p role="alert" className="mt-4 text-sm text-rose-600 dark:text-rose-300">{error}</p>}
      <div className="mt-6 flex justify-end gap-3">
        <button type="button" disabled={busy} onClick={onCancel} className="erp-button-secondary">Cancelar</button>
        <button type="button" disabled={busy} onClick={() => void onSubmit(stale)} className="erp-button-danger">{busy ? 'Procesando...' : stale ? 'Revisar selección actualizada' : preview ? 'Confirmar desactivación' : 'Revisar desactivación'}</button>
      </div>
    </div>
  </div>;
}

function ProductFormModal({
  currency,
  title,
  description,
  draft,
  onDraftChange,
  onClose,
  onSubmit,
  submitLabel,
  submitting,
  preset,
  variantOnly,
  showReserved,
  requireVariant,
  error,
  adjustmentReason,
  onAdjustmentReasonChange,
}: {
  currency: string | null;
  title: string;
  description?: string;
  draft: ProductDraft;
  onDraftChange: (nextDraft: ProductDraft) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  submitLabel: string;
  submitting: boolean;
  preset: BusinessCategoryPreset;
  variantOnly: boolean;
  showReserved: boolean;
  requireVariant: boolean;
  error: string | null;
  adjustmentReason?: string;
  onAdjustmentReasonChange?: (reason: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm" role="presentation">
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-[color:var(--text)] shadow-2xl shadow-black/70">
        <div className="flex items-start justify-between gap-3">
          <h4 className="type-title text-[1.55rem] leading-none text-[color:var(--text)]">{title}</h4>
          <button type="button" aria-label="Cerrar modal" className="erp-button-secondary h-8 w-8 px-0" disabled={submitting} onClick={onClose}>
            ×
          </button>
        </div>
        {description && <p className="mt-2 text-sm text-[color:var(--muted)]">{description}</p>}

        <p className="mt-3 text-sm">{currency ? `Precios en ${currency}, en unidades enteras (65000 = $65.000).` : "Moneda del negocio sin confirmar. Podés configurarla en Stocky Studio."}</p><form id="product-form" className="mt-5 space-y-5" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}>
          <fieldset disabled={submitting} className="min-w-0 space-y-5">
          {!variantOnly && (
            <fieldset>
              {preset.useVariants && <legend className="mb-3 type-subtitle text-sm text-[color:var(--muted)]">1. Modelo</legend>}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
                  {preset.productTypeLabel}
                  <input className="erp-input h-11 rounded-xl text-[15px]" required={preset.useVariants} value={draft.productType} onChange={(event) => onDraftChange({ ...draft, productType: event.target.value })} />
                </label>
                <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
                  {preset.productModelLabel}
                  <input className="erp-input h-11 rounded-xl text-[15px]" required={preset.useVariants} value={draft.productModel} onChange={(event) => onDraftChange({ ...draft, productModel: event.target.value })} />
                </label>
                <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)] sm:col-span-2">
                  Nombre para mostrar (opcional)
                  <input className="erp-input h-11 rounded-xl text-[15px]" placeholder="Si queda vacío, se usa tipo + modelo" value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} />
                </label>
              </div>
            </fieldset>
          )}
          <fieldset className={!variantOnly && preset.useVariants ? 'border-t border-[color:var(--border)] pt-4' : ''}>
            <legend className="mb-3 type-subtitle text-sm text-[color:var(--muted)]">
              {preset.useVariants ? variantOnly ? `Datos del ${getVariantWord(preset)}` : `2. Primer ${getVariantWord(preset)}` : 'Stock y precio'}
            </legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {preset.useVariants && preset.variantLabel && (
                <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
                  {preset.variantLabel}
                  <input className="erp-input h-11 rounded-xl text-[15px]" autoFocus={variantOnly} required={requireVariant} value={draft.size} onChange={(event) => onDraftChange({ ...draft, size: event.target.value })} />
                </label>
              )}
              <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
                Stock Disponible
                <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" step="1" required value={draft.stockAvailable} onChange={(event) => onDraftChange({ ...draft, stockAvailable: event.target.value })} />
              </label>
              <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
                Precio
                <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" step="1" required value={draft.price} onChange={(event) => onDraftChange({ ...draft, price: event.target.value })} />
              </label>
              {showReserved && <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
                Stock Reservado
                <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" step="1" required value={draft.stockReserved} onChange={(event) => onDraftChange({ ...draft, stockReserved: event.target.value })} />
              </label>}
            </div>
            {!showReserved && <p className="mt-2 text-xs text-[color:var(--muted)]">Podés cargar stock ahora o dejarlo en 0 y registrar un ingreso después.</p>}
          </fieldset>
          {onAdjustmentReasonChange && <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
            Motivo del ajuste
            <input className="erp-input" required value={adjustmentReason ?? ''} onChange={(event) => onAdjustmentReasonChange(event.target.value)} placeholder="Por ejemplo: corrección por conteo físico" />
          </label>}
        </fieldset>
        </form>
        {error && <p role="alert" className="mt-4 rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">{error}</p>}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" disabled={submitting} onClick={onClose} className="erp-button-secondary">
            Cancelar
          </button>
          <button type="submit" form="product-form" disabled={submitting} className="erp-button-primary">
            {submitting ? 'Guardando...' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewModelModal({
  currency,
  draft,
  variants,
  preset,
  onDraftChange,
  onVariantsChange,
  onClose,
  onSubmit,
  saving,
  error,
}: {
  draft: ProductDraft;
  variants: NewVariantDraft[];
  currency: string | null;
  preset: BusinessCategoryPreset;
  onDraftChange: (draft: ProductDraft) => void;
  onVariantsChange: (variants: NewVariantDraft[]) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  saving: boolean;
  error: string | null;
}) {
  const variantWord = getVariantWord(preset);
  const updateVariant = (key: string, changes: Partial<NewVariantDraft>) =>
    onVariantsChange(variants.map((variant) => variant.key === key ? { ...variant, ...changes } : variant));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm" role="presentation">
      <div role="dialog" aria-modal="true" aria-label="Nuevo modelo" className="max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-[color:var(--text)] shadow-2xl shadow-black/70">
        <div className="flex items-start justify-between gap-3">
          <h4 className="type-title text-[1.55rem] leading-none">Nuevo modelo</h4>
          <button type="button" aria-label="Cerrar modal" className="erp-button-secondary h-8 w-8 px-0" disabled={saving} onClick={onClose}>×</button>
        </div>
        <p className="mt-2 text-sm text-[color:var(--muted)]">Cargá el modelo y todos los {pluralizeVariantLabel(preset.variantLabel)} que quieras vender.</p>
        <p className="mt-3 text-sm">{currency ? `Precios en ${currency}, en unidades enteras (65000 = $65.000).` : "Moneda del negocio sin confirmar. Podés configurarla en Stocky Studio."}</p><form id="new-model-form" className="mt-5 space-y-5" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}>
          <fieldset disabled={saving} className="min-w-0 space-y-5">
          <fieldset>
            <legend className="mb-3 type-subtitle text-sm text-[color:var(--muted)]">Modelo</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-sm type-subtitle">
                {preset.productTypeLabel}
                <input className="erp-input h-11 rounded-xl text-[15px]" required value={draft.productType} onChange={(event) => onDraftChange({ ...draft, productType: event.target.value })} />
              </label>
              <label className="block space-y-1.5 text-sm type-subtitle">
                {preset.productModelLabel}
                <input className="erp-input h-11 rounded-xl text-[15px]" required value={draft.productModel} onChange={(event) => onDraftChange({ ...draft, productModel: event.target.value })} />
              </label>
            </div>
          </fieldset>
          <fieldset className="border-t border-[color:var(--border)] pt-4">
            <legend className="mb-3 type-subtitle text-sm text-[color:var(--muted)]">{pluralizeVariantLabel(preset.variantLabel)}</legend>
            <div className="space-y-3">
              {variants.map((variant, index) => (
                <div key={variant.key} role="group" aria-label={`${variantWord} ${index + 1}`} className="rounded-xl border border-[color:var(--border)] bg-[color:var(--overlay-soft)] p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="type-subtitle text-sm text-[color:var(--muted)]">{variantWord.charAt(0).toUpperCase() + variantWord.slice(1)} {index + 1}</span>
                    {variants.length > 1 && <button type="button" className="text-sm font-semibold text-rose-600 hover:underline dark:text-rose-300" aria-label={`Quitar ${variantWord} ${index + 1}`} onClick={() => onVariantsChange(variants.filter((item) => item.key !== variant.key))}>Quitar</button>}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="block space-y-1.5 text-sm type-subtitle">
                      {preset.variantLabel}
                      <input className="erp-input h-11 rounded-xl text-[15px]" required value={variant.size} onChange={(event) => updateVariant(variant.key, { size: event.target.value })} />
                    </label>
                    <label className="block space-y-1.5 text-sm type-subtitle">
                      Stock disponible
                      <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" step="1" required value={variant.stockAvailable} onChange={(event) => updateVariant(variant.key, { stockAvailable: event.target.value })} />
                    </label>
                    <label className="block space-y-1.5 text-sm type-subtitle">
                      Precio
                      <input className="erp-input h-11 rounded-xl text-[15px]" type="number" min="0" step="1" required value={variant.price} onChange={(event) => updateVariant(variant.key, { price: event.target.value })} />
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" className="erp-button-secondary mt-3" onClick={() => onVariantsChange([...variants, emptyVariantDraft(variants[variants.length - 1]?.price ?? '0')])}>+ Agregar otro {variantWord}</button>
            <p className="mt-2 text-xs text-[color:var(--muted)]">Podés dejar el stock en 0 y registrar un ingreso después.</p>
          </fieldset>
        </fieldset>
        </form>
        {error && <p role="alert" className="mt-4 rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">{error}</p>}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" disabled={saving} onClick={onClose} className="erp-button-secondary">Cancelar</button>
          <button type="submit" form="new-model-form" disabled={saving} className="erp-button-primary">{saving ? 'Guardando...' : 'Crear modelo'}</button>
        </div>
      </div>
    </div>
  );
}

function ModelFormModal({
  group,
  preset,
  productType,
  productModel,
  onChange,
  onClose,
  onSubmit,
  saving,
  error,
  reason, onReasonChange, preview, stale, onRefreshPreview,
}: {
  group: ProductGroup;
  preset: BusinessCategoryPreset;
  productType: string;
  productModel: string;
  onChange: (values: { productType: string; productModel: string }) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  saving: boolean;
  error: string | null;
  reason: string;
  onReasonChange: (reason: string) => void;
  preview: InventorySelectionPreview | null;
  stale: boolean;
  onRefreshPreview: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm" role="presentation">
      <div role="dialog" aria-modal="true" aria-label={`Editar modelo ${group.displayName}`} className="max-h-full overflow-y-auto w-full max-w-lg rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-[color:var(--text)] shadow-2xl">
        <h4 className="type-title text-xl">Editar modelo</h4>
        <p className="mt-2 text-sm text-[color:var(--muted)]">Los cambios de nombre se aplican a sus {group.products.length} {group.products.length === 1 ? getVariantWord(preset) : pluralizeVariantLabel(preset.variantLabel)}.</p>
        <form id="model-form" className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}>
          <label className="block space-y-1.5 text-sm type-subtitle">
            {preset.productTypeLabel}
            <input className="erp-input" required disabled={saving} value={productType} onChange={(event) => onChange({ productType: event.target.value, productModel })} />
          </label>
          <label className="block space-y-1.5 text-sm type-subtitle">
            {preset.productModelLabel}
            <input className="erp-input" required disabled={saving} value={productModel} onChange={(event) => onChange({ productType, productModel: event.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm type-subtitle">Motivo del cambio
            <input className="erp-input" required disabled={saving} value={reason} onChange={(event) => onReasonChange(event.target.value)} />
          </label>
        </form>
        {preview && preview.mutation.type === 'sku.update' && <section aria-label="Vista previa de cambios" className="mt-4 space-y-3 text-sm">
          <p className="font-semibold">{preview.members.length} productos seleccionados · Nuevo nombre: {preview.mutation.changes.name}</p>
          <p>Tipo: {preview.mutation.changes.productType} · Modelo: {preview.mutation.changes.productModel}</p>
          <p>Motivo: {preview.mutation.reason}</p>
          <ul className="space-y-2">{preview.members.map((member) => <li key={member.skuId} className="rounded-xl border border-[color:var(--border)] p-3">
            <strong>{member.name}</strong> · Variante: {member.size || 'Sin definir'}
            <p>Código: {member.skuId} · Revisión: {member.revision}</p>
            <p>Disponible: {member.stockAvailable} · Reservado: {member.stockReserved} · Precio: {member.price} {member.priceCurrency}</p>
          </li>)}</ul>
          <p>Vence: {preview.expiresAt}</p>
        </section>}
        {error && <p role="alert" className="mt-4 rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="erp-button-secondary" onClick={onClose} disabled={saving}>Cancelar</button>
          {stale ? <button type="button" className="erp-button-primary" disabled={saving} onClick={onRefreshPreview}>Revisar selección actualizada</button>
            : <button type="submit" form="model-form" className="erp-button-primary" disabled={saving}>{saving ? 'Procesando...' : preview ? 'Confirmar cambios' : 'Revisar cambios'}</button>}
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
  const { products, createProductRecord, createProductModelRecords, updateProductRecord, updateProductModelRecords, previewInventorySelection, deleteProductRecord, deleteProductRecords } = useInventory();
  const preset = useBusinessCategoryPreset();
  const [priceCurrency, setPriceCurrency] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refreshMoney = () => { void fetchBusinessMoneyPolicy().then(policy => { if (active) setPriceCurrency(policy?.currency ?? null); }).catch(() => {}); };
    refreshMoney(); addEventListener('focus', refreshMoney);
    return () => { active = false; removeEventListener('focus', refreshMoney); };
  }, []);
  const variantWord = getVariantWord(preset);
  const variantLabelPlural = pluralizeVariantLabel(preset.variantLabel);
  const [stockSetOpen, setStockSetOpen] = useState(false);
  const [productFamilyOpen, setProductFamilyOpen] = useState(false);
  const [productFamilyAssignmentOpen, setProductFamilyAssignmentOpen] = useState(false);
  const [draft, setDraft] = useState<ProductDraft>(() => emptyDraft());
  const [newVariants, setNewVariants] = useState<NewVariantDraft[]>(() => [emptyVariantDraft()]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editSnapshot, setEditSnapshot] = useState<ProductRow | null>(null);
  const [adjustmentReason, setAdjustmentReason] = useState('');
  // Keep the exact operation through ambiguous failures, including a failed refresh after success.
  const editOperation = useRef<{ key: string; adjustment: ProductAdjustment; changes: Partial<ProductInput> } | null>(null);
  const createOperation = useRef<
    | { kind: 'sku'; key: string; operationId: string; payload: ProductInput }
    | { kind: 'model'; key: string; operationId: string; payload: ProductModelInput }
    | null
  >(null);
  const formBusy = useRef(false);
  const [addingToGroup, setAddingToGroup] = useState<ProductGroup | null>(null);
  const [editingGroup, setEditingGroup] = useState<ProductGroup | null>(null);
  const [modelDraft, setModelDraft] = useState({ productType: '', productModel: '' });
  const [modelError, setModelError] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [modelReason, setModelReason] = useState('');
  const [modelPreview, setModelPreview] = useState<InventorySelectionPreview | null>(null);
  const [modelStale, setModelStale] = useState(false);
  const modelRequest = useRef<InventorySelectionRequest | null>(null);
  const modelRefreshRequestNeeded = useRef(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deactivation, setDeactivation] = useState<{ ids: string[]; single: boolean } | null>(null);
  const [deactivationReason, setDeactivationReason] = useState('');
  const [deactivationPreview, setDeactivationPreview] = useState<InventorySelectionPreview | null>(null);
  const [deactivationStale, setDeactivationStale] = useState(false);
  const [deactivationError, setDeactivationError] = useState<string | null>(null);
  const deactivationRequest = useRef<InventorySelectionRequest | null>(null);
  const deactivationRefreshNeeded = useRef(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sizeFilter, setSizeFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [groupBy, setGroupBy] = useState<InventoryGrouping>(() => preset.useVariants ? 'model' : 'none');
  const onlyLowStock = stockFilter === 'low-stock';
  const grouping = !preset.useVariants && (groupBy === 'size' || groupBy === 'model') ? 'none' : groupBy;
  const hasFilters = Boolean(searchQuery.trim() || sizeFilter || typeFilter || onlyLowStock);

  const stockSummary = useMemo(() => {
    const totalAvailable = products.reduce((total, product) => total + product.stockAvailable, 0);
    const totalReserved = products.reduce((total, product) => total + product.stockReserved, 0);
    const totalValue = products.reduce((total, product) => total + (product.stockAvailable + product.stockReserved) * product.price, 0);

    return { totalAvailable, totalReserved, totalValue };
  }, [products]);

  const groupedProducts = useMemo(
    () => (preset.useVariants ? buildProductGroups(products) : []),
    [products, preset.useVariants],
  );

  const filterOptions = useMemo(() => {
    const options = (values: (string | null | undefined)[]) => {
      const unique = new Map<string, string>();
      for (const value of values) {
        const label = value?.trim() ?? '';
        unique.set(label ? normalizeSearch(label) : UNDEFINED_FILTER_VALUE, label || 'Sin definir');
      }
      return [...unique].map(([value, label]) => ({ value, label }));
    };
    return {
      sizes: options(products.map((product) => product.size)).sort((a, b) => compareVariantValues(a.label, b.label)),
      types: options(products.map((product) => product.productType)).sort((a, b) => a.label.localeCompare(b.label, 'es')),
    };
  }, [products]);

  const flatProducts = useMemo(() => {
    const query = normalizeSearch(searchQuery);
    const matchesOption = (value: string | null | undefined, filter: string) => !filter || (value?.trim() ? normalizeSearch(value) : UNDEFINED_FILTER_VALUE) === filter;
    return products.filter((product) => (!query || normalizeSearch(productSearchHaystack(product)).includes(query))
      && (!onlyLowStock || product.stockAvailable <= LOW_STOCK_THRESHOLD)
      && (!preset.useVariants || matchesOption(product.size, sizeFilter))
      && matchesOption(product.productType, typeFilter))
      .slice().sort((left, right) => productLineName(left).localeCompare(productLineName(right), 'es', { sensitivity: 'base' }) || compareVariantValues(left.size, right.size));
  }, [products, searchQuery, onlyLowStock, preset.useVariants, sizeFilter, typeFilter]);

  const filteredGroups = useMemo(() => buildProductGroups(flatProducts), [flatProducts]);
  const gridSections = useMemo<DataGridSection<InventoryGridRow>[]>(() => {
    if (grouping === 'model') return [{ id: 'models', rows: filteredGroups.map((group) => ({ kind: 'model', group })) }];
    const rows: InventoryGridRow[] = flatProducts.map((product) => ({ kind: 'product', product }));
    if (grouping === 'none') return [{ id: 'products', rows }];
    const sections = new Map<string, DataGridSection<InventoryGridRow>>();
    for (const row of rows) {
      if (row.kind !== 'product') continue;
      const value = (grouping === 'size' ? row.product.size : row.product.productType)?.trim() || 'Sin definir';
      const id = normalizeSearch(value);
      if (!sections.has(id)) sections.set(id, { id, label: grouping === 'size' ? (preset.variantLabel || 'Variante') + ': ' + value : value, rows: [] });
      sections.get(id)!.rows.push(row);
    }
    return [...sections.values()].sort((a, b) => grouping === 'size'
      ? compareVariantValues(a.rows[0]?.kind === 'product' ? a.rows[0].product.size : '', b.rows[0]?.kind === 'product' ? b.rows[0].product.size : '')
      : a.label!.localeCompare(b.label!, 'es', { sensitivity: 'base' }))
      .map((section) => ({ ...section, summary: section.rows.length + (section.rows.length === 1 ? ' producto' : ' productos') }));
  }, [grouping, flatProducts, filteredGroups, preset.variantLabel]);

  const currentProductIds = useMemo(() => new Set(products.map((product) => product.id)), [products]);
  const selectedCurrentIds = selectedIds.filter((id) => currentProductIds.has(id));
  const rowProducts = (row: InventoryGridRow) => row.kind === 'model' ? row.group.products : [row.product];
  const selectionFor = (row: InventoryGridRow): 'all' | 'some' | 'none' => {
    const members = rowProducts(row);
    if (members.every((product) => selectedCurrentIds.includes(product.id))) return 'all';
    return members.some((product) => selectedCurrentIds.includes(product.id)) ? 'some' : 'none';
  };
  const isGroupExpanded = (group: ProductGroup) => expandedGroups[group.key] ?? hasFilters;
  const toggleGroup = (group: ProductGroup) => setExpandedGroups((current) => ({ ...current, [group.key]: !isGroupExpanded(group) }));
  const fullGroupFor = (group: ProductGroup) => groupedProducts.find((item) => item.key === group.key) ?? group;

  const toggleSelection = (ids: string[]) => {
    setSelectedIds((current) => {
      const selected = new Set(current.filter((id) => currentProductIds.has(id)));
      if (ids.every((id) => selected.has(id))) ids.forEach((id) => selected.delete(id));
      else ids.forEach((id) => selected.add(id));
      return [...selected];
    });
  };

  const invalidateDeactivationPreview = () => {
    setDeactivationPreview(null);
    setDeactivationStale(false);
    setDeactivationError(null);
    deactivationRequest.current = null;
    deactivationRefreshNeeded.current = false;
  };

  const openDeactivation = (ids: string[], single: boolean) => {
    setDeactivation({ ids: [...ids], single });
    setDeactivationReason('');
    invalidateDeactivationPreview();
  };

  const handleDeactivation = async (refreshPreview = false) => {
    if (!deactivation || deleting || (deactivationStale && !refreshPreview)) return;
    if (!deactivationReason.trim()) {
      setDeactivationError('Ingresá el motivo de la desactivación.');
      return;
    }
    setDeleting(true);
    setDeactivationError(null);
    try {
      if (!deactivationPreview || refreshPreview) {
        if (refreshPreview && deactivationRefreshNeeded.current) {
          deactivationRequest.current = null;
          deactivationRefreshNeeded.current = false;
        }
        deactivationRequest.current ??= {
          requestId: crypto.randomUUID(),
          selector: { kind: 'ids', skuIds: deactivation.ids },
          mutation: { type: 'sku.deactivate', reason: deactivationReason.trim() },
        };
        setDeactivationPreview(await previewInventorySelection(deactivationRequest.current));
        setDeactivationStale(false);
        return;
      }
      const selection = { selectionId: deactivationPreview.selectionId, digest: deactivationPreview.digest };
      if (deactivation.single) await deleteProductRecord(deactivation.ids[0]!, selection);
      else await deleteProductRecords(selection);
      setSelectedIds((current) => current.filter((id) => !deactivation.ids.includes(id)));
      setDeactivation(null);
    } catch (error) {
      const stale = Boolean(deactivationPreview && error && typeof error === 'object' && 'status' in error && error.status === 409);
      if (stale) {
        setDeactivationStale(true);
        deactivationRefreshNeeded.current = true;
      }
      setDeactivationError(stale ? 'El inventario cambió. Tu motivo y vista previa se conservan. Revisá una selección actualizada antes de confirmar.' : error instanceof Error ? error.message : 'No se pudo desactivar la selección.');
    } finally { setDeleting(false); }
  };

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

  useEffect(() => {
    if (!isFormOpen) {
      createOperation.current = null;
      setEditingProductId(null);
      setAddingToGroup(null);
      setDraft(emptyDraft());
      setNewVariants([emptyVariantDraft()]);
      formBusy.current = false;
      setSaving(false);
      setFormError(null);
    }
  }, [isFormOpen]);

  const openCreateForm = () => {
    if (formBusy.current) return;
    createOperation.current = null;
    setEditingProductId(null);
    setAddingToGroup(null);
    setFormError(null);
    setDraft(emptyDraft());
    setNewVariants([emptyVariantDraft()]);
    setIsFormOpen(true);
  };

  const handleCreateModel = async () => {
    if (formBusy.current) return;
    const key = JSON.stringify({ draft, newVariants });
    const retry = createOperation.current?.kind === 'model' && createOperation.current.key === key;
    const productType = draft.productType.trim();
    const productModel = draft.productModel.trim();
    if (!productType || !productModel) {
      setFormError('Completá el tipo de prenda y el modelo.');
      return;
    }
    const modelKey = `model||${normalizeSearch(productType)}||${normalizeSearch(productModel)}`;
    if (!retry && groupedProducts.some((group) => group.key === modelKey)) {
      setFormError(`Ese modelo ya existe. Agregá el ${variantWord} desde su tarjeta.`);
      return;
    }
    const sizes = new Set<string>();
    for (const variant of newVariants) {
      const size = normalizeSearch(variant.size);
      if (!size) {
        setFormError(`Completá todos los ${variantLabelPlural}.`);
        return;
      }
      if (sizes.has(size)) {
        setFormError(`El ${variantWord} ${variant.size.trim()} está repetido.`);
        return;
      }
      sizes.add(size);
      if (![variant.stockAvailable, variant.price].every((value) => value.trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0)) {
        setFormError('Stock y precio deben ser números enteros mayores o iguales a cero.');
        return;
      }
    }
    setFormError(null);
    formBusy.current = true;
    setSaving(true);
    try {
      const policy = retry ? null : await fetchBusinessMoneyPolicy();
      if (!retry) createOperation.current = { kind: 'model', key, operationId: crypto.randomUUID(), payload: {
        productType,
        productModel,
        ...(policy ? { priceCurrency: policy.currency } : {}),
        variants: newVariants.map((variant) => ({
          size: variant.size.trim(),
          stockAvailable: Number(variant.stockAvailable),
          price: Number(variant.price),
        })),
      } };
      const operation = createOperation.current!;
      if (operation.kind !== 'model') return;
      await createProductModelRecords(operation.payload, operation);
      setExpandedGroups((current) => ({ ...current, [modelKey]: true }));
      setIsFormOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'No se pudo crear el modelo.');
    } finally {
      formBusy.current = false;
      setSaving(false);
    }
  };

  const openEditForm = (product: ProductRow) => {
    if (formBusy.current) return;
    createOperation.current = null;
    setEditSnapshot({ ...product });
    setAdjustmentReason('');
    editOperation.current = null;
    setEditingProductId(product.id);
    setAddingToGroup(null);
    setFormError(null);
    setDraft(toDraft(product));
    setIsFormOpen(true);
  };

  const openAddVariantForm = (group: ProductGroup) => {
    if (formBusy.current) return;
    createOperation.current = null;
    const reference = group.products[0];
    if (!reference) return;
    setEditingProductId(null);
    setAddingToGroup(group);
    setFormError(null);
    setDraft({ ...toDraft(reference), size: '', stockAvailable: '0', stockReserved: '0' });
    setIsFormOpen(true);
  };

  const openEditModelForm = (group: ProductGroup) => {
    setEditingGroup({ ...group, products: group.products.map((product) => ({ ...product })) });
    setModelDraft({ productType: group.productType ?? '', productModel: group.productModel ?? '' });
    setModelReason('');
    setModelPreview(null);
    setModelStale(false);
    modelRequest.current = null;
    modelRefreshRequestNeeded.current = false;
    setModelError(null);
  };

  const invalidateModelPreview = () => {
    setModelPreview(null);
    setModelStale(false);
    modelRequest.current = null;
    modelRefreshRequestNeeded.current = false;
    setModelError(null);
  };

  const handleModelSubmit = async (refreshPreview = false) => {
    if (!editingGroup || savingModel || (modelStale && !refreshPreview)) return;
    const productType = modelDraft.productType.trim();
    const productModel = modelDraft.productModel.trim();
    if (!productType || !productModel) {
      setModelError('Completá el tipo y el modelo.');
      return;
    }
    if (!modelReason.trim()) {
      setModelError('Ingresá el motivo del cambio.');
      return;
    }
    const nextKey = `model||${normalizeSearch(productType)}||${normalizeSearch(productModel)}`;
    if (!modelPreview && !modelRequest.current && groupedProducts.some((group) => group.key === nextKey && group.key !== editingGroup.key)) {
      setModelError('Ya existe un modelo con ese nombre.');
      return;
    }
    setSavingModel(true);
    setModelError(null);
    try {
      if (!modelPreview || refreshPreview) {
        if (refreshPreview && modelRefreshRequestNeeded.current) {
          modelRequest.current = null;
          modelRefreshRequestNeeded.current = false;
        }
        modelRequest.current ??= {
          requestId: crypto.randomUUID(),
          selector: { kind: 'ids', skuIds: editingGroup.products.map((product) => product.id) },
          mutation: { type: 'sku.update', changes: { name: `${productType} ${productModel}`, productType, productModel }, reason: modelReason.trim() },
        };
        setModelPreview(await previewInventorySelection(modelRequest.current));
        setModelStale(false);
        return;
      }
      await updateProductModelRecords({ selectionId: modelPreview.selectionId, digest: modelPreview.digest });
      setExpandedGroups((current) => ({ ...current, [nextKey]: true }));
      setEditingGroup(null);
    } catch (error) {
      const stale = Boolean(error && typeof error === 'object' && 'status' in error && error.status === 409);
      if (stale) {
        setModelStale(true);
        modelRefreshRequestNeeded.current = true;
      }
      setModelError(stale ? 'El inventario cambió. Tu borrador y vista previa se conservan. Revisá una selección actualizada antes de confirmar.' : error instanceof Error ? error.message : 'No se pudo editar el modelo.');
    } finally {
      setSavingModel(false);
    }
  };

  const handleSubmit = async () => {
    if (formBusy.current) return;
    const createKey = JSON.stringify(draft);
    const retry = createOperation.current?.kind === 'sku' && createOperation.current.key === createKey;
    if (editingProductId && (!editSnapshot || !Number.isSafeInteger(editSnapshot.revision) || (editSnapshot.revision ?? -1) < 0)) {
      setFormError('Falta la revisión del producto. Actualizá la página y volvé a abrir el formulario. Tu borrador se conserva.');
      return;
    }
    if (editingProductId && !adjustmentReason.trim()) {
      setFormError('Ingresá el motivo del ajuste.');
      return;
    }
    const size = draft.size.trim();
    const quantities = [draft.stockAvailable, draft.stockReserved, draft.price].map(Number);
    if (!editingProductId && preset.useVariants && !size) {
      setFormError(`Ingresá un ${variantWord}.`);
      return;
    }
    if (!editingProductId && !addingToGroup && preset.useVariants && (!draft.productType.trim() || !draft.productModel.trim())) {
      setFormError('Completá el tipo de producto y el modelo.');
      return;
    }
    if ([draft.stockAvailable, draft.stockReserved, draft.price].some((value) => !value.trim()) || quantities.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      setFormError('Precio y stock deben ser números enteros mayores o iguales a cero.');
      return;
    }
    if (preset.useVariants && size && !retry) {
      const sameModel = (addingToGroup ? groupedProducts.find((group) => group.key === addingToGroup.key)?.products : null) ?? products.filter((product) => {
        if (draft.productType.trim() || draft.productModel.trim()) {
          return normalizeSearch(product.productType ?? '') === normalizeSearch(draft.productType)
            && normalizeSearch(product.productModel ?? '') === normalizeSearch(draft.productModel);
        }
        return normalizeSearch(product.name) === normalizeSearch(buildProductName(draft));
      });
      if (!editingProductId && !addingToGroup && sameModel.length > 0) {
        setFormError(`Ese modelo ya existe. Usá “Agregar ${variantWord}” desde su tarjeta.`);
        return;
      }
      if (sameModel.some((product) => product.id !== editingProductId && normalizeSearch(product.size ?? '') === normalizeSearch(size))) {
        setFormError(`Ese ${variantWord} ya existe en el modelo. Editá el existente para cambiar su stock o precio.`);
        return;
      }
    }

    setFormError(null);
    formBusy.current = true;
    setSaving(true);
    try {
      const editKey = JSON.stringify({ productId: editingProductId, draft, reason: adjustmentReason.trim() });
      const retryEdit = Boolean(editingProductId && editOperation.current?.key === editKey);
      const policy = retry || retryEdit ? null : await fetchBusinessMoneyPolicy();
      const payload = {
        name: editingProductId && !draft.name.trim()
          ? editSnapshot?.name ?? buildProductName(draft)
          : buildProductName(draft),
        productType: draft.productType.trim() || undefined,
        productModel: draft.productModel.trim() || undefined,
        size: preset.useVariants ? draft.size.trim() || undefined : undefined,
        stockAvailable: quantities[0],
        stockReserved: quantities[1],
        price: quantities[2],
        ...(policy ? { priceCurrency: policy.currency } : {}),
      };

      if (editingProductId) {
        const changes = preset.useVariants
          ? { size: payload.size, stockAvailable: payload.stockAvailable, stockReserved: payload.stockReserved, price: payload.price, ...(payload.priceCurrency ? { priceCurrency: payload.priceCurrency } : {}) }
          : payload;
        const reason = adjustmentReason.trim();
        const key = editKey;
        if (editOperation.current?.key !== key) {
          editOperation.current = { key, changes, adjustment: {
            operationId: crypto.randomUUID(),
            expectedRevision: editSnapshot!.revision!,
            expectedFingerprint: editSnapshot!.identityFingerprint,
            reason,
          } };
        }
        const operation = editOperation.current!;
        await updateProductRecord(editingProductId, operation.changes, operation.adjustment);
      } else {
        if (!retry) createOperation.current = { kind: 'sku', key: createKey, operationId: crypto.randomUUID(), payload };
        const operation = createOperation.current!;
        if (operation.kind !== 'sku') return;
        await createProductRecord(operation.payload, operation);
      }

      setIsFormOpen(false);
      if (addingToGroup) setExpandedGroups((current) => ({ ...current, [addingToGroup.key]: true }));
    } catch (error) {
      setFormError(editingProductId && error instanceof Error && 'status' in error && error.status === 409
        ? 'El producto cambió desde que abriste el formulario. Tu borrador se conserva. Actualizá la página y volvé a abrir el producto para revisar los valores antes de guardar.'
        : error instanceof Error ? error.message : 'No se pudo guardar el producto.');
    } finally {
      formBusy.current = false;
      setSaving(false);
    }
  };

  const gridColumns: DataGridColumn<InventoryGridRow>[] = [
    {
      id: 'name', label: grouping === 'model' ? 'Modelo / producto' : 'Producto', width: 380, minWidth: 220, required: true,
      render: (row) => row.kind === 'model' ? <button type="button" className="flex w-full items-start gap-2.5 text-left" aria-label={(isGroupExpanded(row.group) ? 'Ocultar' : 'Ver') + ' ' + variantLabelPlural + ' de ' + row.group.displayName} aria-expanded={isGroupExpanded(row.group)} onClick={() => toggleGroup(row.group)}>
        <span className="mt-1 shrink-0 text-[color:var(--muted)]">{isGroupExpanded(row.group) ? <CaretDown size={16} /> : <CaretRight size={16} />}</span>
        <span className="min-w-0"><span className="type-subtitle block leading-snug">{row.group.displayName}</span><span className="mt-1 block text-xs text-[color:var(--muted)]">{row.group.products.length}{row.group.products.length < fullGroupFor(row.group).products.length ? ' de ' + fullGroupFor(row.group).products.length : ''} {fullGroupFor(row.group).products.length === 1 ? variantWord : variantLabelPlural}</span></span>
      </button> : <span className="type-subtitle leading-snug">{preset.useVariants ? productLineName(row.product) : row.product.name}</span>,
    },
    {
      id: 'type', label: preset.productTypeLabel, width: 155, minWidth: 110, hidden: true,
      render: (row) => <span className="text-[color:var(--muted)]">{(row.kind === 'model' ? row.group.productType : row.product.productType) || 'Sin definir'}</span>,
    },
    ...(preset.useVariants ? [{
      id: 'size', label: grouping === 'model' ? variantLabelPlural.charAt(0).toUpperCase() + variantLabelPlural.slice(1) : preset.variantLabel || 'Variante', width: 180, minWidth: 110,
      render: (row: InventoryGridRow) => row.kind === 'model' ? <div className="flex flex-wrap gap-1.5">{row.group.products.map((product) => <button type="button" key={product.id} title={'Filtrar ' + variantWord + ' ' + (product.size || 'sin definir')} aria-label={'Filtrar ' + variantWord + ' ' + (product.size || 'sin definir')} aria-pressed={sizeFilter === (product.size?.trim() ? normalizeSearch(product.size) : UNDEFINED_FILTER_VALUE)} className="rounded-md border border-[color:var(--border)] bg-[color:var(--overlay-soft)] px-2 py-1 text-xs hover:border-[color:var(--accent)] hover:text-[color:var(--accent)]" onClick={() => setSizeFilter(product.size?.trim() ? normalizeSearch(product.size) : UNDEFINED_FILTER_VALUE)}>{(product.size || '—') + ': '}<span className="text-[color:var(--muted)]">{product.stockAvailable}</span></button>)}</div> : <span className="inline-block rounded-md border border-[color:var(--border)] px-2 py-1 text-xs font-semibold">{row.product.size || 'Sin definir'}</span>,
    }] : []),
    {
      id: 'stock', label: 'Disponible', width: 135, minWidth: 110, align: 'right',
      render: (row) => {
        const members = rowProducts(row);
        const quantity = members.reduce((total, product) => total + product.stockAvailable, 0);
        const low = members.some((product) => product.stockAvailable <= LOW_STOCK_THRESHOLD);
        return <div className="flex flex-col items-end gap-1"><strong className="tabular-nums">{quantity.toLocaleString('es-AR')}</strong>{low && <span className="inventory-stock-status" data-empty={quantity === 0}><Circle size={6} weight="fill" />{quantity === 0 ? 'Sin stock' : row.kind === 'model' ? variantLabelPlural.charAt(0).toUpperCase() + variantLabelPlural.slice(1) + ' con stock bajo' : 'Stock bajo'}</span>}</div>;
      },
    },
    { id: 'reserved', label: 'Reservado', width: 115, minWidth: 95, align: 'right', hidden: true, render: (row) => <span className="tabular-nums text-[color:var(--muted)]">{rowProducts(row).reduce((total, product) => total + product.stockReserved, 0)}</span> },
    {
      id: 'price', label: 'Precio', width: 150, minWidth: 120, align: 'right', render: (row) => {
        const prices = rowProducts(row).map((product) => product.price);
        const min = Math.min(...prices), max = Math.max(...prices);
        return <span className="font-medium tabular-nums">{min === max ? formatCurrency(min) : formatCurrency(min) + ' – ' + formatCurrency(max)}</span>;
      },
    },
    {
      id: 'actions', label: 'Acciones', width: 190, minWidth: 170, required: true, align: 'right',
      render: (row) => row.kind === 'model' ? <div className="flex items-center justify-end gap-2"><button type="button" className="erp-toggle-link text-sm" aria-label={'Agregar ' + variantWord + ' a ' + row.group.displayName} onClick={() => openAddVariantForm(fullGroupFor(row.group))}>+ Agregar {variantWord}</button><button type="button" className="data-grid-icon-button" aria-label={(isGroupExpanded(row.group) ? 'Contraer' : 'Expandir') + ' fila de ' + row.group.displayName} onClick={() => toggleGroup(row.group)}>{isGroupExpanded(row.group) ? <CaretDown size={16} /> : <CaretRight size={16} />}</button></div>
        : <div className="flex flex-wrap justify-end gap-x-3"><button type="button" className="erp-toggle-link text-sm" aria-label={'Editar producto ' + row.product.name} onClick={() => openEditForm(row.product)}>Editar</button><button type="button" className="text-sm font-medium text-[color:var(--destructive)] hover:underline" aria-label={'Desactivar producto ' + row.product.name} onClick={() => openDeactivation([row.product.id], true)}>Desactivar</button></div>,
    },
  ];

  const renderModelDetails = (row: InventoryGridRow) => {
    if (row.kind !== 'model' || !isGroupExpanded(row.group)) return null;
    const group = row.group;
    return <div>
      <div className="mb-3 flex items-center justify-between gap-4"><p className="text-xs font-semibold text-[color:var(--muted)]">{variantLabelPlural.charAt(0).toUpperCase() + variantLabelPlural.slice(1)} de {group.displayName}</p><button type="button" className="erp-toggle-link min-h-9 text-sm" aria-label={'Editar modelo ' + group.displayName} onClick={() => openEditModelForm(fullGroupFor(group))}>Editar modelo</button></div>
      <table aria-label={variantLabelPlural + ' de ' + group.displayName}>
        <thead><tr><th scope="col" className="w-12"><span className="sr-only">Selección</span></th><th scope="col">{preset.variantLabel}</th><th scope="col" className="text-right">Disponible</th><th scope="col" className="text-right">Reservado</th><th scope="col" className="text-right">Precio</th><th scope="col" className="text-right">Acciones</th></tr></thead>
        <tbody>{group.products.map((product) => <tr key={product.id} data-selected={selectedCurrentIds.includes(product.id) || undefined}>
          <td><input type="checkbox" aria-label={'Seleccionar ' + variantWord + ' ' + (product.size || 'sin definir') + ' de ' + group.displayName} checked={selectedCurrentIds.includes(product.id)} onChange={() => toggleSelection([product.id])} /></td>
          <td><strong>{product.size || 'Sin definir'}</strong></td><td className="text-right tabular-nums">{product.stockAvailable}</td><td className="text-right tabular-nums">{product.stockReserved}</td><td className="text-right font-medium tabular-nums">{formatCurrency(product.price)}</td>
          <td><div className="flex justify-end gap-4"><button type="button" className="erp-toggle-link min-h-9 text-sm" aria-label={'Editar ' + variantWord + ' ' + (product.size || 'sin definir') + ' de ' + group.displayName} onClick={() => openEditForm(product)}>Editar {variantWord}</button><button type="button" className="min-h-9 text-sm font-medium text-[color:var(--destructive)] hover:underline" aria-label={'Desactivar ' + variantWord + ' ' + (product.size || 'sin definir') + ' de ' + group.displayName} onClick={() => openDeactivation([product.id], true)}>Desactivar</button></div></td>
        </tr>)}</tbody>
      </table>
    </div>;
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
                ? `Seleccioná modelos o ${variantLabelPlural} para acciones en lote. Abrí un modelo para editar sus ${variantLabelPlural}.`
                : 'Seleccioná productos para acciones en lote o editalos desde su fila.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
          <button type="button" className="erp-button-secondary" disabled={saving || savingModel || deleting} onClick={() => setProductFamilyOpen(true)}>Familias y atributos</button>
          <button type="button" className="erp-button-secondary" disabled={saving || savingModel || deleting} onClick={() => setProductFamilyAssignmentOpen(true)}>Familia de un producto</button>
          <button type="button" className="erp-button-secondary" disabled={saving || savingModel || deleting || products.length === 0} onClick={() => setStockSetOpen(true)}>Ajustar conjunto</button>
          <button type="button" onClick={openCreateForm} className="erp-button-primary inline-flex items-center gap-2 self-start">
            + {preset.useVariants ? 'Nuevo modelo' : 'Nuevo producto'}
          </button>
          </div>
        </div>

        <div className="inventory-filters" aria-label="Filtros de inventario">
          <div className="inventory-filter-fields" data-variants={preset.useVariants}>
            <label className="inventory-filter-label">Buscar productos
              <span className="relative"><MagnifyingGlass className="pointer-events-none absolute left-3.5 top-3.5 text-[color:var(--muted)]" size={18} /><input className="erp-input !pl-10" type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={preset.useVariants ? 'Nombre, modelo o ' + variantWord + '…' : 'Nombre o modelo…'} autoComplete="off" /></span>
            </label>
            <label className="inventory-filter-label">{preset.productTypeLabel}
              <select className="erp-input" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label={'Filtrar por ' + preset.productTypeLabel.toLowerCase()}><option value="">Todos</option>{filterOptions.types.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            </label>
            {preset.useVariants && <label className="inventory-filter-label">{preset.variantLabel}
              <select className="erp-input" value={sizeFilter} onChange={(event) => setSizeFilter(event.target.value)} aria-label={'Filtrar por ' + variantWord}><option value="">Todos los {variantLabelPlural}</option>{filterOptions.sizes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            </label>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[color:var(--border)] pt-4">
            <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Filtrar stock">
              <span className="mr-1 text-xs font-semibold text-[color:var(--muted)]">Stock</span>
              <button type="button" className="activity-filter-chip" aria-pressed={!onlyLowStock} onClick={() => onStockFilterChange?.('all')}>Todos</button>
              <button type="button" className="activity-filter-chip" aria-pressed={onlyLowStock} onClick={() => onStockFilterChange?.('low-stock')}>Stock bajo</button>
            </div>
            {hasFilters && <button type="button" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-[color:var(--muted)] hover:text-[color:var(--text)]" onClick={() => { setSearchQuery(''); setSizeFilter(''); setTypeFilter(''); onStockFilterChange?.('all'); }}><X size={16} />Limpiar filtros</button>}
          </div>
        </div>

        {selectedCurrentIds.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color:var(--accent-border)] bg-[color:var(--accent-soft)] px-4 py-3" role="toolbar" aria-label="Acciones de selección">
            <span className="text-sm font-semibold text-[color:var(--text)]">{selectedCurrentIds.length} {preset.useVariants ? selectedCurrentIds.length === 1 ? variantWord : variantLabelPlural : selectedCurrentIds.length === 1 ? 'producto' : 'productos'} {selectedCurrentIds.length === 1 ? 'seleccionado' : 'seleccionados'}</span>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="erp-button-secondary" onClick={() => setSelectedIds([])}>Limpiar selección</button>
              <button type="button" className="erp-button-danger" onClick={() => openDeactivation(selectedCurrentIds, false)}>Desactivar seleccionados</button>
            </div>
          </div>
        )}

        <DataGrid<InventoryGridRow>
          label="Grilla de productos"
          storageKey={preset.useVariants ? 'erpvoice.products-grid.variants.v2' : 'erpvoice.products-grid.flat.v2'}
          columns={gridColumns}
          sections={gridSections}
          getRowId={(row) => row.kind === 'model' ? row.group.key : row.product.id}
          getRowLabel={(row) => row.kind === 'model' ? 'modelo ' + row.group.displayName : 'producto ' + row.product.name}
          getRowSelection={selectionFor}
          onToggleRows={(rows) => toggleSelection(rows.flatMap((row) => rowProducts(row).map((product) => product.id)))}
          renderExpandedRow={renderModelDetails}
          toolbar={<><span className="text-xs text-[color:var(--muted)]">{priceCurrency ? `Precios en ${priceCurrency} · unidades enteras` : <a href="/studio.html">Configurar moneda del negocio</a>}</span><label className="flex items-center gap-3 text-sm font-medium text-[color:var(--muted)]">Agrupar por
            <select className="erp-input !w-auto !min-w-36" value={grouping} onChange={(event) => setGroupBy(event.target.value as InventoryGrouping)}>
              {preset.useVariants && <option value="model">Modelo</option>}
              {preset.useVariants && <option value="size">{preset.variantLabel}</option>}
              <option value="productType">{preset.productTypeLabel}</option><option value="none">Sin agrupar</option>
            </select>
          </label><span className="text-xs text-[color:var(--muted)]">{grouping === 'model' ? filteredGroups.length + (filteredGroups.length === 1 ? ' modelo' : ' modelos') + ' · ' : ''}{flatProducts.length} de {products.length} productos</span></>}
          emptyState={products.length === 0 ? 'No hay productos cargados todavía.' : <div><p>No hay productos que coincidan con los filtros.</p><button type="button" className="erp-toggle-link mt-2" onClick={() => { setSearchQuery(''); setSizeFilter(''); setTypeFilter(''); onStockFilterChange?.('all'); }}>Limpiar filtros</button></div>}
          footer={<span>{flatProducts.length} productos visibles · {flatProducts.reduce((total, product) => total + product.stockAvailable, 0).toLocaleString('es-AR')} unidades disponibles{sizeFilter && ' · ' + (preset.variantLabel || 'Variante') + ': ' + (filterOptions.sizes.find((option) => option.value === sizeFilter)?.label || 'Sin definir')}</span>}
        />

        {isFormOpen && preset.useVariants && !editingProductId && !addingToGroup && (
          <NewModelModal
            currency={priceCurrency}
            draft={draft}
            variants={newVariants}
            preset={preset}
            onDraftChange={(nextDraft) => { if (formBusy.current) return; createOperation.current = null; setDraft(nextDraft); setFormError(null); }}
            onVariantsChange={(nextVariants) => { if (formBusy.current) return; createOperation.current = null; setNewVariants(nextVariants); setFormError(null); }}
            onClose={() => { if (!formBusy.current) setIsFormOpen(false); }}
            onSubmit={handleCreateModel}
            saving={saving}
            error={formError}
          />
        )}

        {productFamilyOpen && <ProductFamilyPanel onClose={() => setProductFamilyOpen(false)} />}
        {productFamilyAssignmentOpen && <ProductFamilyAssignmentPanel onClose={() => setProductFamilyAssignmentOpen(false)} />}

        {isFormOpen && (!preset.useVariants || Boolean(editingProductId || addingToGroup)) && (
          <ProductFormModal
            currency={priceCurrency}
            title={editingProductId ? preset.useVariants ? `Editar ${variantWord}` : 'Editar producto' : addingToGroup ? `Agregar ${variantWord}` : preset.useVariants ? 'Nuevo modelo' : 'Nuevo producto'}
            description={addingToGroup
              ? `Modelo: ${addingToGroup.displayName}. Precio sugerido del primer ${variantWord}.`
              : editingProductId && preset.useVariants ? `Modelo: ${[draft.productType, draft.productModel].filter(Boolean).join(' ') || draft.name}. Acá editás solo este ${variantWord}.`
              : preset.useVariants && !editingProductId ? `Cargá el modelo y su primer ${variantWord}. Si ya existe, agregá el ${variantWord} desde su tarjeta.` : undefined}
            draft={draft}
            onDraftChange={(nextDraft) => { if (formBusy.current) return; createOperation.current = null; setDraft(nextDraft); setFormError(null); }}
            onClose={() => { if (!formBusy.current) setIsFormOpen(false); }}
            onSubmit={handleSubmit}
            submitLabel={editingProductId ? 'Guardar cambios' : addingToGroup ? `Agregar ${variantWord}` : preset.useVariants ? 'Crear modelo' : 'Crear producto'}
            submitting={saving}
            preset={preset}
            variantOnly={preset.useVariants && Boolean(editingProductId || addingToGroup)}
            showReserved={Boolean(editingProductId) || !preset.useVariants}
            requireVariant={preset.useVariants && !editingProductId}
            error={formError}
            adjustmentReason={adjustmentReason}
            onAdjustmentReasonChange={editingProductId ? (reason) => { setAdjustmentReason(reason); setFormError(null); } : undefined}
          />
        )}

        {editingGroup && <ModelFormModal
          group={editingGroup}
          preset={preset}
          productType={modelDraft.productType}
          productModel={modelDraft.productModel}
          onChange={(nextDraft) => { setModelDraft(nextDraft); invalidateModelPreview(); }}
          onClose={() => setEditingGroup(null)}
          onSubmit={handleModelSubmit}
          saving={savingModel}
          error={modelError}
          reason={modelReason}
          onReasonChange={(reason) => { setModelReason(reason); invalidateModelPreview(); }}
          preview={modelPreview}
          stale={modelStale}
          onRefreshPreview={() => { void handleModelSubmit(true); }}
        />}

        {stockSetOpen && <StockSetAdjustmentForm onClose={() => setStockSetOpen(false)} />}

        {deactivation && <DeactivateModal
          ids={deactivation.ids}
          reason={deactivationReason}
          onReasonChange={(reason) => { setDeactivationReason(reason); invalidateDeactivationPreview(); }}
          preview={deactivationPreview}
          stale={deactivationStale}
          error={deactivationError}
          busy={deleting}
          onCancel={() => setDeactivation(null)}
          onSubmit={handleDeactivation}
        />}
      </article>
    </div>
  );
}
