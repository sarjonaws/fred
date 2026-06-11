import { Order } from "../models/types.js";
import { calculateSubtotal, applyDiscount, calculateShipping } from "./pricing.js";
import { sendConfirmationEmail } from "./notifications.js";

/** Orquesta el flujo completo de creación de orden: pricing, envío y notificación. */
export class OrderService {
  /** Crea la orden y devuelve el total final cobrado al cliente. */
  createOrder(order: Order): number {
    const subtotal = calculateSubtotal(order);
    const discounted = applyDiscount(order, subtotal);
    const shipping = calculateShipping(order, discounted);
    const total = discounted + shipping;
    sendConfirmationEmail(order.customer.email, total);
    return total;
  }

  /** Recalcula el total de una orden existente (p. ej. tras editar items). */
  recalculate(order: Order): number {
    const subtotal = calculateSubtotal(order);
    return applyDiscount(order, subtotal);
  }
}
