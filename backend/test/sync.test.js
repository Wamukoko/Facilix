import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictDecision, syncOpsBodySchema, syncOpSchema } from "../src/lib/sync.js";

test("conflictDecision applies when the client edit is newer", () => {
  const server = new Date("2026-08-15T10:00:00Z");
  const client = new Date("2026-08-15T10:00:01Z");
  assert.equal(conflictDecision(client, server), "apply");
});

test("conflictDecision skips a stale client edit (server is newer)", () => {
  const server = new Date("2026-08-15T10:00:00Z");
  const client = new Date("2026-08-15T09:59:59Z");
  assert.equal(conflictDecision(client, server), "stale");
});

test("conflictDecision applies on equal timestamps (device wins ties)", () => {
  assert.equal(conflictDecision("2026-08-15T10:00:00Z", "2026-08-15T10:00:00Z"), "apply");
});

test("conflictDecision handles string timestamps and Date inputs", () => {
  assert.equal(conflictDecision("2026-08-15T10:00:01Z", "2026-08-15T10:00:00Z"), "apply");
  assert.equal(conflictDecision("2026-08-15T10:00:00Z", new Date("2026-08-15T10:00:01Z")), "stale");
});

test("conflictDecision treats invalid timestamps as stale (never blindly apply)", () => {
  assert.equal(conflictDecision("not-a-date", new Date("2026-08-15T10:00:00Z")), "stale");
  assert.equal(conflictDecision(new Date("2026-08-15T10:00:01Z"), "not-a-date"), "stale");
});

test("work_order.update op schema requires entity_id, client_updated_at, data", () => {
  assert.ok(syncOpSchema.safeParse({ op: "work_order.update", entity_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", client_updated_at: new Date().toISOString(), data: { status: "in_progress" } }).success);
  assert.equal(syncOpSchema.safeParse({ op: "work_order.update", data: { status: "in_progress" } }).success, false);
  assert.equal(syncOpSchema.safeParse({ op: "work_order.update", entity_id: "nope", client_updated_at: new Date().toISOString(), data: {} }).success, false);
});

test("work_order.update op rejects unknown fields and validates closeout shapes", () => {
  assert.equal(syncOpSchema.safeParse({ op: "work_order.update", entity_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", client_updated_at: new Date().toISOString(), data: { status: "nonsense" } }).success, false);
  assert.equal(syncOpSchema.safeParse({ op: "work_order.update", entity_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", client_updated_at: new Date().toISOString(), data: { parts: [{ item_id: "bad", quantity: 1 }] } }).success, false);
  assert.equal(syncOpSchema.safeParse({ op: "work_order.update", entity_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", client_updated_at: new Date().toISOString(), data: { parts: [{ item_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", quantity: -1 }] } }).success, false);
});

test("work_order.create op coerces and validates shape (trade membership is a runtime DB check)", () => {
  const parsed = syncOpSchema.safeParse({ op: "work_order.create", data: { trade: "plumbing", title: "  Leak  ", priority: "urgent" } });
  assert.ok(parsed.success);
  assert.equal(parsed.data.data.title, "Leak");
  // `trade` is org-configurable, so the schema only checks shape; membership
  // is enforced at runtime by assertTrade against the org's vocabulary.
  assert.ok(syncOpSchema.safeParse({ op: "work_order.create", data: { trade: "not_a_trade", title: "x" } }).success);
  assert.equal(syncOpSchema.safeParse({ op: "work_order.create", data: { trade: "", title: "x" } }).success, false);
  assert.equal(syncOpSchema.safeParse({ op: "work_order.create", data: { trade: "plumbing" } }).success, false);
});

test("meter_reading.create op requires a positive reading for a real asset", () => {
  const ok = syncOpSchema.safeParse({ op: "meter_reading.create", data: { asset_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", reading_value: 150 } });
  assert.ok(ok.success);
  assert.equal(syncOpSchema.safeParse({ op: "meter_reading.create", data: { asset_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", reading_value: -5 } }).success, false);
});

test("inventory_movement.create op requires a non-zero quantity change", () => {
  const id = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
  assert.ok(syncOpSchema.safeParse({ op: "inventory_movement.create", data: { inventory_item_id: id, quantity_change: -2 } }).success);
  assert.equal(syncOpSchema.safeParse({ op: "inventory_movement.create", data: { inventory_item_id: id, quantity_change: 0 } }).success, false);
});

test("asset.update op allows partial field edits", () => {
  const id = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
  assert.ok(syncOpSchema.safeParse({ op: "asset.update", entity_id: id, client_updated_at: new Date().toISOString(), data: { meter_value: 500 } }).success);
  assert.equal(syncOpSchema.safeParse({ op: "asset.update", entity_id: id, client_updated_at: new Date().toISOString(), data: { status: "not_a_status" } }).success, false);
});

test("document.create op accepts base64 evidence and validates shape", () => {
  const b64 = Buffer.from("hello evidence").toString("base64");
  const ok = syncOpSchema.safeParse({
    op: "document.create",
    data: { entity_type: "work_order", entity_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", file_name: "photo.jpg", content_type: "image/jpeg", data_base64: b64 },
  });
  assert.ok(ok.success);
  // A device may attach evidence to a work order it created earlier in the same
  // offline batch, referencing that op's temp client_id — remapped server-side
  // before apply. Unknown ids are rejected per-op at apply time instead.
  assert.ok(syncOpSchema.safeParse({ op: "document.create", data: { entity_type: "work_order", entity_id: "e2e-temp-wo-1", file_name: "photo.jpg", data_base64: b64 } }).success);
  assert.equal(syncOpSchema.safeParse({ op: "document.create", data: { entity_type: "work_order", entity_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", file_name: "photo.jpg", data_base64: "not-base64!" } }).success, false);
  assert.equal(syncOpSchema.safeParse({ op: "document.create", data: { entity_type: "tenant", entity_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", file_name: "photo.jpg", data_base64: b64 } }).success, false);
  assert.equal(syncOpSchema.safeParse({ op: "document.create", data: { entity_type: "work_order", file_name: "photo.jpg", data_base64: b64 } }).success, false);
});

test("ops body caps batch size at 100 and requires at least one op", () => {
  const one = syncOpsBodySchema.safeParse({ ops: [{ op: "work_order.create", data: { trade: "plumbing", title: "x" } }] });
  assert.ok(one.success);
  assert.equal(syncOpsBodySchema.safeParse({ ops: [] }).success, false);
  const tooMany = Array.from({ length: 101 }, () => ({ op: "work_order.create", data: { trade: "plumbing", title: "x" } }));
  assert.equal(syncOpsBodySchema.safeParse({ ops: tooMany }).success, false);
});

test("ops body accepts an optional device_id and rejects unknown ops", () => {
  const parsed = syncOpsBodySchema.safeParse({ device_id: "field-phone-7", ops: [{ op: "work_order.create", data: { trade: "plumbing", title: "x" } }] });
  assert.ok(parsed.success);
  assert.equal(parsed.data.device_id, "field-phone-7");
  assert.equal(syncOpsBodySchema.safeParse({ ops: [{ op: "not.an.op", data: {} }] }).success, false);
});
