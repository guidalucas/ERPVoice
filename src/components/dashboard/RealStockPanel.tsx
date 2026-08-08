import { useMemo } from 'react';
import { useInventory } from '../../hooks/useInventory';

const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;

function formatCategoryLabel(value: string | null | undefined) {
  const label = (value ?? '').trim();

  if (!label) {
    return 'Sin tipo';
  }

  return label;
}

export function RealStockPanel({ filterProductIds }: { filterProductIds?: string[] } = {}) {
  const { products: allProducts } = useInventory();
  const products = useMemo(() => {
    if (!filterProductIds) {
      return allProducts;
    }
    const allowed = new Set(filterProductIds);
    return allProducts.filter((product) => allowed.has(product.id));
  }, [allProducts, filterProductIds]);

  const summary = useMemo(() => {
    const totalAvailable = products.reduce((total, product) => total + product.stockAvailable, 0);
    const totalReserved = products.reduce((total, product) => total + product.stockReserved, 0);
    const totalValue = products.reduce((total, product) => total + (product.stockAvailable + product.stockReserved) * product.price, 0);

    const categories = products.reduce<Record<string, { units: number; value: number; count: number }>>((accumulator, product) => {
      const category = formatCategoryLabel(product.productType);
      const current = accumulator[category] ?? { units: 0, value: 0, count: 0 };

      current.units += product.stockAvailable + product.stockReserved;
      current.value += (product.stockAvailable + product.stockReserved) * product.price;
      current.count += 1;
      accumulator[category] = current;
      return accumulator;
    }, {});

    return {
      totalAvailable,
      totalReserved,
      totalValue,
      categories: Object.entries(categories)
        .map(([name, data]) => ({ name, ...data }))
        .sort((left, right) => right.units - left.units),
    };
  }, [products]);

  return (
    <article className="erp-panel">
      <div className="flex items-center justify-between gap-3 border-b pb-4" style={{ borderColor: 'var(--border)' }}>
        <h3 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">Stock</h3>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <article className="erp-card min-h-[144px] border-sky-500/10 p-5">
          <p className="text-[15px] font-medium text-slate-600 dark:text-slate-400">Stock Disponible</p>
          <div className="mt-10">
            <p className="font-display text-[2rem] font-bold tracking-tight text-sky-600 dark:text-sky-400">{summary.totalAvailable}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">unidades listas para venta</p>
          </div>
        </article>

        <article className="erp-card min-h-[144px] border-sky-500/10 p-5">
          <p className="text-[15px] font-medium text-slate-600 dark:text-slate-400">Stock Reservado</p>
          <div className="mt-10">
            <p className="font-display text-[2rem] font-bold tracking-tight text-cyan-600 dark:text-cyan-400">{summary.totalReserved}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">unidades apartadas</p>
          </div>
        </article>

        <article className="erp-card min-h-[144px] border-sky-500/10 p-5">
          <p className="text-[15px] font-medium text-slate-600 dark:text-slate-400">Valor Total</p>
          <div className="mt-10">
            <p className="font-display text-[2rem] font-bold tracking-tight text-slate-900 dark:text-slate-100">{formatCurrency(summary.totalValue)}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">inventario valorizado</p>
          </div>
        </article>
      </div>

      <article className="erp-card mt-4 border-sky-500/10 p-5">
        <h4 className="text-[1.05rem] font-bold text-slate-900 dark:text-slate-100">Stock por Categoria</h4>

        <div className="mt-5 flex flex-wrap gap-3">
          {summary.categories.map((category) => (
            <div key={category.name} className="min-w-[140px] rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border)', background: 'var(--surface-elevated)' }}>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{category.name}</p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                {category.count} SKUs / {category.units} unidades
              </p>
              <p className="mt-1 text-sm font-semibold text-sky-700 dark:text-sky-300">{formatCurrency(category.value)}</p>
            </div>
          ))}
        </div>
      </article>

      <article className="erp-card mt-4 border-sky-500/10 p-5">
        <h4 className="text-[1.05rem] font-bold text-slate-900 dark:text-slate-100">Inventario Completo</h4>

        <div className="mt-5 overflow-x-auto">
          {products.length === 0 ? (
            <div className="rounded-2xl border px-4 py-6 text-sm text-slate-600 dark:text-slate-400" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
              No hay inventario cargado.
            </div>
          ) : (
            <table className="min-w-full border-separate border-spacing-0">
              <thead>
                <tr className="text-left text-sm font-semibold text-slate-700 dark:text-slate-300">
                  <th className="border-b px-3 py-3" style={{ borderColor: 'var(--border)' }}>
                    Producto
                  </th>
                  <th className="border-b px-3 py-3" style={{ borderColor: 'var(--border)' }}>
                    Tipo
                  </th>
                  <th className="border-b px-3 py-3 text-center" style={{ borderColor: 'var(--border)' }}>
                    Talle
                  </th>
                  <th className="border-b px-3 py-3 text-center" style={{ borderColor: 'var(--border)' }}>
                    Disponible
                  </th>
                  <th className="border-b px-3 py-3 text-center" style={{ borderColor: 'var(--border)' }}>
                    Reservado
                  </th>
                  <th className="border-b px-3 py-3 text-center" style={{ borderColor: 'var(--border)' }}>
                    Precio
                  </th>
                  <th className="border-b px-3 py-3 text-center" style={{ borderColor: 'var(--border)' }}>
                    Valor
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => {
                  const realStock = product.stockAvailable + product.stockReserved;

                  return (
                    <tr key={product.id} className="text-[15px] text-slate-800 dark:text-slate-100">
                      <td className="border-b px-3 py-4 font-semibold" style={{ borderColor: 'var(--border)' }}>
                        {product.name}
                      </td>
                      <td className="border-b px-3 py-4" style={{ borderColor: 'var(--border)' }}>
                        <span className="inline-flex rounded-full border px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
                          {formatCategoryLabel(product.productType)}
                        </span>
                      </td>
                      <td className="border-b px-3 py-4 text-center font-semibold" style={{ borderColor: 'var(--border)' }}>
                        {product.size ?? '-'}
                      </td>
                      <td className="border-b px-3 py-4 text-center font-semibold text-sky-700 dark:text-sky-300" style={{ borderColor: 'var(--border)' }}>
                        {product.stockAvailable}
                      </td>
                      <td className="border-b px-3 py-4 text-center font-semibold text-cyan-700 dark:text-cyan-300" style={{ borderColor: 'var(--border)' }}>
                        {product.stockReserved}
                      </td>
                      <td className="border-b px-3 py-4 text-center font-mono font-semibold" style={{ borderColor: 'var(--border)' }}>
                        {formatCurrency(product.price)}
                      </td>
                      <td className="border-b px-3 py-4 text-center font-mono font-semibold text-slate-800 dark:text-slate-100" style={{ borderColor: 'var(--border)' }}>
                        {formatCurrency(realStock * product.price)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </article>
    </article>
  );
}
