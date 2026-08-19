// Procurement (Phase 9) — pure reorder-planning helpers, unit-tested.
// Kept framework-free so the same rules drive both the API recommendations and
// any future client-side calculation.

// Whether an item should appear in reorder recommendations: it has a reorder
// point, and the quantity actually available (on hand minus what is reserved
// for other work) is at or below that point.
export function needsReorder(item) {
  const threshold = Number(item.reorder_threshold ?? item.reorder_point ?? item.min_stock);
  if (threshold == null || Number.isNaN(threshold)) return false;
  const onHand = Number(item.quantity_on_hand ?? 0);
  const reserved = Number(item.reserved_qty ?? 0);
  return onHand - reserved <= threshold;
}

// Suggested order quantity: top the item back up to max_stock when configured
// (that's the procurement target); otherwise fall back to the reorder point as
// a sensible one-time restock amount. Always at least 1 unit.
export function suggestReorderQuantity(item) {
  const onHand = Number(item.quantity_on_hand ?? 0);
  const threshold = Number(item.reorder_threshold ?? item.min_stock ?? 0);
  const max = item.max_stock != null && item.max_stock !== "" ? Number(item.max_stock) : null;
  const target = max != null ? max : Math.max(threshold, 1);
  const qty = Math.ceil(target - onHand);
  return Math.max(qty, 1);
}
