import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import { assertTrade } from "../lib/lookups.js";
import { conflictDecision, syncOpsBodySchema } from "../lib/sync.js";
import { closeoutProblems, cancellationProblems } from "../closeout.js";
import { recordReading } from "../metering.js";
import { publishEvent } from "../events.js";
import { notifyWorkOrderAssigned, notifyWorkOrderCompleted, notifyWorkOrderCancelled } from "../notifications.js";
import { generateInvoiceForWorkOrder } from "../lib/invoices.js";
import {
  ENTITY_TABLES,
  MAX_ATTACHMENT_BYTES,
  contentTypeFor,
  entityBelongsToOrg,
  storeDocument,
} from "../lib/attachments.js";

const router = Router();

// Staff-only: offline field mode and the sync stream are for the workforce,
// not tenants (who only see their own requests) or suppliers (who use the
// contractor portal). Applied to both endpoints below.
router.use(requireRole("admin", "manager", "technician"));

// ---------------------------------------------------------------------------
// GET /api/sync/changes?since=<cursor>&limit=<n>
// Batched, org-scoped change log. `cursor` is the last sync_changes.id the
// device applied; the server returns rows with id > cursor in ascending order.
// Deletes are tombstones (op='delete', payload = the removed row), so devices
// converge on the same set even when a record was removed mid-sync.
// ---------------------------------------------------------------------------
const changesQuery = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

router.get("/changes", validate(changesQuery, "query"), asyncHandler(async (req, res) => {
  const { since, limit } = req.query;
  // Phase 14: a technician's field board carries only the work orders assigned
  // to them (assessed on the row snapshot, so reassignment tombstones and
  // deletes of their own jobs still arrive); reference data stays org-wide.
  // The trigger records the table name as the entity ('work_orders').
  const { rows } = await query(
    `SELECT * FROM sync_changes
     WHERE organization_id = $1 AND id > $2
       AND (
         $3::text <> 'technician'
         OR entity <> 'work_orders'
         OR (payload->>'assigned_user_id')::uuid = $4
       )
     ORDER BY id
     LIMIT $5`,
    [req.orgId, since, req.role, req.userId, limit + 1]
  );
  const has_more = rows.length > limit;
  const changes = has_more ? rows.slice(0, limit) : rows;
  res.json({
    changes,
    cursor: changes.length ? changes[changes.length - 1].id : since,
    has_more,
  });
}));

// ---------------------------------------------------------------------------
// POST /api/sync/ops
// A device replays its offline mutations after reconnecting. Each op is
// validated, gated by the same business rules as the online routes, and
// applied with last-write-wins conflict resolution: an op whose
// client_updated_at is older than the server row's updated_at is skipped
// (the server row snapshot is returned so the device converges). Per-op
// results are returned so the device can drop successes and retry failures.
// ---------------------------------------------------------------------------
router.post("/ops", validate(syncOpsBodySchema), asyncHandler(async (req, res) => {
  const stale = await resolveBatchStaleness(req, req.body.ops);
  // client_id -> server_entity_id for work_order.create ops applied earlier in
  // this ordered batch, so a document.create that references the temp id of a
  // work order created in the same offline session lands on the real row.
  const idMap = new Map();
  const results = [];
  for (const op of req.body.ops) {
    const result = await applySyncOp(req, op, stale, idMap);
    if (result.ok && result.entity === "work_order" && op.client_id) {
      idMap.set(op.client_id, result.server_entity_id);
    }
    results.push(result);
  }
  res.json({ results });
}));

// LWW is resolved once per entity against the PRE-batch server state. A device
// replays an ordered session (e.g. take → start work → close out) in one batch;
// without this, the first op bumping updated_at to now() would make the rest of
// the device's own session look stale and skip it. Entities whose newest queued
// write is older than the server row are skipped as a group, so a concurrent
// server-side edit still wins over the whole offline session.
async function resolveBatchStaleness(req, ops) {
  const entityTable = (op) =>
    op.op === "asset.update" ? "assets" : op.op.startsWith("work_order.") ? "work_orders" : null;

  const latest = new Map(); // `${table}:${id}` -> { ts, op }
  for (const op of ops) {
    const table = entityTable(op);
    if (!table || !op.entity_id) continue;
    const key = `${table}:${op.entity_id}`;
    const ts = new Date(op.client_updated_at).getTime();
    if (!Number.isFinite(ts)) continue;
    const prev = latest.get(key);
    if (!prev || ts > prev.ts) latest.set(key, { ts, op });
  }

  const stale = new Map();
  for (const [key, { op }] of latest) {
    const [table, id] = key.split(":");
    const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1 AND organization_id = $2`, [id, req.orgId]);
    if (!rows[0]) {
      stale.set(key, { reason: "stale — the record no longer exists on the server", row: null, server_updated_at: null });
    } else if (conflictDecision(op.client_updated_at, rows[0].updated_at) === "stale") {
      stale.set(key, { reason: "stale — a newer change exists on the server", row: rows[0], server_updated_at: rows[0].updated_at });
    }
  }
  return stale;
}

async function applySyncOp(req, op, stale, idMap) {
  const base = {
    op: op.op,
    entity_id: op.entity_id ?? null,
    client_id: op.client_id ?? null,
    device_id: req.body.device_id ?? null,
  };
  if (op.entity_id) {
    const table = op.op === "asset.update" ? "assets" : op.op.startsWith("work_order.") ? "work_orders" : null;
    if (table) {
      const s = stale.get(`${table}:${op.entity_id}`);
      if (s) return { ...base, ok: false, skipped: true, reason: s.reason, row: s.row, server_updated_at: s.server_updated_at };
    }
  }
  try {
    switch (op.op) {
      case "work_order.update":
        return { ...base, ...(await applyWorkOrderUpdate(req, op)) };
      case "work_order.create":
        return { ...base, ...(await applyWorkOrderCreate(req, op)) };
      case "meter_reading.create":
        return { ...base, ...(await applyMeterReading(req, op)) };
      case "inventory_movement.create":
        return { ...base, ...(await applyInventoryMovement(req, op)) };
      case "asset.update":
        return { ...base, ...(await applyAssetUpdate(req, op)) };
      case "document.create":
        // Evidence attached to a work order created earlier in the same offline
        // batch uses the device's temp id; remap it to the server row so the
        // attachment lands on the real work order instead of 404-ing.
        if (op.data?.entity_type === "work_order" && idMap.has(op.data.entity_id)) {
          op = { ...op, data: { ...op.data, entity_id: idMap.get(op.data.entity_id) } };
        }
        return { ...base, ...(await applyDocumentCreate(req, op)) };
      default:
        return { ...base, ok: false, error: `Unsupported op ${op.op}` };
    }
  } catch (err) {
    return { ...base, ok: false, error: err instanceof ApiError ? err.message : err.message };
  }
}

async function applyWorkOrderUpdate(req, { entity_id: woId, client_updated_at, data }) {
  const { rows: current } = await query(
    `SELECT w.*,
            (SELECT count(*) FROM permits p
             WHERE p.work_order_id = w.id AND p.status = 'issued'
               AND (p.expires_at IS NULL OR p.expires_at > now())) AS issued_permits
     FROM work_orders w WHERE w.id = $1 AND w.organization_id = $2`,
    [woId, req.orgId]
  );
  if (!current[0]) throw new ApiError(404, "Work order not found");
  const prior = current[0];

  // Phase 14: technicians replay only their own assigned work orders, and the
  // offline path applies the same no-reassignment rule as the online route.
  if (req.role === "technician") {
    if (prior.assigned_user_id !== req.userId) {
      throw new ApiError(403, "You can only update work orders assigned to you");
    }
    if (data.assigned_user_id !== undefined || data.assigned_supplier_id !== undefined) {
      throw new ApiError(403, "Only admins and managers can reassign work orders");
    }
  }

  const nextStatus = data.status;
  const { parts, ...updates } = data;

  if (nextStatus === "cancelled") {
    if (!["open", "assigned", "in_progress"].includes(prior.status)) {
      throw new ApiError(400, `Cannot cancel a work order that is already ${prior.status}`);
    }
    const problems = cancellationProblems(data.cancellation_reason);
    if (problems.length) throw new ApiError(400, problems.join("; "));
  } else if (nextStatus) {
    if (["done", "verified", "cancelled"].includes(prior.status)) {
      throw new ApiError(400, `A ${prior.status} work order cannot change status`);
    }
  }

  if (nextStatus === "done" || nextStatus === "verified") {
    const problems = closeoutProblems(data, nextStatus);
    if (problems.length) throw new ApiError(400, problems.join("; "));
  }

  if ((nextStatus === "done" || nextStatus === "verified") && prior.requires_permit && Number(prior.issued_permits) === 0) {
    throw new ApiError(400, "This work order requires an issued permit-to-work before it can be closed");
  }

  if (nextStatus === "cancelled") {
    updates.cancelled_at = new Date();
    updates.cancelled_by_user_id = req.userId;
    updates.cancellation_reason = data.cancellation_reason;
  } else {
    delete updates.cancellation_reason;
  }

  const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (!entries.length && nextStatus !== "done" && nextStatus !== "cancelled") {
    throw new ApiError(400, "No valid fields to update");
  }

  const sets = [];
  const params = [];
  for (const [key, value] of entries) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  if (updates.status === "done") sets.push(`completed_at = now()`);

  params.push(woId, req.orgId);
  const { rows } = await query(
    `UPDATE work_orders SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $${params.length - 1} AND organization_id = $${params.length}
     RETURNING *`,
    params
  );
  const wo = rows[0];

  // Capture the closing meter reading (best-effort, like the online route).
  if (wo.asset_id && updates.meter_value_at_closeout != null && updates.status === "done") {
    try {
      await query(
        `INSERT INTO meter_readings (asset_id, reading_value, reading_unit)
         SELECT $1, $2, COALESCE(meter_unit, '')
         FROM assets WHERE id = $1 AND organization_id = $3`,
        [wo.asset_id, updates.meter_value_at_closeout, req.orgId]
      );
    } catch (err) { /* non-fatal */ }
  }

  // Phase 9: consume parts listed on closeout (best-effort, like the online
  // route).
  if (updates.status === "done" && Array.isArray(parts) && parts.length) {
    try {
      await withTransaction(async (client) => {
        for (const p of parts) {
          const updated = await client.query(
            `UPDATE inventory_items SET quantity_on_hand = quantity_on_hand - $2
             WHERE id = $1 AND organization_id = $3 AND quantity_on_hand - $2 >= 0
             RETURNING id`,
            [p.item_id, p.quantity, req.orgId]
          );
          if (!updated.rowCount) throw new Error(`insufficient stock for item ${p.item_id}`);
          await client.query(
            `INSERT INTO inventory_movements (inventory_item_id, work_order_id, quantity_change, reason)
             VALUES ($1, $2, $3, $4)`,
            [p.item_id, wo.id, -p.quantity, `Consumed on "${wo.title}"`]
          );
        }
      });
    } catch (err) {
      console.error("[sync] parts consumption failed", err.message);
    }
  }

  // Fixflo-inspired invoice drafting for offline closeouts too — parts +
  // accepted quote are netted into an INV-<year>-<seq> draft. Best-effort and
  // idempotent (a replayed closeout never double-bills).
  if (updates.status === "done" || updates.status === "verified") {
    await generateInvoiceForWorkOrder(req.orgId, wo);
  }

  if (updates.assigned_user_id) await notifyWorkOrderAssigned(wo, updates.assigned_user_id);
  if ((updates.status === "done" || updates.status === "verified") && wo.reported_by_user_id) {
    await notifyWorkOrderCompleted(wo, wo.reported_by_user_id);
  }
  if (updates.status === "cancelled" && wo.reported_by_user_id) {
    await notifyWorkOrderCancelled(wo, wo.reported_by_user_id, wo.cancellation_reason);
  }
  if (updates.assigned_user_id) {
    await publishEvent(req.orgId, "work_order.assigned", { work_order_id: wo.id, title: wo.title, assignee_id: updates.assigned_user_id });
  }
  if (updates.status === "done" || updates.status === "verified") {
    await publishEvent(req.orgId, "work_order.closed", { work_order_id: wo.id, title: wo.title, status: updates.status, failure_code: wo.failure_code ?? null, cost: wo.cost ?? null });
  }
  if (updates.status === "cancelled") {
    await publishEvent(req.orgId, "work_order.cancelled", { work_order_id: wo.id, title: wo.title, cancelled_by: wo.cancelled_by_user_id, reason: wo.cancellation_reason });
  }

  return { ok: true, entity: "work_order", server_entity_id: wo.id, row: wo, server_updated_at: wo.updated_at };
}

async function applyWorkOrderCreate(req, { data, client_id }) {
  await assertTrade(req.orgId, data.trade);
  // Idempotency: a work_order.create carries the device's client_id so a retry
  // (lost response, or a background-sync flush racing the app) cannot create a
  // duplicate work order. A matching row is returned as a success with the
  // original server id — the same contract a first-time apply reports.
  if (client_id) {
    const { rows: existing } = await query(
      `SELECT * FROM work_orders WHERE client_id = $1 AND organization_id = $2`,
      [client_id, req.orgId]
    );
    if (existing[0]) {
      return { ok: true, entity: "work_order", server_entity_id: existing[0].id, row: existing[0], server_updated_at: existing[0].updated_at };
    }
  }
  const slaHours = { urgent: 2, high: 4, normal: 24, low: 72 }[data.priority] ?? 24;
  const { rows } = await query(
    `INSERT INTO work_orders
       (organization_id, asset_id, room_id, trade, title, description, priority, source, reported_by_user_id, sla_due_at, requires_permit, client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'breakdown',$8,$9,$10,$11)
     RETURNING *`,
    [req.orgId, data.asset_id ?? null, data.room_id ?? null, data.trade, data.title,
     data.description || null, data.priority, req.userId,
     new Date(Date.now() + slaHours * 3600 * 1000), data.requires_permit, client_id ?? null]
  );
  await publishEvent(req.orgId, "work_order.created", {
    work_order_id: rows[0].id, title: rows[0].title, trade: rows[0].trade,
    priority: rows[0].priority, status: rows[0].status, source: rows[0].source,
  }).catch(() => {});
  return { ok: true, entity: "work_order", server_entity_id: rows[0].id, row: rows[0], server_updated_at: rows[0].updated_at };
}

async function applyMeterReading(req, { data }) {
  const out = await recordReading({
    orgId: req.orgId,
    assetId: data.asset_id,
    readingValue: data.reading_value,
    readingUnit: data.reading_unit,
    recordedAt: data.recorded_at,
    cost: data.cost,
  });
  return { ok: true, entity: "meter_reading", server_entity_id: out.reading.id, asset_id: data.asset_id, row: out.reading };
}

async function applyInventoryMovement(req, { data }) {
  const movement = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT quantity_on_hand, reorder_threshold, name FROM inventory_items WHERE id = $1 AND organization_id = $2`,
      [data.inventory_item_id, req.orgId]
    );
    if (!rows[0]) throw new ApiError(404, "Inventory item not found");
    const nextQty = Number(rows[0].quantity_on_hand) + data.quantity_change;
    if (nextQty < 0) throw new ApiError(400, "Insufficient stock");
    await client.query(
      `UPDATE inventory_items SET quantity_on_hand = $2 WHERE id = $1 AND organization_id = $3`,
      [data.inventory_item_id, nextQty, req.orgId]
    );
    const inserted = await client.query(
      `INSERT INTO inventory_movements (inventory_item_id, work_order_id, quantity_change, reason)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [data.inventory_item_id, data.work_order_id ?? null, data.quantity_change, data.reason ?? null]
    );
    return { movement: inserted.rows[0], item: { name: rows[0].name, reorder_threshold: rows[0].reorder_threshold, quantity_on_hand: nextQty } };
  });
  if (movement.item.reorder_threshold != null && Number(movement.item.quantity_on_hand) <= Number(movement.item.reorder_threshold)) {
    await publishEvent(req.orgId, "inventory.low_stock", {
      item_id: data.inventory_item_id, item_name: movement.item.name,
      quantity_on_hand: String(movement.item.quantity_on_hand),
      reorder_threshold: String(movement.item.reorder_threshold),
    }).catch(() => {});
  }
  return { ok: true, entity: "inventory_movement", server_entity_id: movement.movement.id, item_id: data.inventory_item_id, quantity_on_hand: movement.item.quantity_on_hand, row: movement.movement };
}

async function applyAssetUpdate(req, { entity_id: assetId, client_updated_at, data }) {
  const { rows: current } = await query(
    `SELECT * FROM assets WHERE id = $1 AND organization_id = $2`,
    [assetId, req.orgId]
  );
  if (!current[0]) throw new ApiError(404, "Asset not found");
  const asset = current[0];

  const sets = [];
  const params = [];
  if (data.status !== undefined) { params.push(data.status); sets.push(`status = $${params.length}`); }
  if (data.meter_value !== undefined) { params.push(data.meter_value); sets.push(`meter_value = $${params.length}`); }
  if (data.meter_unit !== undefined) { params.push(data.meter_unit); sets.push(`meter_unit = $${params.length}`); }
  if (data.attributes !== undefined) {
    const merged = { ...(asset.attributes ?? {}), ...data.attributes };
    params.push(merged); sets.push(`attributes = $${params.length}`);
  }
  if (!sets.length) throw new ApiError(400, "No valid fields to update");

  params.push(assetId, req.orgId);
  const { rows } = await query(
    `UPDATE assets SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $${params.length - 1} AND organization_id = $${params.length}
     RETURNING *`,
    params
  );
  return { ok: true, entity: "asset", server_entity_id: assetId, row: rows[0], server_updated_at: rows[0].updated_at };
}

// document.create — offline evidence capture. The base64 payload is decoded,
// size-checked, stored through the object-storage layer, and recorded as a
// documents row against the entity. Same rules as the multipart upload: only
// whitelisted entities, owned by this organization, and capped at 20MB.
async function applyDocumentCreate(req, { data }) {
  if (!(data.entity_type in ENTITY_TABLES)) throw new ApiError(400, "Unsupported entity_type");
  if (!(await entityBelongsToOrg(data.entity_type, data.entity_id, req.orgId))) {
    throw new ApiError(404, "Entity not found in this organization");
  }
  const buffer = Buffer.from(data.data_base64, "base64");
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new ApiError(400, "file exceeds the 20MB limit");
  }
  const fileName = String(data.file_name || "attachment").replace(/[/\\]/g, "_").slice(0, 200) || "attachment";
  const contentType = data.content_type || contentTypeFor(fileName);
  const row = await storeDocument({
    orgId: req.orgId,
    entityType: data.entity_type,
    entityId: data.entity_id,
    buffer,
    fileName,
    contentType,
    uploadedBy: req.userId,
  });
  return { ok: true, entity: "document", server_entity_id: row.id, row };
}

export default router;
