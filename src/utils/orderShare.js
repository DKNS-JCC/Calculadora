/**
 * Returns the fraction (0–1) of an order's value that belongs to `empresa`.
 * Non-shared orders always return 1 (100%).
 */
export function orderShare(order, empresa) {
  if (!order.is_shared || !order.shared_split) return 1
  return Number(order.shared_split[empresa] ?? 100) / 100
}
