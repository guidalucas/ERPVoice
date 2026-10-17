import { useMemo, useRef, useState } from 'react';
import type { ParsedActionUnion, Product } from '../../domain/types';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';
import { toUserFacingError } from '../../services/apiClient';

export type StockMovementMode = 'ingreso' | 'venta';

type StockMovementModalProps = {
  mode: StockMovementMode;
  products: Product[];
  onClose: () => void;
  onSubmit: (sourceText: string, actions: ParsedActionUnion[], operationId?: string) => Promise<void>;
};

const normalizeSearch = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();

const productLabel = (product: Product, includeSize: boolean) => {
  const parts = includeSize
    ? [product.productType, product.productModel, product.size]
    : [product.productType, product.productModel];
  const meta = parts.filter(Boolean).join(' ');
  return meta || product.name;
};

export function StockMovementModal({ mode, products, onClose, onSubmit }: StockMovementModalProps) {
  const preset = useBusinessCategoryPreset();
  const isIngreso = mode === 'ingreso';
  const includeSize = !isIngreso || preset.useVariants;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [qtyText, setQtyText] = useState('1');
  const [salePriceText, setSalePriceText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<{ key: string; id: string } | null>(null);
  const inFlightRef = useRef(false);

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === selectedProductId) ?? null,
    [products, selectedProductId],
  );

  const filteredProducts = useMemo(() => {
    const normalizedQuery = normalizeSearch(searchQuery);
    const sorted = [...products].sort((a, b) =>
      productLabel(a, includeSize).localeCompare(productLabel(b, includeSize), 'es', { sensitivity: 'base' }),
    );

    if (!normalizedQuery) {
      return sorted.slice(0, 40);
    }

    return sorted
      .filter((product) => {
        const haystack = normalizeSearch(
          [product.name, product.productType, product.productModel, includeSize ? product.size : null]
            .filter(Boolean)
            .join(' '),
        );
        return haystack.includes(normalizedQuery);
      })
      .slice(0, 40);
  }, [products, searchQuery, includeSize]);

  const qty = Number(qtyText);
  const qtyValid = Number.isSafeInteger(qty) && qty > 0;
  const hasSalePrice = salePriceText.trim() !== '';
  const salePrice = Number(salePriceText);
  const salePriceValid = !hasSalePrice || (Number.isSafeInteger(salePrice) && salePrice >= 0);
  const exceedsStock = !isIngreso && selectedProduct != null && qtyValid && qty > selectedProduct.stockAvailable;
  const canSubmit = Boolean(selectedProduct) && qtyValid && (isIngreso || salePriceValid) && !exceedsStock && !submitting;

  const handleSubmit = async () => {
    if (inFlightRef.current) return;
    if (!selectedProduct || !qtyValid) {
      setError('Elegí un producto y una cantidad válida.');
      return;
    }

    if (!isIngreso && qty > selectedProduct.stockAvailable) {
      setError(`Stock insuficiente. Disponible: ${selectedProduct.stockAvailable}.`);
      return;
    }

    if (!isIngreso && !salePriceValid) {
      setError('El precio de venta debe ser un entero seguro mayor o igual a cero.');
      return;
    }

    setError(null);
    setSubmitting(true);
    inFlightRef.current = true;

    const action: ParsedActionUnion = isIngreso
      ? {
          type: 'add_stock',
          productId: selectedProduct.id,
          expectedFingerprint: selectedProduct.identityFingerprint,
          unit: selectedProduct.unit ?? 'unit',
          priceCurrency: selectedProduct.priceCurrency ?? 'XXX',
          productName: selectedProduct.name,
          productType: selectedProduct.productType ?? undefined,
          productModel: selectedProduct.productModel ?? undefined,
          size: selectedProduct.size ?? undefined,
          qty,
          price: selectedProduct.price,
        }
      : {
          type: 'sell',
          productId: selectedProduct.id,
          expectedFingerprint: selectedProduct.identityFingerprint,
          unit: selectedProduct.unit ?? 'unit',
          priceCurrency: selectedProduct.priceCurrency ?? 'XXX',
          productName: selectedProduct.name,
          productType: selectedProduct.productType ?? undefined,
          productModel: selectedProduct.productModel ?? undefined,
          size: selectedProduct.size ?? undefined,
          qty,
          ...(hasSalePrice ? { price: salePrice } : {}),
        };

    const sourceText = isIngreso
      ? `Ingreso manual: +${qty} ${productLabel(selectedProduct, includeSize)}`
      : `Venta manual: -${qty} ${productLabel(selectedProduct, includeSize)}`;

    try {
      const key = JSON.stringify({ sourceText, action });
      if (requestRef.current?.key !== key) requestRef.current = { key, id: crypto.randomUUID() };
      await onSubmit(sourceText, [action], requestRef.current.id);
      onClose();
    } catch (submitError) {
      setError(toUserFacingError(submitError, 'No se pudo registrar el movimiento. Reintentá.'));
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const searchLabel =
    preset.useVariants && preset.variantLabel
      ? `Buscar producto + ${preset.variantLabel.toLowerCase()}`
      : 'Buscar producto';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-label={isIngreso ? 'Registrar ingreso' : 'Registrar venta'} className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-y-auto rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-[color:var(--text)] shadow-2xl shadow-black/70">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="type-title text-[1.55rem] leading-none text-[color:var(--text)]">
              {isIngreso ? 'Registrar ingreso' : 'Registrar venta'}
            </h4>
            <p className="mt-2 text-sm text-[color:var(--muted)]">
              {isIngreso ? 'Suma stock disponible al producto elegido.' : 'Resta del stock disponible (sin tocar reservado).'}
            </p>
          </div>
          <button type="button" aria-label="Cerrar modal" className="erp-button-secondary h-8 w-8 px-0" onClick={onClose}>
            ×
          </button>
        </div>

        <label className="mt-5 block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
          {searchLabel}
          <input
            className="erp-input h-11 rounded-xl text-[15px]"
            placeholder="Ej: producto..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            autoFocus
          />
        </label>

        <div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-xl border border-[color:var(--border)] bg-[color:var(--overlay-soft)] p-2">
          {filteredProducts.length === 0 ? (
            <p className="px-2 py-3 text-sm text-[color:var(--muted)]">No hay productos que coincidan.</p>
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
                      ? 'border border-[color:var(--accent-border)] bg-[color:var(--accent-soft)] text-[color:var(--text)]'
                      : 'border border-transparent text-[color:var(--text)] hover:bg-[color:var(--card-hover)]'
                  }`}
                >
                  <span className="type-body-strong">{productLabel(product, includeSize)}</span>
                  <span className="type-metric shrink-0 text-xs text-[color:var(--muted)]">{product.stockAvailable} disp.</span>
                </button>
              );
            })
          )}
        </div>

        <label className="mt-4 block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
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

        {!isIngreso && (
          <label className="mt-4 block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
            Precio de venta unitario (opcional)
            <input
              className="erp-input h-11 rounded-xl text-[15px]"
              type="number"
              min={0}
              step={1}
              value={salePriceText}
              onChange={(event) => {
                setSalePriceText(event.target.value);
                setError(null);
              }}
              aria-invalid={!salePriceValid}
              placeholder="Sin precio registrado"
            />
            <span className="block text-xs text-[color:var(--muted)]">Dejalo vacío si no conocés el precio de esta venta.</span>
            {!salePriceValid && <span className="block text-xs text-rose-700 dark:text-rose-200">Ingresá un entero seguro mayor o igual a cero.</span>}
          </label>
        )}

        {selectedProduct && (
          <p className="mt-2 text-xs text-[color:var(--muted)]">
            Seleccionado:{' '}
            <span className="text-[color:var(--text)]">{productLabel(selectedProduct, includeSize)}</span>
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
