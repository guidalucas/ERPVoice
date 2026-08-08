import { useMemo, useState } from 'react';
import type { ParsedActionUnion, Product } from '../../domain/types';
import { toUserFacingError } from '../../services/apiClient';

export type StockMovementMode = 'ingreso' | 'venta';

type StockMovementModalProps = {
  mode: StockMovementMode;
  products: Product[];
  onClose: () => void;
  onSubmit: (sourceText: string, actions: ParsedActionUnion[]) => Promise<void>;
};

const normalizeSearch = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();

const productLabel = (product: Product) => {
  const meta = [product.productType, product.productModel, product.size].filter(Boolean).join(' ');
  return meta || product.name;
};

export function StockMovementModal({ mode, products, onClose, onSubmit }: StockMovementModalProps) {
  const isIngreso = mode === 'ingreso';
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [qtyText, setQtyText] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === selectedProductId) ?? null,
    [products, selectedProductId],
  );

  const filteredProducts = useMemo(() => {
    const normalizedQuery = normalizeSearch(searchQuery);
    const sorted = [...products].sort((a, b) => productLabel(a).localeCompare(productLabel(b), 'es', { sensitivity: 'base' }));

    if (!normalizedQuery) {
      return sorted.slice(0, 40);
    }

    return sorted
      .filter((product) => {
        const haystack = normalizeSearch([product.name, product.productType, product.productModel, product.size].filter(Boolean).join(' '));
        return haystack.includes(normalizedQuery);
      })
      .slice(0, 40);
  }, [products, searchQuery]);

  const qty = Number(qtyText);
  const qtyValid = Number.isFinite(qty) && qty > 0 && Number.isInteger(qty);
  const exceedsStock = !isIngreso && selectedProduct != null && qtyValid && qty > selectedProduct.stockAvailable;
  const canSubmit = Boolean(selectedProduct) && qtyValid && !exceedsStock && !submitting;

  const handleSubmit = async () => {
    if (!selectedProduct || !qtyValid) {
      setError('Elegí un producto y una cantidad válida.');
      return;
    }

    if (!isIngreso && qty > selectedProduct.stockAvailable) {
      setError(`Stock insuficiente. Disponible: ${selectedProduct.stockAvailable}.`);
      return;
    }

    setError(null);
    setSubmitting(true);

    const action: ParsedActionUnion = isIngreso
      ? {
          type: 'add_stock',
          productName: selectedProduct.name,
          productType: selectedProduct.productType ?? undefined,
          productModel: selectedProduct.productModel ?? undefined,
          size: selectedProduct.size ?? undefined,
          qty,
          price: selectedProduct.price,
        }
      : {
          type: 'sell',
          productName: selectedProduct.name,
          productType: selectedProduct.productType ?? undefined,
          productModel: selectedProduct.productModel ?? undefined,
          size: selectedProduct.size ?? undefined,
          qty,
          price: selectedProduct.price,
        };

    const sourceText = isIngreso
      ? `Ingreso manual: +${qty} ${productLabel(selectedProduct)}`
      : `Venta manual: -${qty} ${productLabel(selectedProduct)}`;

    try {
      await onSubmit(sourceText, [action]);
      onClose();
    } catch (submitError) {
      setError(toUserFacingError(submitError, 'No se pudo registrar el movimiento. Reintentá.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-slate-900 shadow-2xl shadow-black/70 dark:text-slate-100">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-[1.55rem] font-bold leading-none text-slate-900 dark:text-slate-100">
              {isIngreso ? 'Registrar ingreso' : 'Registrar venta'}
            </h4>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              {isIngreso ? 'Suma stock disponible al producto elegido.' : 'Resta del stock disponible (sin tocar reservado).'}
            </p>
          </div>
          <button type="button" aria-label="Cerrar modal" className="erp-button-secondary h-8 w-8 px-0" onClick={onClose}>
            ×
          </button>
        </div>

        <label className="mt-5 block space-y-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">
          Buscar producto + talle
          <input
            className="erp-input h-11 rounded-xl text-[15px]"
            placeholder="Ej: Boca titular M"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            autoFocus
          />
        </label>

        <div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-xl border border-[color:var(--border)] bg-[color:var(--overlay-soft)] p-2">
          {filteredProducts.length === 0 ? (
            <p className="px-2 py-3 text-sm text-slate-500 dark:text-slate-400">No hay productos que coincidan.</p>
          ) : (
            filteredProducts.map((product) => {
              const selected = product.id === selectedProductId;
              return (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => {
                    setSelectedProductId(product.id);
                    setError(null);
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                    selected
                      ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-100'
                      : 'border border-transparent text-slate-800 hover:bg-slate-900/5 dark:text-slate-200 dark:hover:bg-white/5'
                  }`}
                >
                  <span className="font-medium">{productLabel(product)}</span>
                  <span className="shrink-0 text-xs text-slate-600 dark:text-slate-400">{product.stockAvailable} disp.</span>
                </button>
              );
            })
          )}
        </div>

        <label className="mt-4 block space-y-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">
          Cantidad
          <input
            className="erp-input h-11 rounded-xl text-[15px]"
            type="number"
            min={1}
            step={1}
            value={qtyText}
            onChange={(event) => {
              setQtyText(event.target.value);
              setError(null);
            }}
          />
        </label>

        {selectedProduct && (
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
            Seleccionado: <span className="text-slate-800 dark:text-slate-200">{productLabel(selectedProduct)}</span>
            {!isIngreso && ` · Disponible: ${selectedProduct.stockAvailable}`}
          </p>
        )}

        {exceedsStock && (
          <p className="mt-2 text-sm text-amber-600 dark:text-amber-300">
            La cantidad supera el stock disponible ({selectedProduct?.stockAvailable}).
          </p>
        )}

        {error && (
          <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2.5">
            <p className="text-sm text-rose-700 dark:text-rose-200">{error}</p>
            <p className="mt-1 text-xs text-rose-700/80 dark:text-rose-200/80">Podés corregir y volver a confirmar.</p>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="erp-button-secondary min-h-11" disabled={submitting}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className={`${isIngreso ? 'erp-button-primary' : 'erp-button-danger'} min-h-11`}
          >
            {submitting ? 'Guardando...' : error ? (isIngreso ? 'Reintentar ingreso' : 'Reintentar venta') : isIngreso ? '+ Confirmar ingreso' : '− Confirmar venta'}
          </button>
        </div>
      </div>
    </div>
  );
}
