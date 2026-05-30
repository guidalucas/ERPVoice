import { useInventory } from '../../hooks/useInventory';

const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;

export function DashboardPanel() {
  const { products, clients, transactions } = useInventory();

  return (
    <section className="flex h-full flex-col gap-4 rounded-[2rem] border border-slate-200 bg-white/85 p-5 shadow-glow backdrop-blur-sm">
      <header className="rounded-[1.5rem] bg-slate-950 px-6 py-5 text-white">
        <p className="text-xs uppercase tracking-[0.35em] text-cyan-300">Dashboard Web</p>
        <h2 className="font-display text-2xl font-bold">Estado en tiempo real</h2>
      </header>

      <div className="grid gap-4 xl:grid-cols-3">
        <article className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
          <h3 className="font-display text-lg font-bold text-slate-900">Inventario Actual</h3>
          <div className="mt-4 space-y-3">
            {products.map((product) => (
              <div key={product.id} className="rounded-2xl bg-white p-3 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-900">{product.name}</p>
                    <p className="text-xs text-slate-500">Precio: {formatCurrency(product.price)}</p>
                  </div>
                  <p className="text-right text-sm font-semibold text-emerald-600">{product.stockAvailable} disponibles</p>
                </div>
                <p className="mt-2 text-xs text-slate-500">Reservado: {product.stockReserved}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
          <h3 className="font-display text-lg font-bold text-slate-900">Cuentas Corrientes</h3>
          <div className="mt-4 space-y-3">
            {clients.map((client) => (
              <div key={client.id} className="rounded-2xl bg-white p-3 shadow-sm">
                <p className="font-semibold text-slate-900">{client.name}</p>
                <p className="mt-2 text-sm text-rose-600">Deuda actual: {formatCurrency(client.debt)}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
          <h3 className="font-display text-lg font-bold text-slate-900">Últimos Movimientos</h3>
          <div className="mt-4 space-y-3">
            {transactions.length === 0 ? (
              <div className="rounded-2xl bg-white p-4 text-sm text-slate-500 shadow-sm">Todavía no hay transacciones confirmadas.</div>
            ) : (
              transactions.map((transaction) => (
                <div key={transaction.id} className="rounded-2xl bg-white p-3 shadow-sm">
                  <p className="text-sm font-semibold text-slate-900">{transaction.summary}</p>
                  <p className="mt-1 text-xs text-slate-500">{new Date(transaction.timestamp).toLocaleString('es-AR')}</p>
                </div>
              ))
            )}
          </div>
        </article>
      </div>
    </section>
  );
}