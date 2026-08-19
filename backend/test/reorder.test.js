import { test } from "node:test";
import assert from "node:assert/strict";
import { needsReorder, suggestReorderQuantity } from "../src/reorder.js";

test("needsReorder flags items at or below the reorder point", () => {
  assert.equal(needsReorder({ quantity_on_hand: 5, reorder_threshold: 5 }), true);
  assert.equal(needsReorder({ quantity_on_hand: 4, reorder_threshold: 5 }), true);
  assert.equal(needsReorder({ quantity_on_hand: 6, reorder_threshold: 5 }), false);
});

test("needsReorder accounts for reserved stock", () => {
  assert.equal(needsReorder({ quantity_on_hand: 8, reorder_threshold: 5, reserved_qty: 4 }), true);
  assert.equal(needsReorder({ quantity_on_hand: 8, reorder_threshold: 5, reserved_qty: 1 }), false);
});

test("needsReorder is false without a reorder point", () => {
  assert.equal(needsReorder({ quantity_on_hand: 0 }), false);
  assert.equal(needsReorder({ quantity_on_hand: 0, reorder_threshold: null }), false);
});

test("suggestReorderQuantity tops up to max_stock", () => {
  assert.equal(suggestReorderQuantity({ quantity_on_hand: 3, reorder_threshold: 5, max_stock: 12 }), 9);
});

test("suggestReorderQuantity falls back to the reorder point when max_stock unset", () => {
  assert.equal(suggestReorderQuantity({ quantity_on_hand: 1, reorder_threshold: 5 }), 4);
});

test("suggestReorderQuantity never suggests zero or negative", () => {
  assert.equal(suggestReorderQuantity({ quantity_on_hand: 99, max_stock: 10 }), 1);
});
