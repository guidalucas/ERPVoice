import {useState} from 'react';
import type {Pedido,Product} from '../../domain/types';
import type {OrderReconciliationRequest} from '../../services/productService';

type Props = {
  pedido: Pedido;
  products: Product[];
  review: OrderReconciliationRequest | undefined;
  disabled: boolean;
  onReview: (request: OrderReconciliationRequest) => void;
  onConfirm: (request: OrderReconciliationRequest) => void;
  onModify: () => void;
};

export function OrderReconciliationForm({pedido,products,review,disabled,onReview,onConfirm,onModify}:Props) {
  const [productId,setProductId]=useState('');
  const [reason,setReason]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const prepare=()=>{
    const product=products.find((entry)=>entry.id===productId);
    if(!product || !reason.trim()){setError('Elegí el producto exacto y explicá el motivo de la conciliación.');return;}
    if(!product.identityFingerprint || !Number.isSafeInteger(product.revision)){setError('Actualizá el inventario antes de revisar este producto.');return;}
    if(product.stockAvailable<pedido.qty){setError('El disponible no alcanza para atribuir el pedido histórico completo. Revisá el inventario primero.');return;}
    setConfirmed(false);setError(null);
    onReview({operationId:crypto.randomUUID(),expectedRevision:pedido.revision??0,reconciliation:{
      productId:product.id,expectedProductRevision:product.revision!,expectedFingerprint:product.identityFingerprint,
      available:product.stockAvailable,reserved:product.stockReserved,quantity:pedido.qty,unit:product.unit??'unit',reason:reason.trim(),confirmed:true,
    }});
  };
  return <fieldset disabled={disabled} className="inventory-row max-w-lg space-y-3 p-3 text-left">
    <legend className="px-1 text-sm font-semibold">Conciliar pedido histórico</legend>
    <p className="text-xs text-[color:var(--muted)]">Este pedido no tiene un ingreso verificable. La conciliación atribuye stock existente y deja una auditoría; no agrega unidades.</p>
    {!review ? <>
      <label className="block text-sm">Producto del ingreso histórico
        <select aria-label={`Producto histórico para ${pedido.producto}`} className="erp-input mt-1" value={productId} onChange={(event)=>setProductId(event.target.value)}>
          <option value="">Elegir producto y variante…</option>
          {products.map((product)=><option key={product.id} value={product.id}>{product.name}{product.size?` · ${product.size}`:''} · {product.id}</option>)}
        </select>
      </label>
      <label className="block text-sm">Motivo de conciliación
        <input aria-label={`Motivo histórico para ${pedido.producto}`} className="erp-input mt-1" value={reason} onChange={(event)=>setReason(event.target.value)}/>
      </label>
      {error&&<p role="alert" className="text-sm text-rose-700">{error}</p>}
      <button type="button" className="erp-button-secondary" onClick={prepare}>Revisar conciliación</button>
    </> : <>
      <p className="text-sm">Código del producto revisado: {review.reconciliation.productId}. Disponible: {review.reconciliation.available}; reservado: {review.reconciliation.reserved}.</p>
      <p className="text-sm">Se atribuirán {review.reconciliation.quantity} {review.reconciliation.unit} existentes. El stock queda igual.</p>
      <p className="text-xs text-[color:var(--muted)]">Motivo: {review.reconciliation.reason}</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={confirmed} onChange={(event)=>setConfirmed(event.target.checked)}/>
        Confirmo que el stock revisado incluye estas unidades del pedido histórico.
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="erp-button-primary" disabled={!confirmed} onClick={()=>{if(confirmed)onConfirm(review);}}>Confirmar conciliación</button>
        <button type="button" className="erp-button-secondary" onClick={()=>{setConfirmed(false);onModify();}}>Modificar conciliación</button>
      </div>
    </>}
  </fieldset>;
}
