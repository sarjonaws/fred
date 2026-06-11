/** Redondea a 2 decimales para evitar errores de punto flotante en montos. */
export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}
