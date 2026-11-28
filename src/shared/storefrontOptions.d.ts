export type StorefrontMethod = { key: string; label: string; icon: string; brand?: boolean };
export const paymentMethods: readonly StorefrontMethod[];
export const shippingMethods: readonly StorefrontMethod[];
export function selectedPaymentMethods(info?: { payments?: string; paymentMethods?: string[] }): string[];
export const storefrontIconNames: string[];
