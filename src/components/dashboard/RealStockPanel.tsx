import { useInventory } from '../../hooks/useInventory';

const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;

export function RealStockPanel() {
  const { products } = useInventory();

  const totalUnits = products.reduce((total, product) => total + product.stockAvailable + product.stockReserved, 0);
  const totalValue = products.reduce((total, product) => total + (product.stockAvailable + product.stockReserved) * product.price, 0);

  return (
    <article className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-bold text-slate-900">Stock Real</h3>
          <p className="mt-1 text-xs text-slate-500">Datos persistidos desde la base local</p>
        </div>
        <div className="rounded-2xl bg-white px-3 py-2 text-right shadow-sm">
          <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Unidades</p>
          <p className="font-display text-xl font-bold text-slate-900">{totalUnits}</p>
        </div>
      </div>

      <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>Valor total inventario</span>
          <span className="font-semibold text-slate-900">{formatCurrency(totalValue)}</span>
        </div>
        <div className="mt-3 space-y-3">
          {products.map((product) => {
            const realStock = product.stockAvailable + product.stockReserved;

            return (
              <div key={product.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-900">{product.name}</p>
                    <p className="mt-1 text-xs text-slate-500">Precio unitario: {formatCurrency(product.price)}</p>
                  </div>
                  <p className="text-right text-sm font-semibold text-slate-900">{realStock} total</p>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-600">
                  <div className="rounded-xl bg-white px-3 py-2 shadow-sm">
                    <span className="block text-slate-400">Disponible</span>
                    <span className="font-semibold text-emerald-700">{product.stockAvailable}</span>
                  </div>
                  <div className="rounded-xl bg-white px-3 py-2 shadow-sm">
                    <span className="block text-slate-400">Reservado</span>
                    <span className="font-semibold text-amber-700">{product.stockReserved}</span>
                  </div>
                  <div className="rounded-xl bg-white px-3 py-2 shadow-sm">
                    <span className="block text-slate-400">Valor</span>
                    <span className="font-semibold text-slate-900">{formatCurrency(realStock * product.price)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}