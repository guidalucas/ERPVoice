import { useState } from 'react';
import { BUSINESS_CATEGORIES, type BusinessCategoryId } from '../../domain/businessCategories';
import { useAuth } from '../../store/AuthStore';
import { StockyLogo } from '../brand/StockyLogo';
import { ThemeToggle } from '../dashboard/ThemeToggle';

export function BusinessSetupPanel() {
  const { completeOnboarding, logout, session } = useAuth();
  const [businessName, setBusinessName] = useState(session?.businessName ?? '');
  const [businessCategory, setBusinessCategory] = useState<BusinessCategoryId | null>(
    session?.businessCategory ?? null,
  );
  const [statusText, setStatusText] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setStatusText(null);

    try {
      const trimmedName = businessName.trim();

      if (!trimmedName) {
        setStatusText('Ingresá el nombre de tu emprendimiento.');
        return;
      }

      if (!businessCategory) {
        setStatusText('Elegí una categoría para tu negocio.');
        return;
      }

      await completeOnboarding({
        businessName: trimmedName,
        businessCategory,
      });
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'No pudimos guardar tu configuración.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-mesh-soft-light px-4 py-8 text-slate-900 dark:bg-mesh-soft dark:text-slate-100">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl items-center justify-center">
        <div className="erp-shell w-full p-6">
          <div className="rounded-[1.5rem] border p-6" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <StockyLogo size="lg" />
                <div>
                  <p className="text-xs uppercase tracking-[0.35em] text-emerald-600 dark:text-emerald-300">Stocky Setup</p>
                  <h1 className="mt-1 font-display text-2xl font-bold text-slate-900 dark:text-white">Configurá tu negocio</h1>
                </div>
              </div>
              <ThemeToggle />
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Elegí el nombre de tu emprendimiento y el rubro. Eso adapta los campos del stock (por ejemplo talles, medidas o solo nombre).
            </p>

            <div className="mt-6 space-y-5">
              <label className="block space-y-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
                Nombre de tu emprendimiento
                <input
                  value={businessName}
                  onChange={(event) => setBusinessName(event.target.value)}
                  placeholder="Ej: FullMatch, Kiosco Don Pepe…"
                  className="erp-input h-12 text-[15px]"
                  autoComplete="organization"
                />
              </label>

              <div className="space-y-2">
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">Categoría</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {BUSINESS_CATEGORIES.map((category) => {
                    const selected = businessCategory === category.id;

                    return (
                      <button
                        key={category.id}
                        type="button"
                        onClick={() => setBusinessCategory(category.id)}
                        className={`rounded-2xl border px-4 py-3 text-left transition ${
                          selected
                            ? 'border-emerald-500 bg-emerald-500/10 shadow-[0_0_0_1px_rgba(16,185,129,0.35)]'
                            : 'border-[color:var(--border)] bg-[color:var(--overlay-soft)] hover:border-emerald-500/40'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <span className="text-2xl" aria-hidden="true">
                            {category.icon}
                          </span>
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-900 dark:text-white">{category.label}</p>
                            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                              {category.useVariants
                                ? `Usa ${category.variantLabel?.toLowerCase() ?? 'variantes'}`
                                : 'Sin variantes / talles'}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {statusText && (
                <p
                  className="rounded-2xl border px-4 py-3 text-sm text-slate-800 dark:text-slate-200"
                  style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
                >
                  {statusText}
                </p>
              )}

              <div className="flex flex-wrap gap-3">
                <button type="button" className="erp-button-primary" onClick={() => void handleSubmit()} disabled={isSubmitting}>
                  {isSubmitting ? 'Guardando...' : 'Continuar'}
                </button>
                <button type="button" className="erp-button-secondary" onClick={logout} disabled={isSubmitting}>
                  Salir
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
