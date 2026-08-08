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

  const totalUnits = summary.totalAvailable + summary.totalReserved;

  return (
    <article className="erp-panel">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
        <h3 className="font-display text-xl font-bold text-slate-100">Stock</h3>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <article className="min-h-[144px] rounded-[1.35rem] border border-sky-500/10 bg-[#0c1426] p-5 shadow-lg shadow-sky-950/20">
          <p className="text-[15px] font-medium text-slate-400">Stock Disponible</p>
          <div className="mt-10">
            <p className="font-display text-[2rem] font-bold tracking-tight text-sky-400">{summary.totalAvailable}</p>
            <p className="text-sm text-slate-400">unidades listas para venta</p>
          </div>
        </article>

        <article className="min-h-[144px] rounded-[1.35rem] border border-sky-500/10 bg-[#0c1426] p-5 shadow-lg shadow-sky-950/20">
          <p className="text-[15px] font-medium text-slate-400">Stock Reservado</p>
          <div className="mt-10">
            <p className="font-display text-[2rem] font-bold tracking-tight text-cyan-400">{summary.totalReserved}</p>
            <p className="text-sm text-slate-400">unidades apartadas</p>
          </div>
        </article>

        <article className="min-h-[144px] rounded-[1.35rem] border border-sky-500/10 bg-[#0c1426] p-5 shadow-lg shadow-sky-950/20">
          <p className="text-[15px] font-medium text-slate-400">Valor Total</p>
          <div className="mt-10">
            <p className="font-display text-[2rem] font-bold tracking-tight text-slate-100">{formatCurrency(summary.totalValue)}</p>
            <p className="text-sm text-slate-400">inventario valorizado</p>
          </div>
        </article>
      </div>

      <article className="mt-4 rounded-[1.5rem] border border-sky-500/10 bg-[#0c1426] p-5 shadow-lg shadow-sky-950/20">
        <h4 className="text-[1.05rem] font-bold text-slate-100">Stock por Categoria</h4>

        <div className="mt-5 flex flex-wrap gap-3">
          {summary.categories.map((category) => (
            <div key={category.name} className="min-w-[140px] rounded-xl border border-sky-500/10 bg-[#0a1222] px-4 py-3 shadow-sm shadow-sky-950/20">
              <p className="text-sm font-semibold text-slate-100">{category.name}</p>
              <p className="mt-1 text-xs text-slate-400">{category.count} SKUs / {category.units} unidades</p>
              <p className="mt-1 text-sm font-semibold text-sky-300">{formatCurrency(category.value)}</p>
            </div>
          ))}
        </div>
      </article>

      <article className="mt-4 rounded-[1.5rem] border border-sky-500/10 bg-[#0c1426] p-5 shadow-lg shadow-sky-950/20">
        <h4 className="text-[1.05rem] font-bold text-slate-100">Inventario Completo</h4>

        <div className="mt-5 overflow-x-auto">
          {products.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-6 text-sm text-slate-400">
              No hay inventario cargado.
            </div>
          ) : (
          <table className="min-w-full border-separate border-spacing-0">
            <thead>
              <tr className="text-left text-sm font-semibold text-slate-300">
                <th className="border-b border-white/10 px-3 py-3">Producto</th>
                <th className="border-b border-white/10 px-3 py-3">Tipo</th>
                <th className="border-b border-white/10 px-3 py-3 text-center">Talle</th>
                <th className="border-b border-white/10 px-3 py-3 text-center">Disponible</th>
                <th className="border-b border-white/10 px-3 py-3 text-center">Reservado</th>
                <th className="border-b border-white/10 px-3 py-3 text-center">Precio</th>
                <th className="border-b border-white/10 px-3 py-3 text-center">Valor</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const realStock = product.stockAvailable + product.stockReserved;

                return (
                  <tr key={product.id} className="text-[15px] text-slate-100">
                    <td className="border-b border-white/10 px-3 py-4 font-semibold">{product.name}</td>
                    <td className="border-b border-white/10 px-3 py-4">
                      <span className="inline-flex rounded-full border border-sky-500/10 bg-[#0a1222] px-2.5 py-1 text-xs font-medium text-slate-300">
                        {formatCategoryLabel(product.productType)}
                      </span>
                    </td>
                    <td className="border-b border-white/10 px-3 py-4 text-center font-semibold">{product.size ?? '-'}</td>
                    <td className="border-b border-white/10 px-3 py-4 text-center font-semibold text-sky-300">{product.stockAvailable}</td>
                    <td className="border-b border-white/10 px-3 py-4 text-center font-semibold text-cyan-300">{product.stockReserved}</td>
                    <td className="border-b border-white/10 px-3 py-4 text-center font-mono font-semibold">{formatCurrency(product.price)}</td>
                    <td className="border-b border-white/10 px-3 py-4 text-center font-mono font-semibold text-slate-100">{formatCurrency(realStock * product.price)}</td>
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