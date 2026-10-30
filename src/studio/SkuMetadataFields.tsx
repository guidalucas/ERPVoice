import { getBusinessCategoryPreset } from '../domain/businessCategories';
import type { Candidate, SkuMetadataChange, Variant } from './types';

export function validSkuMetadataChange(input: unknown): input is SkuMetadataChange {
  if (!input || typeof input !== 'object') return false;
  const item = input as SkuMetadataChange;
  return typeof item.skuId === 'string' && Number.isSafeInteger(item.expectedRevision) && item.expectedRevision >= 0 && typeof item.expectedFingerprint === 'string'
    && !!item.changes && !Array.isArray(item.changes) && Object.keys(item.changes).length > 0
    && Object.entries(item.changes).every(([key, value]) => ['productType', 'productModel', 'size'].includes(key) && (value === null || typeof value === 'string'));
}

export function SkuMetadataFields({ category, items, changes, onChange }: {
  category?: string | null;
  items: (Candidate | Variant)[];
  changes: Record<string, SkuMetadataChange>;
  onChange: (value: Record<string, SkuMetadataChange>) => void;
}) {
  const preset = getBusinessCategoryPreset(category);
  const fields: ['productType' | 'productModel' | 'size', string][] = [
    ['productType', preset.productTypeLabel], ['productModel', preset.productModelLabel],
    ...(preset.useVariants && preset.variantLabel ? [['size', preset.variantLabel] as ['size', string]] : []),
  ];
  const edit = (item: Candidate | Variant, key: 'productType' | 'productModel' | 'size', value: string) => {
    const next = { ...changes }, update = next[item.skuId] ?? { skuId: item.skuId, expectedRevision: item.revision, expectedFingerprint: item.identityFingerprint, changes: {} };
    const patch = { ...update.changes };
    if (value.trim() === (item[key] ?? '').trim()) delete patch[key]; else patch[key] = value || null;
    if (Object.keys(patch).length) next[item.skuId] = { ...update, changes: patch }; else delete next[item.skuId];
    onChange(next);
  };
  return <section className="sku-metadata" aria-label="Atributos del rubro">
    <h3>Atributos del rubro · opcionales</h3>
    <p>Completá solo lo que corresponda. Al guardar, los cambios se aplican al SKU en Stocky y en esta ficha.</p>
    {!items.length && <p>Creá la ficha y vinculá sus SKU en «SKU vinculados» para completar estos atributos.</p>}
    {(items.length ? items : [null]).map(item => <div className="sku-metadata-item" role="group" aria-label={item ? `Atributos de ${item.name}${item.size ? ` · ${item.size}` : ''}` : 'Atributos sin SKU vinculado'} key={item?.skuId ?? 'empty'}>
      {item && items.length > 1 && <h4>{item.name}{item.size ? ` · ${item.size}` : ''}</h4>}
      <div className="field-grid">{fields.map(([key, label]) => <label className="field" key={key}><span>{label} · opcional</span>
        <input aria-label={`${label} · opcional`} disabled={!item} maxLength={key === 'size' ? 80 : 180}
          value={item ? Object.prototype.hasOwnProperty.call(changes[item.skuId]?.changes ?? {}, key) ? changes[item.skuId].changes[key] ?? '' : item[key] ?? '' : ''}
          onChange={event => { if (item) edit(item, key, event.target.value); }}/>
      </label>)}</div>
    </div>)}
  </section>;
}
