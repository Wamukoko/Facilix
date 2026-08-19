import { z } from "zod";
import { uuid, trade, woPriority, woStatus, failureCode, assetStatus } from "../middleware/validate.js";

// Phase 13 — offline-first field mode sync contracts. Pure helpers + zod
// schemas kept separate from the route so the LWW policy and op shapes are
// unit-testable without a database.

// Last-write-wins: a device's offline op is applied only when it is not older
// than the server row it is mutating. Returns "apply" or "stale".
export function conflictDecision(clientUpdatedAt, serverUpdatedAt) {
  const c = clientUpdatedAt instanceof Date ? clientUpdatedAt.getTime() : new Date(clientUpdatedAt).getTime();
  const s = serverUpdatedAt instanceof Date ? serverUpdatedAt.getTime() : new Date(serverUpdatedAt).getTime();
  if (!Number.isFinite(c) || !Number.isFinite(s) || s > c) return "stale";
  return "apply";
}

// A consumed part on closeout — mirrors the work-order route's shape.
const consumedPart = z.object({
  item_id: uuid,
  quantity: z.coerce.number().positive("quantity must be positive"),
});

// work_order.create — a technician files a breakdown offline.
const woCreateData = z.object({
  trade,
  title: z.string().trim().min(1, "title is required").max(300),
  description: z.string().trim().max(5000).nullable().optional(),
  priority: woPriority.default("normal"),
  asset_id: uuid.nullable().optional(),
  room_id: uuid.nullable().optional(),
  requires_permit: z.boolean().default(false),
});

// work_order.update — status transitions, assignment, cost, closeout, cancel.
// Mirrors the PATCH body (parts become inventory movements).
const woUpdateData = z.object({
  status: woStatus.optional(),
  priority: woPriority.optional(),
  assigned_supplier_id: uuid.nullable().optional(),
  assigned_user_id: uuid.nullable().optional(),
  cost: z.coerce.number().nonnegative().nullable().optional(),
  due_date: z.coerce.date().nullable().optional(),
  failure_code: failureCode.nullable().optional(),
  root_cause: z.string().trim().max(1000).nullable().optional(),
  remedy: z.string().trim().max(1000).nullable().optional(),
  parts_used: z.string().trim().max(500).nullable().optional(),
  meter_value_at_closeout: z.coerce.number().nonnegative().nullable().optional(),
  parts: z.array(consumedPart).max(50).optional(),
  cancellation_reason: z.string().trim().max(500).nullable().optional(),
});

// meter_reading.create — mirrors the metering engine's single-reading shape.
const meterReadingData = z.object({
  asset_id: uuid,
  reading_value: z.coerce.number().positive("reading_value must be positive"),
  reading_unit: z.string().trim().max(20).optional(),
  recorded_at: z.coerce.date().optional(),
  cost: z.coerce.number().nonnegative().nullable().optional(),
});

// inventory_movement.create — mirrors POST /inventory/:id/movements.
const inventoryMovementData = z.object({
  inventory_item_id: uuid,
  quantity_change: z.coerce.number().refine((v) => v !== 0, "quantity_change must be non-zero"),
  work_order_id: uuid.nullable().optional(),
  reason: z.string().trim().max(300).nullable().optional(),
});

// asset.update — field edits (status, meter, attributes).
const assetUpdateData = z.object({
  status: assetStatus.optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  meter_value: z.coerce.number().nonnegative().nullable().optional(),
  meter_unit: z.string().trim().max(20).nullable().optional(),
});

// document.create — offline evidence capture (photo/video) attached to a
// server-known entity. The file travels as base64 in `data`; the server
// decodes it, stores it through the object-storage layer, and records the
// documents row. 27,000,000 base64 chars ≈ the 20MB multipart cap.
// entity_id is a bounded string, not a strict UUID: a device may attach
// evidence to a work order it created earlier in the same offline batch using
// that op's temp client_id (remapped in routes/sync.js before apply). Unknown
// or malformed ids are rejected per-op at apply time (404), keeping the rest
// of the batch alive.
const documentData = z.object({
  entity_type: z.enum(["asset", "work_order", "property"]),
  entity_id: z.string().trim().min(1, "entity_id is required").max(64),
  file_name: z.string().trim().min(1, "file_name is required").max(300),
  content_type: z.string().trim().max(200).optional(),
  data_base64: z
    .string()
    .min(1, "file data is required")
    .max(27_000_000, "file exceeds the 20MB limit")
    // A linear char-class pattern (no alternation) so validating a large
    // payload cannot overflow the V8 regex stack; padding is length-checked.
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "file data must be base64")
    .refine((s) => s.length % 4 === 0, "file data must be base64"),
});

export const syncOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("work_order.create"), client_id: z.string().max(64).optional(), client_updated_at: z.coerce.date().optional(), data: woCreateData }),
  z.object({ op: z.literal("work_order.update"), entity_id: uuid, client_updated_at: z.coerce.date(), data: woUpdateData }),
  z.object({ op: z.literal("meter_reading.create"), client_id: z.string().max(64).optional(), client_updated_at: z.coerce.date().optional(), data: meterReadingData }),
  z.object({ op: z.literal("inventory_movement.create"), client_id: z.string().max(64).optional(), client_updated_at: z.coerce.date().optional(), data: inventoryMovementData }),
  z.object({ op: z.literal("asset.update"), entity_id: uuid, client_updated_at: z.coerce.date(), data: assetUpdateData }),
  z.object({ op: z.literal("document.create"), client_id: z.string().max(64).optional(), data: documentData }),
]);

export const syncOpsBodySchema = z.object({
  device_id: z.string().max(100).optional(),
  ops: z.array(syncOpSchema).min(1, "at least one op is required").max(100),
});
