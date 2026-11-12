export const MAX_PURCHASE_QUANTITY = 1_000_000_000
export const PURCHASE_QUANTITY_DECIMALS = 3
export const MIN_PURCHASE_QUANTITY = 10 ** -PURCHASE_QUANTITY_DECIMALS

const MAX_QUANTITY_ROUNDING_ERROR = MIN_PURCHASE_QUANTITY / 100

/** Keep API, spreadsheet import and form validation aligned before Decimal storage. */
export function purchaseQuantityError(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '请填写有效数量'
  if (value <= 0) return '数量要大于 0'
  if (value > MAX_PURCHASE_QUANTITY) return `数量不能超过 ${MAX_PURCHASE_QUANTITY}`
  const rounded = Number(value.toFixed(PURCHASE_QUANTITY_DECIMALS))
  // Decimal round-trips avoid multiplication noise at large values. The cap stays
  // below an extra decimal place even if the maximum quantity grows in the future.
  const tolerance = Math.min(Number.EPSILON * Math.max(1, value), MAX_QUANTITY_ROUNDING_ERROR)
  if (value < MIN_PURCHASE_QUANTITY || Math.abs(value - rounded) > tolerance) {
    return `数量最多 ${PURCHASE_QUANTITY_DECIMALS} 位小数`
  }
  return null
}

export function isPurchaseQuantity(value: unknown): value is number {
  return purchaseQuantityError(value) === null
}
