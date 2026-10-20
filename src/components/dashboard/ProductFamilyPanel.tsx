import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../store/AuthStore';
import { useInventory } from '../../hooks/useInventory';
import { toUserFacingError } from '../../services/apiClient';
import type { InventoryAttribute, InventoryAttributes } from '../../domain/types';
import { createProduct, type ProductInput } from '../../services/productService';
import {
  fetchProductFamilies,
  publishProductFamily,
  type ProductAttributeState,
  type ProductFamily,
  type ProductFamilySchema,
  type PublishProductFamilyRequest,
} from '../../services/productFamilyService';

type AttrDraft = { key: string; type: 'text' | 'number' | 'boolean'; required: boolean; unit: string; values: string; allowUnknown: boolean; allowNotApplicable: boolean; allowMissing: boolean };
type AttrValueDraft = { state: ProductAttributeState; value: string };
type Draft = { familyId: string; name: string; unit: string; allowAdditional: boolean; attrs: AttrDraft[]; skuName: string; stockAvailable: string; stockReserved: string; price: string; currency: string; familyChoice: string; attrValues: Record<string, AttrValueDraft> };
type Attempt<T> = { operationId: string; body: T; rejected?: boolean; conflict?: boolean; rejectionMessage?: string };
type Completed = { kind: 'family' | 'sku'; operationId: string; label: string; familyId?: string; version?: number; productId?: string };
type Saved = { draft: Draft; familyAttempt?: Attempt<PublishProductFamilyRequest>; skuAttempt?: Attempt<ProductInput>; completed?: Completed[]; reviewNote?: string };
const storagePrefix = 'product-families:';
const stateChoices: ProductAttributeState[] = ['unknown', 'not_applicable', 'missing'];
const button = 'rounded-xl border border-sky-500/30 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor', 'tostring', 'valueof', 'hasownproperty', 'isprototypeof', 'propertyisenumerable', 'tolocalestring']);

const freshAttr = (): AttrDraft => ({ key: '', type: 'text', required: false, unit: '', values: '', allowUnknown: false, allowNotApplicable: false, allowMissing: false });
const freshDraft = (): Draft => ({ familyId: crypto.randomUUID(), name: '', unit: '', allowAdditional: false, attrs: [freshAttr()], skuName: '', stockAvailable: '0', stockReserved: '0', price: '0', currency: 'XXX', familyChoice: '', attrValues: {} });
const normalizeKey = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const normalizeText = (value: string) => value.normalize('NFC').trim();
const translateState = (state: ProductAttributeState) => ({ known: 'Conocido', unknown: 'Desconocido', not_applicable: 'No aplica', missing: 'Faltante' })[state];
const translateType = (type: AttrDraft['type']) => ({ text: 'Texto', number: 'Número', boolean: 'Sí/No' })[type];
const linesFor = (attr: AttrDraft) => attr.values.split(/\r?\n/).map(value => value.trim()).filter(Boolean);

const parseAllowedValues = (attr: AttrDraft): Array<string | number | boolean> | undefined => {
  const lines = linesFor(attr);
  if (!lines.length) return undefined;
  if (attr.type === 'boolean') {
    if (!lines.every(value => /^(sí|si|no|true|false)$/i.test(value))) throw new Error(`Los valores booleanos de “${attr.key}” deben ser Sí o No.`);
    return lines.map(value => /^(sí|si|true)$/i.test(value));
  }
  if (attr.type === 'number') {
    const values = lines.map(Number);
    if (values.some(value => !Number.isFinite(value))) throw new Error(`Los valores permitidos de “${attr.key}” deben ser números finitos.`);
    return values;
  }
  return lines.map(normalizeText);
};

const makeSchema = (draft: Draft): ProductFamilySchema => {
  if (draft.attrs.length > 50) throw new Error('Una familia puede tener hasta 50 atributos.');
  const attributes = Object.create(null) as ProductFamilySchema['attributes'];
  const normalizedKeys = new Set<string>();
  for (const attr of draft.attrs) {
    const key = attr.key.trim();
    if (!key) continue;
    const canonical = normalizeKey(key);
    if (dangerousKeys.has(canonical) || canonical.startsWith('__')) throw new Error(`La clave “${key}” está reservada.`);
    if (normalizedKeys.has(canonical)) throw new Error(`La clave “${key}” está duplicada.`);
    normalizedKeys.add(canonical);
    if (attr.type !== 'number' && attr.unit.trim()) throw new Error(`La unidad solo corresponde al atributo numérico “${key}”.`);
    const values = parseAllowedValues(attr);
    if (values && values.length > 100) throw new Error(`“${key}” admite hasta 100 valores.`);
    if (values) {
      const canonicalValues = values.map(value => typeof value === 'string' ? normalizeText(value) : String(value));
      if (new Set(canonicalValues).size !== canonicalValues.length) throw new Error(`Hay valores repetidos en “${key}”.`);
    }
    if (attr.required && (attr.allowUnknown || attr.allowNotApplicable || attr.allowMissing)) throw new Error('Un atributo requerido solo puede admitir el estado “conocido”.');
    const allowedStates: ProductAttributeState[] = ['known'];
    if (attr.allowUnknown) allowedStates.push('unknown');
    if (attr.allowNotApplicable) allowedStates.push('not_applicable');
    if (attr.allowMissing) allowedStates.push('missing');
    attributes[key] = { type: attr.type, required: attr.required, allowedStates, ...(attr.type === 'number' && attr.unit.trim() ? { unit: attr.unit.trim() } : {}), ...(values ? { values } : {}) };
  }
  return { name: draft.name.trim(), unit: draft.unit.trim(), attributes, allowAdditionalAttributes: draft.allowAdditional };
};

const isString = (value: unknown): value is string => typeof value === 'string';
const isAttrDraft = (value: unknown): value is AttrDraft => {
  if (!value || typeof value !== 'object') return false;
  const attr = value as Record<string, unknown>;
  return isString(attr.key) && ['text', 'number', 'boolean'].includes(String(attr.type)) && typeof attr.required === 'boolean' && isString(attr.unit) && isString(attr.values) && typeof attr.allowUnknown === 'boolean' && typeof attr.allowNotApplicable === 'boolean' && typeof attr.allowMissing === 'boolean';
};
const isDraft = (value: unknown): value is Draft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  return isString(draft.familyId) && isString(draft.name) && isString(draft.unit) && typeof draft.allowAdditional === 'boolean' && Array.isArray(draft.attrs) && draft.attrs.length <= 50 && draft.attrs.every(isAttrDraft)
    && isString(draft.skuName) && isString(draft.stockAvailable) && isString(draft.stockReserved) && isString(draft.price) && isString(draft.currency) && isString(draft.familyChoice)
    && Boolean(draft.attrValues) && typeof draft.attrValues === 'object' && Object.values(draft.attrValues as Record<string, unknown>).every(entry => Boolean(entry) && typeof entry === 'object' && ['known', 'unknown', 'not_applicable', 'missing'].includes(String((entry as Record<string, unknown>).state)) && isString((entry as Record<string, unknown>).value));
};
const isSaved = (value: unknown): value is Saved => {
  if (!value || typeof value !== 'object' || !isDraft((value as Record<string, unknown>).draft)) return false;
  const saved = value as Record<string, unknown>;
  const familyAttempt = saved.familyAttempt as Record<string, unknown> | undefined;
  if (familyAttempt !== undefined) {
    const body = familyAttempt && familyAttempt.body as Record<string, unknown> | undefined;
    if (!familyAttempt || !isString(familyAttempt.operationId) || !body || !isString(body.familyId) || !Number.isSafeInteger(body.expectedVersion) || !body.schema || typeof body.schema !== 'object' || typeof familyAttempt.rejected !== 'undefined' && typeof familyAttempt.rejected !== 'boolean') return false;
  }
  const skuAttempt = saved.skuAttempt as Record<string, unknown> | undefined;
  if (skuAttempt !== undefined) {
    const body = skuAttempt && skuAttempt.body as Record<string, unknown> | undefined;
    const family = body?.family as Record<string, unknown> | undefined;
    if (!skuAttempt || !isString(skuAttempt.operationId) || !body || !isString(body.name) || !family || !isString(family.id) || !Number.isSafeInteger(family.version) || typeof skuAttempt.rejected !== 'undefined' && typeof skuAttempt.rejected !== 'boolean') return false;
  }
  return saved.completed === undefined || Array.isArray(saved.completed) && saved.completed.every(item => Boolean(item) && typeof item === 'object' && ['family', 'sku'].includes(String((item as Record<string, unknown>).kind)) && isString((item as Record<string, unknown>).label) && isString((item as Record<string, unknown>).operationId));
};

export function ProductFamilyPanel({ onClose }: { onClose: () => void }) {
  const { session } = useAuth();
  const { refreshState } = useInventory();
  const storageKey = session ? `${storagePrefix}${JSON.stringify([session.tenantPhone, session.phoneNumber])}` : null;
  const [saved, setSaved] = useState<Saved>(() => ({ draft: freshDraft() }));
  const [families, setFamilies] = useState<ProductFamily[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [invalidRecovery, setInvalidRecovery] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [familyConsent, setFamilyConsent] = useState(false);
  const [skuConsent, setSkuConsent] = useState(false);
  const lock = useRef(false);
  const activeRef = useRef(false);
  const scope = useRef(storageKey);
  scope.current = storageKey;
  const refresh = useRef(refreshState);
  refresh.current = refreshState;
  const dialog = useRef<HTMLDivElement>(null);
  const draft = saved.draft;
  const orderedFamilies = useMemo(() => [...families].sort((a, b) => a.schema.name.localeCompare(b.schema.name, 'es') || b.version - a.version), [families]);
  const chosenFamily = orderedFamilies.find(family => `${family.familyId}@${family.version}` === draft.familyChoice);
  const hasPendingAttempt = Boolean(saved.familyAttempt || saved.skuAttempt);
  const familyComplete = (saved.completed ?? []).some(item => item.kind === 'family');
  const skuComplete = (saved.completed ?? []).some(item => item.kind === 'sku');

  const persist = (next: Saved) => {
    if (!storageKey || scope.current !== storageKey) throw new Error('No hay una sesión activa para guardar la operación.');
    localStorage.setItem(storageKey, JSON.stringify(next));
    setSaved(next);
  };
  const loadFamilies = async (expectedScope = storageKey, isActive: () => boolean = () => activeRef.current) => {
    setFamilyConsent(false); setSkuConsent(false);
    if (!expectedScope) throw new Error('Iniciá sesión para consultar familias.');
    const result = await fetchProductFamilies();
    if (scope.current !== expectedScope || !isActive()) return null;
    setFamilies(result.families);
    return result.families;
  };
  const updateDraft = (changes: Partial<Draft>) => {
    if (lock.current || busy || hasPendingAttempt || invalidRecovery || loading) return;
    setFamilyConsent(false); setSkuConsent(false); setError('');
    persist({ ...saved, draft: { ...draft, ...changes }, reviewNote: undefined });
  };

  useEffect(() => {
    let active = true;
    activeRef.current = true;
    lock.current = true;
    setBusy(true); setHydrated(false); setInvalidRecovery(false); setError(''); setReadError(''); setFamilyConsent(false); setSkuConsent(false); setFamilies([]);
    const restore = async () => {
      let parsed: Saved;
      try {
        const raw = storageKey ? localStorage.getItem(storageKey) : null;
        const candidate = raw ? JSON.parse(raw) as unknown : { draft: freshDraft() };
        if (!isSaved(candidate)) throw new Error('El borrador guardado no tiene un formato válido. Su referencia permanece guardada.');
        parsed = candidate;
        if (!active || scope.current !== storageKey) return;
        setSaved(parsed);
      } catch (failure) {
        if (active && scope.current === storageKey) { setInvalidRecovery(true); setError(toUserFacingError(failure)); }
        return;
      }
      if (!active || scope.current !== storageKey) return;
      try {
        try { await loadFamilies(storageKey, () => active); }
        catch {
          if (active && scope.current === storageKey) setReadError(parsed.completed?.length ? 'La operación se aplicó, pero no pudimos actualizar las familias. Reintentá solo las lecturas.' : 'No pudimos cargar las familias. Reintentá solo las lecturas antes de operar.');
        }
        if (parsed.completed?.some(item => item.kind === 'sku')) {
          try { await refresh.current(); }
          catch { if (active && scope.current === storageKey) setReadError('El producto se creó, pero no se pudo actualizar el inventario. Reintentá solo las lecturas.'); }
        }
      } finally {
        if (active && scope.current === storageKey) { lock.current = false; setBusy(false); setHydrated(true); }
      }
    };
    void restore();
    return () => { active = false; activeRef.current = false; };
  }, [storageKey]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);

  const validateSchema = (schema: ProductFamilySchema) => {
    if (!schema.name) throw new Error('Escribí el nombre de la familia.');
    if (!schema.unit) throw new Error('Escribí la unidad base de la familia.');
    if (Object.keys(schema.attributes).length !== draft.attrs.filter(attr => attr.key.trim()).length) throw new Error('Cada atributo debe tener una clave válida y única.');
  };

  const updateFamiliesWith = (family: ProductFamily) => {
    setFamilies(current => {
      const rest = current.filter(item => !(item.familyId === family.familyId && item.version === family.version));
      return [...rest, family];
    });
  };
  const readAfterFamilySuccess = async (family: ProductFamily) => {
    updateFamiliesWith(family);
    try { await loadFamilies(); setReadError(''); }
    catch { setReadError('La familia se publicó, pero no pudimos actualizar la lista. Reintentá solo las lecturas.'); }
  };
  const submitFamily = async (retry = false) => {
    if (lock.current || !hydrated || !storageKey || !familyConsent || invalidRecovery || familyComplete || (retry ? Boolean(saved.skuAttempt) : hasPendingAttempt)) return;
    if (saved.familyAttempt && !retry) return;
    lock.current = true; setBusy(true); setError(''); setFamilyConsent(false); setSkuConsent(false);
    let attempt = saved.familyAttempt;
    try {
      if (!attempt) {
        const schema = makeSchema(draft);
        validateSchema(schema);
        const latestVersion = families.filter(item => item.familyId === draft.familyId).reduce((max, item) => Math.max(max, item.version), 0);
        const body = { operationId: crypto.randomUUID(), familyId: draft.familyId, expectedVersion: latestVersion, schema };
        attempt = { operationId: body.operationId, body };
        persist({ ...saved, familyAttempt: attempt, reviewNote: undefined });
      }
      const result = await publishProductFamily(attempt.body);
      if (scope.current !== storageKey || !activeRef.current) return;
      if (result.status !== 'applied' || result.operationId !== attempt.operationId || result.family.familyId!==attempt.body.familyId
        || result.family.version!==attempt.body.expectedVersion+1) throw new Error('La respuesta no confirmó la publicación. El intento permanece guardado.');
      const completed: Completed = { kind: 'family', operationId: attempt.operationId, label: `${result.family.schema.name}, versión ${result.family.version}`, familyId: result.family.familyId, version: result.family.version };
      persist({ ...saved, familyAttempt: undefined, completed: [...(saved.completed ?? []).filter(item => item.kind !== 'family'), completed] });
      await readAfterFamilySuccess(result.family);
    } catch (failure) {
      if (scope.current !== storageKey || !activeRef.current) return;
      const status = Number((failure as { status?: number })?.status);
      if (attempt && [400, 409, 422].includes(status)) {
        const message = toUserFacingError(failure);
        const nextAttempt = { ...attempt, rejected: true, conflict: status === 409, rejectionMessage: message };
        persist({ ...saved, familyAttempt: nextAttempt });
        setError(message);
      } else setError(toUserFacingError(failure));
    } finally { lock.current = false; setBusy(false); }
  };

  const productAttributes = (family: ProductFamily, valuesDraft = draft.attrValues): InventoryAttributes => {
    const attrs = Object.create(null) as InventoryAttributes;
    for (const [key, definition] of Object.entries(family.schema.attributes)) {
      const entry = valuesDraft[key] ?? { state: 'known' as const, value: '' };
      if (entry.state !== 'known') {
        if (definition.required || !definition.allowedStates.includes(entry.state)) throw new Error(`El atributo “${key}” requiere un valor conocido.`);
        attrs[key] = { type: definition.type, state: entry.state, ...(definition.type === 'number' && definition.unit ? { unit: definition.unit } : {}) } as InventoryAttribute;
        continue;
      }
      if (entry.value.trim() === '') {
        if (definition.required) throw new Error(`Completá el atributo requerido “${key}”.`);
        continue;
      }
      const value: string | number | boolean = definition.type === 'boolean' ? entry.value === 'true' : definition.type === 'number' ? Number(entry.value) : normalizeText(entry.value);
      if (definition.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`“${key}” debe ser un número finito.`);
      if (definition.values) {
        const match = definition.values.some(allowed => typeof allowed === 'string' && typeof value === 'string'
          ? normalizeText(allowed) === normalizeText(value) : allowed === value);
        if (!match) throw new Error(`“${key}” debe coincidir con uno de los valores permitidos.`);
      }
      attrs[key] = { type: definition.type, state: 'known', value, ...(definition.type === 'number' && definition.unit ? { unit: definition.unit } : {}) } as InventoryAttribute;
    }
    return attrs;
  };
  const skuPreview = (family: ProductFamily, valuesDraft = draft.attrValues, inputDraft = draft) => {
    let attributes: InventoryAttributes = Object.create(null) as InventoryAttributes;
    try { attributes = productAttributes(family, valuesDraft); } catch { /* Preview displays the draft values as entered. */ }
    return { family: family.schema.name, version: family.version, name: inputDraft.skuName.trim() || 'Sin nombre', unit: family.schema.unit, attributes, available: inputDraft.stockAvailable, reserved: inputDraft.stockReserved, price: inputDraft.price, currency: inputDraft.currency.trim().toUpperCase() || 'Sin definir' };
  };
  const submitSku = async (retry = false) => {
    if (lock.current || !hydrated || !storageKey || !skuConsent || invalidRecovery || skuComplete || (retry ? Boolean(saved.familyAttempt) : hasPendingAttempt)) return;
    if (saved.skuAttempt && !retry) return;
    lock.current = true; setBusy(true); setError(''); setSkuConsent(false); setFamilyConsent(false);
    let attempt = saved.skuAttempt;
    try {
      if (!attempt) {
        if (!chosenFamily) throw new Error('Elegí una familia y versión para crear el producto.');
        if (!draft.skuName.trim()) throw new Error('Escribí el nombre del producto.');
        if (!draft.stockAvailable.trim() || !draft.stockReserved.trim() || !draft.price.trim()) throw new Error('Completá stock disponible, stock reservado y precio.');
        const stockAvailable = Number(draft.stockAvailable); const stockReserved = Number(draft.stockReserved); const price = Number(draft.price);
        if (![stockAvailable, stockReserved].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('El stock debe ser un entero seguro igual o mayor que cero.');
        if (!Number.isSafeInteger(price) || price < 0) throw new Error('El precio debe ser un entero seguro igual o mayor que cero.');
        const currency = draft.currency.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) throw new Error('La moneda debe ser un código ISO 4217 de tres letras.');
        const body: ProductInput = { name: draft.skuName.trim(), family: { id: chosenFamily.familyId, version: chosenFamily.version }, attributes: productAttributes(chosenFamily), unit: chosenFamily.schema.unit, priceCurrency: currency, stockAvailable, stockReserved, price };
        attempt = { operationId: crypto.randomUUID(), body };
        persist({ ...saved, skuAttempt: attempt, reviewNote: undefined });
      }
      const created = await createProduct(attempt.body, { operationId: attempt.operationId });
      if (scope.current !== storageKey || !activeRef.current) return;
      if (!created?.id || created.family?.id!==attempt.body.family?.id || created.family?.version!==attempt.body.family?.version
        || created.unit!==attempt.body.unit || created.stockAvailable!==attempt.body.stockAvailable || created.stockReserved!==attempt.body.stockReserved
        || created.price!==attempt.body.price || created.priceCurrency!==attempt.body.priceCurrency) throw new Error('La respuesta no confirmó los datos del producto. Conservá el intento y reintentá la misma creación.');
      const completed: Completed = { kind: 'sku', operationId: attempt.operationId, label: created.name, productId: created.id };
      persist({ ...saved, skuAttempt: undefined, completed: [...(saved.completed ?? []).filter(item => item.kind !== 'sku'), completed] });
      try { await refresh.current(); setReadError(''); }
      catch { setReadError('El producto se creó, pero no pudimos actualizar el inventario. Reintentá solo las lecturas.'); }
    } catch (failure) {
      if (scope.current !== storageKey || !activeRef.current) return;
      const status = Number((failure as { status?: number })?.status);
      if (attempt && [400, 409, 422].includes(status)) {
        const message = toUserFacingError(failure);
        persist({ ...saved, skuAttempt: { ...attempt, rejected: true, conflict: status === 409, rejectionMessage: message } });
        setError(message);
      } else setError(toUserFacingError(failure));
    } finally { lock.current = false; setBusy(false); }
  };

  const retryReads = async () => {
    if (loading || busy) return;
    setLoading(true); setReadError(''); setError(''); setFamilyConsent(false); setSkuConsent(false);
    try {
      const currentFamilies = await loadFamilies();
      if (!currentFamilies || scope.current !== storageKey || !activeRef.current) return;
      await refresh.current();
      setReadError('');
    } catch (failure) { setReadError(toUserFacingError(failure)); }
    finally { setLoading(false); }
  };
  const reviewRejected = async (kind: 'family' | 'sku') => {
    if (loading || busy || lock.current) return;
    setLoading(true); setError(''); setFamilyConsent(false); setSkuConsent(false);
    try {
      const currentFamilies = await loadFamilies();
      if (!currentFamilies || scope.current !== storageKey || !activeRef.current) return;
      await refresh.current();
      if (!storageKey || scope.current !== storageKey || !activeRef.current) return;
      const attempt = kind === 'family' ? saved.familyAttempt : saved.skuAttempt;
      const note = attempt?.rejectionMessage ? `El servidor rechazó el intento: ${attempt.rejectionMessage}. Revisaste los datos actuales; podés editar y crear una operación nueva.` : 'Revisión de los datos actuales completada. Podés editar y crear una operación nueva.';
      persist({ ...saved, [kind === 'family' ? 'familyAttempt' : 'skuAttempt']: undefined, reviewNote: note } as Saved);
    } catch (failure) { setError(toUserFacingError(failure)); }
    finally { setLoading(false); }
  };
  const prepareAnotherFamily = () => {
    if (busy || loading || hasPendingAttempt || invalidRecovery) return;
    persist({ ...saved, draft: { ...draft, familyId: crypto.randomUUID(), name: '', unit: '', allowAdditional: false, attrs: [freshAttr()] }, completed: (saved.completed ?? []).filter(item => item.kind !== 'family') });
    setFamilyConsent(false); setSkuConsent(false); setError(''); setReadError('');
  };
  const prepareAnotherSku = () => {
    if (busy || loading || hasPendingAttempt || invalidRecovery) return;
    persist({ ...saved, draft: { ...draft, skuName: '', stockAvailable: '0', stockReserved: '0', price: '0', currency: 'XXX', attrValues: Object.create(null) as Draft['attrValues'] }, completed: (saved.completed ?? []).filter(item => item.kind !== 'sku') });
    setFamilyConsent(false); setSkuConsent(false); setError(''); setReadError('');
  };

  const schemaPreview = (() => { try { return makeSchema(draft); } catch { return null; } })();
  const selectedChoice = (family: ProductFamily) => `${family.familyId}@${family.version}`;
  const updateAttr = (index: number, changes: Partial<AttrDraft>) => updateDraft({ attrs: draft.attrs.map((attr, at) => at === index ? { ...attr, ...changes } : attr) });
  const changeFamilyChoice = (choice: string) => {
    const family = orderedFamilies.find(item => selectedChoice(item) === choice);
    updateDraft({ familyChoice: choice, attrValues: family ? Object.fromEntries(Object.entries(family.schema.attributes).map(([key]) => [key, { state: 'known' as const, value: '' }])) : {} });
  };
  const familyNameForSku = (attempt: Attempt<ProductInput>) => {
    const familyId = attempt.body.family?.id;
    return families.find(family => family.familyId === familyId && family.version===attempt.body.family?.version)?.schema.name
      ?? (chosenFamily && chosenFamily.familyId === familyId && chosenFamily.version===attempt.body.family?.version ? chosenFamily.schema.name : 'Familia seleccionada');
  };
  const familyForSkuAttempt = (attempt: Attempt<ProductInput>): ProductFamily => {
    const familyId = attempt.body.family?.id ?? '';
    const cached = families.find(family => family.familyId === familyId && family.version===attempt.body.family?.version)
      ?? (chosenFamily && chosenFamily.familyId === familyId && chosenFamily.version===attempt.body.family?.version ? chosenFamily : undefined);
    if (cached) return cached;
    const attributes = Object.create(null) as ProductFamily['schema']['attributes'];
    for (const [key, attribute] of Object.entries(attempt.body.attributes ?? {})) {
      const states: ProductAttributeState[] = [attribute.state];
      attributes[key] = { type: attribute.type, required: false, allowedStates: states, ...(attribute.unit ? { unit: attribute.unit } : {}) };
    }
    return { familyId, version: attempt.body.family?.version ?? 0, schema: { name: familyNameForSku(attempt), unit: attempt.body.unit ?? '', attributes, allowAdditionalAttributes: false } };
  };
  const renderSkuReview = (family: ProductFamily, values = draft.attrValues, skuDraft = draft) => {
    const preview = skuPreview(family, values, skuDraft);
    return <div role="region" aria-label="Vista previa del producto" className="mt-3 rounded-lg bg-[color:var(--overlay-soft)] p-3 text-sm"><strong>Revisá los datos del producto</strong><p>{preview.name} · {preview.family} v{preview.version} · unidad: {preview.unit}</p><ul className="mt-2 list-inside list-disc">{Object.entries(family.schema.attributes).map(([key, definition]) => {
      const entry = values[key] ?? { state: 'known' as const, value: '' };
      const attr = preview.attributes[key];
      let detail = translateState(entry.state);
      if (entry.state === 'known') detail = attr?.state === 'known' ? `${translateType(definition.type)}: ${String(attr.value)}${attr.unit ? ` ${attr.unit}` : ''}` : entry.value.trim() ? `${translateType(definition.type)}: ${entry.value}` : 'Sin valor';
      else if (definition.type === 'number' && definition.unit) detail += ` · ${definition.unit}`;
      return <li key={key}>{key}: {detail}</li>;
    })}</ul><p>Disponible: {preview.available} · Reservado: {preview.reserved} · Precio: {preview.price} {preview.currency}</p></div>;
  };
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
    if (!focusable?.length) return;
    const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-3">
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="product-family-title" aria-busy={busy || loading} onKeyDown={onDialogKeyDown} className="max-h-[92dvh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-sky-500/30 bg-[color:var(--surface-elevated)] p-5 text-[color:var(--text)] shadow-2xl">
      <div className="flex items-start justify-between gap-3"><div><h2 id="product-family-title" className="type-title text-xl">Familias y atributos</h2><p className="mt-1 text-sm text-[color:var(--muted)]">Definí un esquema versionado y usalo para crear un producto nuevo.</p></div><button type="button" className="erp-button-secondary" onClick={onClose} disabled={busy}>Cerrar</button></div>
      {!hydrated && <p className="mt-5" role="status">Recuperando borrador y familias…</p>}
      {hydrated && <div className="mt-5 space-y-6">
        <section className="space-y-4 rounded-xl border border-[color:var(--border)] p-4" aria-labelledby="family-config-title">
          <h3 id="family-config-title" className="type-subtitle">1. Configurar y publicar familia</h3>
          {familyComplete && <div role="status" className="rounded-lg border border-emerald-500/40 p-3">Publicación aplicada: {(saved.completed ?? []).find(item => item.kind === 'family')?.label}. <button type="button" className="underline" disabled={busy || loading} onClick={prepareAnotherFamily}>Preparar otra publicación</button></div>}
          <fieldset disabled={busy || loading || hasPendingAttempt || familyComplete || invalidRecovery} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">Nombre de familia<input className="erp-input mt-1" value={draft.name} onChange={e => updateDraft({ name: e.target.value })} /></label>
              <label className="text-sm">Unidad base<input className="erp-input mt-1" value={draft.unit} onChange={e => updateDraft({ unit: e.target.value })} placeholder="por ejemplo, unidad" /></label>
              <label className="text-sm sm:col-span-2">Familia para publicar una versión nueva<select aria-label="Familia para publicar una versión nueva" className="erp-input mt-1" value={families.some(item => item.familyId === draft.familyId) ? draft.familyId : '__new_family__'} onChange={e => { const latest = families.filter(item => item.familyId === e.target.value).sort((a, b) => b.version - a.version)[0]; updateDraft(latest ? { familyId: latest.familyId, name: latest.schema.name, unit: latest.schema.unit, allowAdditional: latest.schema.allowAdditionalAttributes, attrs: Object.entries(latest.schema.attributes).map(([key, item]) => ({ key, type: item.type, required: item.required, unit: item.unit ?? '', values: item.values?.map(value => typeof value === 'boolean' ? value ? 'Sí' : 'No' : String(value)).join('\n') ?? '', allowUnknown: item.allowedStates.includes('unknown'), allowNotApplicable: item.allowedStates.includes('not_applicable'), allowMissing: item.allowedStates.includes('missing') })) } : { familyId: crypto.randomUUID(), name: '', unit: '', allowAdditional: false, attrs: [freshAttr()] }); }}><option value="__new_family__">Familia nueva</option>{Array.from(new Map(orderedFamilies.map(f => [f.familyId, f])).values()).map(f => <option key={f.familyId} value={f.familyId}>{f.schema.name} · última v{Math.max(...families.filter(x => x.familyId === f.familyId).map(x => x.version))}</option>)}</select></label>
            </div>
            <div className="space-y-3">{draft.attrs.map((attr, index) => <div key={index} className="rounded-lg border border-[color:var(--border)] p-3" role="group" aria-label={`Atributo ${index + 1}`}>
              <div className="grid gap-2 sm:grid-cols-6">
                <label className="text-sm sm:col-span-2">Clave<input aria-label="Clave" className="erp-input mt-1" value={attr.key} onChange={e => updateAttr(index, { key: e.target.value })} /></label>
                <label className="text-sm">Tipo<select aria-label="Tipo" className="erp-input mt-1" value={attr.type} onChange={e => { const type = e.target.value as AttrDraft['type']; updateAttr(index, { type, values: '', unit: type === 'number' ? attr.unit : '' }); }}><option value="text">Texto</option><option value="number">Número</option><option value="boolean">Sí/No</option></select></label>
                <label className="text-sm">Unidad<input aria-label="Unidad" className="erp-input mt-1" value={attr.unit} disabled={attr.type !== 'number'} onChange={e => updateAttr(index, { unit: e.target.value })} /></label>
                <label className="text-sm sm:col-span-2">Valores permitidos por línea<textarea aria-label="Valores permitidos por línea" className="erp-input mt-1 min-h-16" value={attr.values} onChange={e => updateAttr(index, { values: e.target.value })} placeholder="Opcional" /></label>
              </div>
              <div className="mt-2 flex flex-wrap gap-4 text-sm"><label><input type="checkbox" checked={attr.required} onChange={e => updateAttr(index, { required: e.target.checked, ...(e.target.checked ? { allowUnknown: false, allowNotApplicable: false, allowMissing: false } : {}) })} /> Requerido</label>{(['allowUnknown', 'allowNotApplicable', 'allowMissing'] as const).map((key, stateIndex) => <label key={key}><input type="checkbox" checked={attr[key]} disabled={attr.required} onChange={e => updateAttr(index, { [key]: e.target.checked })} /> Estado {stateChoices[stateIndex] === 'not_applicable' ? 'no aplica' : stateChoices[stateIndex] === 'unknown' ? 'desconocido' : 'faltante'}</label>)}<button type="button" className="text-rose-500" disabled={draft.attrs.length === 1} onClick={() => updateDraft({ attrs: draft.attrs.filter((_, at) => at !== index) })}>Quitar atributo</button></div>
            </div>)}</div>
            <button type="button" className={button} disabled={draft.attrs.length >= 50} onClick={() => updateDraft({ attrs: [...draft.attrs, freshAttr()] })}>Agregar atributo</button>
            <label className="block text-sm"><input type="checkbox" checked={draft.allowAdditional} onChange={e => updateDraft({ allowAdditional: e.target.checked })} /> Permitir atributos adicionales</label>
          </fieldset>
          {schemaPreview && <div role="region" className="rounded-lg bg-[color:var(--overlay-soft)] p-3" aria-label="Vista previa de familia"><strong>Vista previa</strong><p className="mt-1">{schemaPreview.name || 'Sin nombre'} · unidad: {schemaPreview.unit || 'Sin definir'}</p><ul className="mt-2 list-inside list-disc text-sm">{Object.entries(schemaPreview.attributes).map(([key, item]) => <li key={key}>{key} · {translateType(item.type)} · {item.required ? 'requerido' : 'opcional'}{item.unit ? ` · ${item.unit}` : ''}{item.values ? ` · permitidos: ${item.values.map(value => String(value)).join(', ')}` : ''} · estados: {item.allowedStates.map(translateState).join(', ')}</li>)}</ul><p className="text-sm">Atributos adicionales: {schemaPreview.allowAdditionalAttributes ? 'permitidos' : 'no permitidos'}</p></div>}
          {saved.familyAttempt && <div className="rounded-lg border border-amber-500/40 p-3 text-sm">Intento de publicación: {saved.familyAttempt.body.schema.name}, versión esperada {saved.familyAttempt.body.expectedVersion + 1}.{saved.familyAttempt.rejectionMessage && <p role="alert">{saved.familyAttempt.rejectionMessage}</p>}{saved.familyAttempt.rejected ? <button type="button" className={`${button} mt-2`} disabled={loading || busy} onClick={() => void reviewRejected('family')}>Revisar respuesta y datos actuales</button> : <><label className="mt-2 block"><input type="checkbox" checked={familyConsent} disabled={busy || loading} onChange={e => setFamilyConsent(e.target.checked)} /> Confirmo que revisé y autorizo reintentar exactamente esta publicación.</label><button type="button" className={`${button} mt-2`} disabled={busy || loading || !familyConsent} onClick={() => void submitFamily(true)}>Reintentar misma publicación</button></>}</div>}
          {!saved.familyAttempt && !familyComplete && <><label className="block text-sm"><input type="checkbox" checked={familyConsent} disabled={busy || loading || hasPendingAttempt || invalidRecovery} onChange={e => setFamilyConsent(e.target.checked)} /> Revisé esta familia y autorizo publicarla como una nueva versión inmutable.</label><button type="button" className="erp-button-primary" disabled={busy || loading || !familyConsent || hasPendingAttempt || invalidRecovery} onClick={() => void submitFamily()}>Publicar familia</button></>}
        </section>

        <section className="space-y-4 rounded-xl border border-[color:var(--border)] p-4" aria-labelledby="sku-create-title">
          <h3 id="sku-create-title" className="type-subtitle">2. Crear producto nuevo</h3>
          {skuComplete && <div role="status" className="rounded-lg border border-emerald-500/40 p-3">Producto creado: {(saved.completed ?? []).find(item => item.kind === 'sku')?.label}. <button type="button" className="underline" disabled={busy || loading} onClick={prepareAnotherSku}>Crear otro producto</button></div>}
          <fieldset disabled={busy || loading || hasPendingAttempt || skuComplete || invalidRecovery} className="space-y-4">
            <label className="block text-sm">Familia y versión<select aria-label="Familia y versión" className="erp-input mt-1" value={draft.familyChoice} onChange={e => changeFamilyChoice(e.target.value)}><option value="">Elegí una familia</option>{orderedFamilies.map(f => <option key={selectedChoice(f)} value={selectedChoice(f)}>{f.schema.name} · v{f.version}</option>)}</select></label>
            {chosenFamily && <>
              <label className="block text-sm">Nombre del producto<input className="erp-input mt-1" value={draft.skuName} onChange={e => updateDraft({ skuName: e.target.value })} /></label>
              <div className="grid gap-3 sm:grid-cols-2">{Object.entries(chosenFamily.schema.attributes).map(([key, def]) => {
                const entry = draft.attrValues[key] ?? { state: 'known' as const, value: '' };
                const permittedStates = def.allowedStates.filter(state => state !== 'known');
                const updateValue = (changes: Partial<AttrValueDraft>) => updateDraft({ attrValues: { ...draft.attrValues, [key]: { ...entry, ...changes } } });
                const isRestrictedBoolean = def.values && !(def.values.includes(true) && def.values.includes(false));
                const boolOptions = isRestrictedBoolean ? def.values : [true, false];
                return <label key={key} className="text-sm">{key}{def.required ? ' · requerido' : ' · opcional'}{def.unit ? ` (${def.unit})` : ''}
                  {permittedStates.length > 0 && <select aria-label={`Estado de ${key}`} className="erp-input mt-1" value={entry.state} onChange={e => updateValue({ state: e.target.value as ProductAttributeState, value: '' })}><option value="known">Conocido</option>{permittedStates.map(state => <option key={state} value={state}>{translateState(state)}</option>)}</select>}
                  {entry.state === 'known' && (def.type === 'boolean' ? <select aria-label={`Valor de ${key}`} className="erp-input mt-1" required={def.required} value={entry.value} onChange={e => updateValue({ value: e.target.value })}><option value="">Elegí Sí o No</option>{boolOptions?.map((value, at) => <option key={`${String(value)}-${at}`} value={String(value)}>{value ? 'Sí' : 'No'}</option>)}</select> : def.values?.length ? <select aria-label={`Valor de ${key}`} className="erp-input mt-1" required={def.required} value={entry.value} onChange={e => updateValue({ value: e.target.value })}><option value="">Elegí un valor</option>{def.values.map((value, at) => <option key={`${String(value)}-${at}`} value={String(value)}>{String(value)}</option>)}</select> : <input aria-label={`Valor de ${key}`} className="erp-input mt-1" type={def.type === 'number' ? 'number' : 'text'} step={def.type === 'number' ? 'any' : undefined} required={def.required} value={entry.value} onChange={e => updateValue({ value: e.target.value })} />)}
                </label>;
              })}</div>
              <p className="text-sm text-[color:var(--muted)]">Unidad del producto: {chosenFamily.schema.unit}.</p>
              <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Stock disponible<input className="erp-input mt-1" type="number" min="0" step="1" value={draft.stockAvailable} onChange={e => updateDraft({ stockAvailable: e.target.value })} /></label><label className="text-sm">Stock reservado<input className="erp-input mt-1" type="number" min="0" step="1" value={draft.stockReserved} onChange={e => updateDraft({ stockReserved: e.target.value })} /></label><label className="text-sm">Precio<input className="erp-input mt-1" type="number" min="0" step="1" value={draft.price} onChange={e => updateDraft({ price: e.target.value })} /></label><label className="text-sm">Moneda ISO 4217<input className="erp-input mt-1 uppercase" maxLength={3} value={draft.currency} onChange={e => updateDraft({ currency: e.target.value.toUpperCase() })} /></label></div>
              {!saved.skuAttempt && renderSkuReview(chosenFamily)}
              {!saved.skuAttempt && <label className="block text-sm"><input type="checkbox" checked={skuConsent} onChange={e => setSkuConsent(e.target.checked)} /> Revisé los datos del producto y autorizo crearlo.</label>}
            </>}
          </fieldset>
          {saved.skuAttempt && <div className="rounded-lg border border-amber-500/40 p-3 text-sm">Intento de creación: {saved.skuAttempt.body.name} · {familyNameForSku(saved.skuAttempt)} v{saved.skuAttempt.body.family?.version}.{saved.skuAttempt.rejectionMessage && <p role="alert">{saved.skuAttempt.rejectionMessage}</p>}{saved.skuAttempt.rejected ? <button type="button" className={`${button} mt-2`} disabled={loading || busy} onClick={() => void reviewRejected('sku')}>Revisar respuesta y datos actuales</button> : <><label className="mt-3 block"><input type="checkbox" checked={skuConsent} disabled={busy || loading} onChange={e => setSkuConsent(e.target.checked)} /> Revisé los datos del producto y autorizo crearlo.</label>{renderSkuReview(familyForSkuAttempt(saved.skuAttempt), Object.fromEntries(Object.entries(saved.skuAttempt.body.attributes ?? {}).map(([key, attr]) => [key, { state: attr.state, value: attr.state === 'known' ? String(attr.value) : '' }])), { ...draft, skuName: saved.skuAttempt.body.name, stockAvailable: String(saved.skuAttempt.body.stockAvailable ?? ''), stockReserved: String(saved.skuAttempt.body.stockReserved ?? ''), price: String(saved.skuAttempt.body.price ?? ''), currency: saved.skuAttempt.body.priceCurrency ?? 'XXX' })}<button type="button" className={`${button} mt-2`} disabled={busy || loading || !skuConsent} onClick={() => void submitSku(true)}>Reintentar misma creación</button></>}</div>}
          {!saved.skuAttempt && !skuComplete && chosenFamily && <button type="button" className="erp-button-primary" disabled={busy || loading || !skuConsent || hasPendingAttempt || invalidRecovery} onClick={() => void submitSku()}>Crear producto</button>}
        </section>
      </div>}
      {saved.reviewNote && <p role="status" className="mt-4 text-sm">{saved.reviewNote}</p>}
      {error && <p role="alert" className="mt-4 text-sm text-rose-600 dark:text-rose-300">{error}</p>}
      {readError && <p role="alert" className="mt-4 text-sm">{readError}</p>}
      {hydrated && <div className="mt-4 flex justify-end"><button type="button" className={button} disabled={busy || loading} onClick={() => void retryReads()}>{loading ? 'Actualizando…' : 'Actualizar familias e inventario'}</button></div>}
    </div>
  </div>;
}
