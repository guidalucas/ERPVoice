export function formatMoneyAmount(amount, currency, digits) {
  const units = BigInt(amount), scale = 10n ** BigInt(digits), decimals = (units % scale).toString().padStart(digits, '0');
  return `${currency} $ ${(units / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${Number(decimals) ? ',' + decimals : ''}`;
}
