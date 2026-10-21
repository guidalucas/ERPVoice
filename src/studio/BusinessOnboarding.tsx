import { useState, type FormEvent } from 'react';
import { BUSINESS_CATEGORIES, type BusinessCategoryId } from '../domain/businessCategories';
import { useAuth } from '../store/AuthStore';
import { command, pendingOperations, retryOperation } from './api';
import type { Profile } from './types';

export type SetupStatus = { enabled: boolean; needsSetup: boolean; profile: Profile | null; moneyPolicy: Profile['moneyPolicy'] };

export function BusinessOnboarding({ status, onDone, onRefresh }: { status: SetupStatus; onDone: () => void; onRefresh: () => void }) {
  const { session, completeOnboarding, logout } = useAuth();
  const [pending, setPending] = useState(() => pendingOperations().find(item => item.route === '/setup'));
  const [name, setName] = useState(typeof pending?.body.brandName === 'string' ? pending.body.brandName : status.profile?.brandName ?? session?.businessName ?? '');
  const [category, setCategory] = useState<BusinessCategoryId | ''>(session?.businessCategory ?? '');
  const [phone, setPhone] = useState(pending ? typeof pending.body.salesWhatsapp === 'string' ? pending.body.salesWhatsapp : '' : status.profile?.salesWhatsapp ?? session?.phoneNumber ?? '');
  const [currency, setCurrency] = useState(typeof pending?.body.currency === 'string' ? pending.body.currency : status.moneyPolicy?.currency ?? 'ARS');
  const [confirmed, setConfirmed] = useState(pending?.body.confirmedMajorInteger === true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      if (pending) await retryOperation(pending);
      else {
        if (session?.needsOnboarding) {
          if (!category) throw new Error('Elegí el rubro de tu negocio.');
          await completeOnboarding({ businessName: name.trim(), businessCategory: category });
        }
        await command('/setup', 'POST', { expectedProfileRevision: status.profile?.revision ?? 0, expectedPolicyRevision: status.moneyPolicy?.revision ?? 0,
          brandName: name.trim(), salesWhatsapp: phone.trim() || null, currency, confirmedMajorInteger: confirmed });
      }
      onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No pude guardar la configuración.'); }
    finally { setPending(pendingOperations().find(item => item.route === '/setup')); setBusy(false); }
  };
  return <main className="onboarding page-section"><div className="panel"><p className="eyebrow dark">BIENVENIDO A STUDIO</p><h1>Configurá tu negocio</h1>
    <p>Tu inventario, tus fotos y tu catálogo en un mismo espacio. Podés completar esta configuración por tu cuenta.</p>
    {error && <div role="alert" className="notice">{error}<button type="button" onClick={onRefresh}>Actualizar configuración</button></div>}
    {pending && <p role="status">Hay una activación sin confirmar. Reenviaremos exactamente ese intento para evitar duplicados.</p>}
    <form onSubmit={submit}><fieldset disabled={busy || Boolean(pending)}><div className="field-grid">
      <label className="field"><span>Nombre comercial</span><input required maxLength={80} autoComplete="organization" value={name} onChange={event => setName(event.target.value)}/></label>
      {session?.needsOnboarding && <label className="field"><span>Rubro</span><select aria-label="Rubro" required value={category} onChange={event => setCategory(event.target.value as BusinessCategoryId)}><option value="">Elegí tu rubro</option>{BUSINESS_CATEGORIES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
      <label className="field"><span>WhatsApp para consultas (opcional)</span><input aria-label="WhatsApp para consultas (opcional)" inputMode="tel" pattern="[0-9]{8,15}" maxLength={15} placeholder="Código de país y número, sin + ni espacios" value={phone} onChange={event => setPhone(event.target.value)}/><small>Usá el número completo con código de país. Se mostrará a tus clientes al habilitar el catálogo.</small></label>
      <label className="field"><span>Moneda de tus precios</span><select aria-label="Moneda de tus precios" value={currency} disabled={Boolean(status.moneyPolicy)} onChange={event => { setCurrency(event.target.value); setConfirmed(false); }}><option value="ARS">ARS · Pesos argentinos</option><option value="UYU">UYU · Pesos uruguayos</option><option value="USD">USD · Dólares</option></select></label>
    </div><p>Ejemplo: un precio de {currency} $65.000 se carga como <strong>65000</strong>. Studio no cambia tus importes ni convierte monedas.</p>
    <label className="variant-row"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/><span>Confirmo {currency} y que cargo los precios en unidades enteras, sin centavos.</span></label>
    <p className="muted">La moneda queda confirmada para este inventario. Las variantes históricas con moneda pendiente se revisan después, sin modificar sus precios.</p></fieldset>
    <button className="primary" disabled={busy || (!pending && !confirmed)}>{busy ? 'Guardando configuración…' : pending ? 'Reintentar activación guardada' : 'Activar mi espacio comercial'}</button></form>
    <p>El catálogo permanece privado hasta que lo habilites y publiques tus fichas.</p><a href="/">Ir a Stocky</a><button type="button" onClick={logout}>Cerrar sesión</button>
  </div></main>;
}
