import { Order, CustomerTier } from "../models/types.js";
import { roundMoney } from "../utils/money.js";

/** Calcula el subtotal sumando cantidad x precio unitario de cada item. */
export function calculateSubtotal(order: Order): number {
  return roundMoney(order.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0));
}

/**
 * Regla de negocio central de descuentos:
 * - PREMIUM: 10% sobre el subtotal.
 * - ENTERPRISE: 15% sobre el subtotal.
 * - Cupón "WELCOME10": 10% adicional, solo si el subtotal supera $20.
 */
export function applyDiscount(order: Order, subtotal: number): number {
  let total = subtotal;
  if (order.customer.tier === CustomerTier.PREMIUM) total *= 0.90;
  if (order.customer.tier === CustomerTier.ENTERPRISE) total *= 0.85;
  if (order.couponCode === "WELCOME10" && subtotal > 20) total *= 0.90;
  return roundMoney(total);
}

/**
 * Envío gratis para PREMIUM/ENTERPRISE con órdenes mayores a $50;
 * en cualquier otro caso, tarifa plana de $7.99.
 */
export function calculateShipping(order: Order, totalAfterDiscount: number): number {
  const freeShippingTiers = [CustomerTier.PREMIUM, CustomerTier.ENTERPRISE];
  if (freeShippingTiers.includes(order.customer.tier) && totalAfterDiscount > 50) return 0;
  return 7.99;
}
