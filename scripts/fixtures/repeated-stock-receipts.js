const third = 'Camiseta de boca, tercera equipación, versión jugador';
const rows = [
  ['Boca Titular 2026','M',65000], ['Boca Titular 2026','L',65000],
  ['Boca Titular 2026','XL',65000], ['Boca Titular 2026','XXL',65000],
  ['River Edición 125 Aniversario','M',55000], ['River Edición 125 Aniversario','M',55000],
  ['River Edición 125 Aniversario','L',55000], ['River Edición 125 Aniversario','XXL',55000],
  [third,'S',65000], [third,'M',65000], [third,'L',65000], [third,'XXL',65000],
];
const lines = rows.map(([name,size,amount],index) => `${index+1}\t${index===1 ? `${name}r` : name}\t${size}\t$${amount===55000 ? '55.000' : '65.000'}`);
export const repeatedReceiptText = `ingresaron\n#\tCamiseta\tTalle\tCosto\n${lines.join('\n')}`;
export const repeatedReceiptProduct = { id:'third-L', name:third, productType:'Camiseta',size:'L',unit:'unit',attributes:{},revision:0,stockAvailable:1,stockReserved:0,price:65000,priceCurrency:'ARS' };
export function repeatedReceiptProposal() {
  return {
    contractVersion:1,kind:'proposal',
    actions:rows.map(([name,size,amount],index) => ({
      itemId:`row-${index+1}`,type:'stock.receive',
      target:index===10 ? {kind:'existing',skuId:repeatedReceiptProduct.id} : {kind:'new',sku:{name,productType:'Camiseta',size,unit:'unit'}},
      quantity:{value:1,unit:'unit'},price:{amount,currency:'ARS',policy:index===10 ? 'set' : 'initialize'},
    })),
    evidence:lines.map((quote,index)=>({itemId:`row-${index+1}`,quote})),
  };
}
