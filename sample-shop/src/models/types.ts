/** Niveles de cliente que determinan beneficios de pricing y envío. */
export enum CustomerTier { BASIC = "basic", PREMIUM = "premium", ENTERPRISE = "enterprise" }

export interface Customer { id: string; email: string; tier: CustomerTier; }

export interface OrderItem { sku: string; quantity: number; unitPrice: number; }

export interface Order { id: string; customer: Customer; items: OrderItem[]; couponCode?: string; }
