import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate, uuid, trade, woStatus, woPriority, woSource, failureCode } from "../middleware/validate.js";
import { parsePaging, pagedResponse } from "../pagination.js";
import { assertTrade } from "../lib/lookups.js";
import { publishEvent } from "../events.js";
import { closeoutProblems, cancellationProblems } from "../closeout.js";
import { notifyWorkOrderCreated, notifyWorkOrderAssigned, notifyWorkOrderAutoAssigned, notifyWorkOrderCompleted, notifyWorkOrderCancelled, notifyWorkOrderWithdrawn } from "../notifications.js";
import { orgAutoAssignEnabled, pickAutoAssignSupplier } from "../lib/assignment.js";
import { generateInvoiceForWorkOrder } from "../lib/invoices.js";

const router = Router();

// A consumed part on closeout (Phase 9): decrements stock + writes a movement.
const consumedPart = z.object({
  item_id: uuid,
  quantity: z.coerce.number().positive("quantity must be positive"),
});

const createSchema = z.object({
  asset_id: uuid.nullable().optional(),
  room_id: uuid.nullable().optional(),
  trade,
  title: z.string().trim().min(1, "title is required").max(300),
  description: z.string().trim().max(5000).nullable().optional(),
  priority: woPriority.default("normal"),
  source: woSource,
  reported_by_user_id: uuid.nullable().optional(),
  // Phase 11: flag work that needs a permit-to-work before closeout.
  requires_permit: z.boolean().default(false),
  // Phase 4: resident-reported location — portable coordinates validated here
  // and also constrained at the column level.
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
});

const patchSchema = z.object({
  status: woStatus.optional(),
  priority: woPriority.optional(),
  assigned_supplier_id: uuid.nullable().optional(),
  assigned_user_id: uuid.nullable().optional(),
  cost: z.coerce.number().nonnegative().nullable().optional(),
  due_date: z.coerce.date().nullable().optional(),
  // Phase 8 closeout fields — required (and free-text checked) when closing.
  failure_code: failureCode.nullable().optional(),
  root_cause: z.string().trim().max(1000).nullable().optional(),
  remedy: z.string().trim().max(1000).nullable().optional(),
  parts_used: z.string().trim().max(500).nullable().optional(),
  meter_value_at_closeout: z.coerce.number().nonnegative().nullable().optional(),
  // Phase 9: structured parts consumed (decrements inventory). Not a column —
  // stripped before the UPDATE and applied as movements after.
  parts: z.array(consumedPart).max(50).optional(),
  // Cancellation audit — reason required when moving to 'cancelled'. The
  // by/at stamps are server-side only and never accepted from the body.
  cancellation_reason: z.string().trim().max(500).nullable().optional(),
  // Soft archive toggle — maps to archived_at (admin-only, terminal/archived
  // constraints enforced in the handler). Not a column itself.
  archive: z.boolean().optional(),
});

// Bulk archive — admin clears every terminal order of one status from the
// board tabs without destroying reliability/audit data (soft, undoable).
router.post("/archive", validate(z.object({ status: z.enum(["done", "verified", "cancelled"]) })), asyncHandler(async (req, res) => {
  if (req.role !== "admin") throw new ApiError(403, "Only an admin can archive work orders");
  const { rowCount } = await query(
    `UPDATE work_orders SET archived_at = now()
     WHERE organization_id = $1 AND status = $2 AND archived_at IS NULL`,
    [req.orgId, req.body.status]
  );
  res.json({ archived: rowCount });
}));

// Permanent delete — admin only, and only for orders already soft-archived
// (quotes cascade, permits + inventory movements null the work-order link).
router.delete("/:id", asyncHandler(async (req, res) => {
  if (req.role !== "admin") throw new ApiError(403, "Only an admin can delete work orders");
  const { rows } = await query(
    `DELETE FROM work_orders
     WHERE id = $1 AND organization_id = $2
       AND status IN ('done', 'verified', 'cancelled')
       AND archived_at IS NOT NULL
     RETURNING id`,
    [req.params.id, req.orgId]
  );
  if (!rows[0]) {
    // Distinguish "not found" from "must archive first" for the UI.
    const exists = await query(`SELECT id FROM work_orders WHERE id = $1 AND organization_id = $2`, [req.params.id, req.orgId]);
    if (!exists.rows[0]) throw new ApiError(404, "Work order not found");
    throw new ApiError(400, "Only archived terminal work orders can be deleted permanently");
  }
  res.status(204).end();
}));

// GET /api/work-orders?status=open&trade=plumbing&limit=50&offset=0
router.get("/", asyncHandler(async (req, res) => {
  const { status, trade, asset_id, priority } = req.query;
  const { limit, offset } = parsePaging(req.query);
  const conditions = ["w.organization_id = $1"];
  const params = [req.orgId];

  // Phase 10: a supplier (contractor portal) only sees work orders assigned to
  // them or ones still open for bidding — never the whole portfolio.
  if (req.role === "supplier") {
    params.push(req.supplierId);
    conditions.push(`(w.assigned_supplier_id = $${params.length} OR w.status = 'open')`);
  }

  // Phase 4: a tenant only ever sees their own requests.
  if (req.role === "tenant") {
    params.push(req.userId);
    conditions.push(`w.reported_by_user_id = $${params.length} AND w.source = 'tenant_request'`);
  }

  // Phase 14: a technician only sees work orders assigned to them — the rest
  // of the org's board is admin/manager territory, so nobody can meddle in a
  // workflow that does not concern them.
  if (req.role === "technician") {
    params.push(req.userId);
    conditions.push(`w.assigned_user_id = $${params.length}`);
  }

  if (status) { params.push(status); conditions.push(`w.status = $${params.length}`); }
  if (trade) { params.push(trade); conditions.push(`w.trade = $${params.length}`); }
  if (asset_id) { params.push(asset_id); conditions.push(`w.asset_id = $${params.length}`); }
  if (priority) { params.push(priority); conditions.push(`w.priority = $${params.length}`); }

  // Archived orders are hidden from every view by default; `?archived=1`
  // lists only archived rows (for restore / permanent delete).
  if (req.query.archived === "1") {
    conditions.push("w.archived_at IS NOT NULL");
  } else {
    conditions.push("w.archived_at IS NULL");
  }

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT w.*,
            cb.full_name AS cancelled_by_name,
            (SELECT count(*) FROM documents d WHERE d.entity_type = 'work_order' AND d.entity_id = w.id) AS document_count,
            (SELECT i.invoice_number FROM invoices i WHERE i.work_order_id = w.id LIMIT 1) AS invoice_number,
            (w.sla_due_at IS NOT NULL AND w.status NOT IN ('done','verified','cancelled') AND w.sla_due_at < now()) AS sla_breached,
            count(*) OVER() AS total
     FROM work_orders w
     LEFT JOIN users cb ON cb.id = w.cancelled_by_user_id
     WHERE ${conditions.join(" AND ")} ORDER BY
       CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
       w.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json(pagedResponse(rows, { limit, offset }));
}));

// POST /api/work-orders  — used for breakdown reports & tenant requests
// body: { asset_id?, room_id?, trade, title, description?, priority?, source }
router.post("/", validate(createSchema), asyncHandler(async (req, res) => {
  // Phase 4: tenants can only open tenant_request orders, reported by themselves.
  const isTenant = req.role === "tenant";
  const source = isTenant ? "tenant_request" : req.body.source;
  const reported_by_user_id = isTenant ? req.userId : (req.body.reported_by_user_id ?? null);
  const asset_id = isTenant ? null : (req.body.asset_id ?? null);
  const room_id = isTenant ? null : (req.body.room_id ?? null);
  const requires_permit = isTenant ? false : req.body.requires_permit;

  const { trade, title, description, priority } = req.body;
  await assertTrade(req.orgId, trade);

  // Phase 10: stamp an SLA deadline from the priority when the order is opened.
  const slaHours = { urgent: 2, high: 4, normal: 24, low: 72 }[priority] ?? 24;
  const slaDueAt = new Date(Date.now() + slaHours * 3600 * 1000);

  // Fixflo-inspired auto-assignment: when the org opts in, urgent/high reactive
  // requests are routed straight to the least-loaded supplier for the trade
  // (status jumps to 'assigned'; a manual pick or quote-accept can override).
  let autoAssigned = false;
  let autoSupplierId = null;
  if (source !== "plan" && (priority === "urgent" || priority === "high")) {
    if (await orgAutoAssignEnabled(req.orgId)) {
      const picked = await pickAutoAssignSupplier(req.orgId, trade);
      if (picked) {
        autoAssigned = true;
        autoSupplierId = picked.id;
      }
    }
  }

  const { rows } = await query(
    `INSERT INTO work_orders
       (organization_id, asset_id, room_id, trade, title, description, priority, source, reported_by_user_id, sla_due_at, requires_permit, latitude, longitude, assigned_supplier_id, status, auto_assigned)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [req.orgId, asset_id, room_id, trade, title, description || null,
     priority, source, reported_by_user_id, slaDueAt, requires_permit,
     req.body.latitude ?? null, req.body.longitude ?? null,
     autoSupplierId,
     autoAssigned ? "assigned" : "open",
     autoAssigned]
  );
  res.status(201).json(rows[0]);
  // Phase 7: notify the reporter that their request was opened.
  if (reported_by_user_id) {
    await notifyWorkOrderCreated(rows[0], reported_by_user_id);
  }
  // Auto-assign: the chosen supplier's linked accounts are notified in-app so
  // the job lands on their portal without anyone routing it manually.
  if (autoAssigned) {
    await notifyWorkOrderAutoAssigned(rows[0], autoSupplierId);
  }
  // Phase 12: event bus — integrations can react to new work orders.
  await publishEvent(req.orgId, "work_order.created", {
    work_order_id: rows[0].id,
    title: rows[0].title,
    trade: rows[0].trade,
    priority: rows[0].priority,
    status: rows[0].status,
    source: rows[0].source,
    assigned_supplier_id: autoSupplierId,
    auto_assigned: autoAssigned,
  });
}));

// PATCH /api/work-orders/:id — used for status transitions, assignment, cost,
// and closeout. Closing (→ done/verified) requires structured failure data.
router.patch("/:id", validate(patchSchema), asyncHandler(async (req, res) => {
  const { status: nextStatus, cancellation_reason } = req.body;

  // Phase 4: tenants may only withdraw their own open tenant_request orders —
  // every other mutation (advance, assign, close) stays staff-side.
  if (req.role === "tenant" && nextStatus !== "cancelled") {
    throw new ApiError(403, "Tenants cannot modify work orders");
  }

  // Load the current row once — used for transition gating, the permit gate,
  // the technician ownership check, and the cancellation audit.
  const { rows: current } = await query(
    `SELECT w.status AS status,
            w.source,
            w.requires_permit,
            w.reported_by_user_id,
            w.assigned_user_id,
            w.archived_at,
            (SELECT count(*) FROM permits p
             WHERE p.work_order_id = w.id
               AND p.status = 'issued'
               AND (p.expires_at IS NULL OR p.expires_at > now())) AS issued_permits
     FROM work_orders w WHERE w.id = $1 AND w.organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (!current[0]) throw new ApiError(404, "Work order not found");
  const prior = current[0];

  // Phase 14: technicians work only the orders assigned to them and can never
  // reassign anything — assignment and supplier routing stay admin/manager.
  if (req.role === "technician") {
    if (prior.assigned_user_id !== req.userId) {
      throw new ApiError(403, "You can only update work orders assigned to you");
    }
    if (req.body.assigned_user_id !== undefined || req.body.assigned_supplier_id !== undefined) {
      throw new ApiError(403, "Only admins and managers can reassign work orders");
    }
  }

  // Cancellation audit trail — reason required, stamped server-side so it
  // can't be spoofed. Two tiers: a tenant may withdraw their OWN request while
  // it is still open; admins/managers cancel any in-flight work order.
  if (nextStatus === "cancelled") {
    if (req.role === "tenant") {
      if (prior.source !== "tenant_request" || prior.reported_by_user_id !== req.userId) {
        throw new ApiError(403, "You can only withdraw requests you reported");
      }
      if (prior.status !== "open") {
        throw new ApiError(400, "Only unassigned requests can be withdrawn — contact the facilities team once work is assigned");
      }
    } else if (req.role !== "admin" && req.role !== "manager") {
      throw new ApiError(403, "Only admins and managers can cancel work orders");
    } else if (!["open", "assigned", "in_progress"].includes(prior.status)) {
      throw new ApiError(400, `Cannot cancel a work order that is already ${prior.status}`);
    }
    const problems = cancellationProblems(cancellation_reason);
    if (problems.length) throw new ApiError(400, problems.join("; "));
  } else if (nextStatus) {
    // Terminal states are frozen — a done/verified/cancelled order cannot be
    // reopened, re-advanced, or cancelled (drives the UI around the board).
    if (["done", "verified", "cancelled"].includes(prior.status)) {
      throw new ApiError(400, `A ${prior.status} work order cannot change status`);
    }
  }

  // Phase 8: closing a work order demands a failure code + real root cause and
  // remedy. Rejects throwaway answers like "fixed" or "other".
  if (nextStatus === "done" || nextStatus === "verified") {
    const problems = closeoutProblems(req.body, nextStatus);
    if (problems.length) throw new ApiError(400, problems.join("; "));
  }

  // Phase 11: permit-to-work gate — a work order flagged as requiring a permit
  // can only be closed (→ done/verified) while an issued, unexpired permit is
  // on record for it.
  if ((nextStatus === "done" || nextStatus === "verified") && prior.requires_permit && Number(prior.issued_permits) === 0) {
    throw new ApiError(400, "This work order requires an issued permit-to-work before it can be closed");
  }

  // `parts` and `cancellation_reason` are not plain columns — parts become
  // inventory movements; the cancel reason is validated above and stamped
  // here with the audit trail.
  const { parts, ...updates } = req.body;
  if (nextStatus === "cancelled") {
    updates.cancelled_at = new Date();
    updates.cancelled_by_user_id = req.userId;
    updates.cancellation_reason = cancellation_reason;
  } else {
    delete updates.cancellation_reason;
  }

  // Soft archive / restore — admin-only; archive requires a terminal state,
  // restore requires the order to actually be archived.
  if (updates.archive === true || updates.archive === false) {
    if (req.role !== "admin") throw new ApiError(403, "Only an admin can archive work orders");
    if (updates.archive) {
      if (!["done", "verified", "cancelled"].includes(prior.status)) {
        throw new ApiError(400, "Only done, verified, or cancelled work orders can be archived");
      }
      updates.archived_at = new Date();
    } else {
      if (!prior.archived_at) throw new ApiError(400, "Work order is not archived");
      updates.archived_at = null;
    }
  }
  delete updates.archive;

  const entries = Object.entries(updates);
  if (!entries.length) throw new ApiError(400, "No valid fields to update");

  const sets = [];
  const params = [];
  for (const [key, value] of entries) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }

  // auto-stamp completed_at when moving to 'done'
  if (updates.status === "done") {
    sets.push(`completed_at = now()`);
  }

  params.push(req.params.id, req.orgId);
  const { rows } = await query(
    `UPDATE work_orders SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $${params.length - 1} AND organization_id = $${params.length}
     RETURNING *`,
    params
  );
  if (!rows[0]) throw new ApiError(404, "Work order not found");
  const wo = rows[0];

  // Capture the asset's closing meter reading into meter_readings (Phase 14
  // aggregates these). Best effort — a recording failure must never fail a
  // closeout, and reading_unit is drawn from the asset's own meter config.
  if (wo.asset_id && updates.meter_value_at_closeout != null && updates.status === "done") {
    try {
      await query(
        `INSERT INTO meter_readings (asset_id, reading_value, reading_unit)
         SELECT $1, $2, COALESCE(meter_unit, '')
         FROM assets WHERE id = $1 AND organization_id = $3`,
        [wo.asset_id, updates.meter_value_at_closeout, req.orgId]
      );
    } catch (err) {
      // non-fatal: closeout already committed
    }
  }

  // Phase 9: consume parts listed on closeout. Best effort like meter capture —
  // insufficient stock or a bad id must never fail the closeout, but it is
  // atomic across the parts: either all movements + decrements apply or none.
  if (updates.status === "done" && Array.isArray(parts) && parts.length) {
    try {
      await withTransaction(async (client) => {
        for (const p of parts) {
          const updated = await client.query(
            `UPDATE inventory_items SET quantity_on_hand = quantity_on_hand - $2
             WHERE id = $1 AND organization_id = $3
               AND quantity_on_hand - $2 >= 0
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
      console.error("[inventory] parts consumption failed", err.message);
    }
  }

  // Fixflo-inspired "report → works → invoice": draft the job's invoice from
  // consumed parts + accepted quote once the work is done. Best-effort and
  // idempotent — a replayed closeout never double-bills.
  if (updates.status === "done" || updates.status === "verified") {
    await generateInvoiceForWorkOrder(req.orgId, wo);
  }

  // Phase 7: notify on assignment and on completion. Best-effort and awaited —
  // a notification failure must never block a status change (the helpers
  // swallow their own errors).
  if (updates.assigned_user_id) await notifyWorkOrderAssigned(wo, updates.assigned_user_id);
  if ((updates.status === "done" || updates.status === "verified") && wo.reported_by_user_id) {
    await notifyWorkOrderCompleted(wo, wo.reported_by_user_id);
  }
  // Cancellations notify the reporter why the work was pulled. Tenant
  // withdrawals instead notify the org's staff so the request doesn't vanish.
  if (updates.status === "cancelled") {
    if (req.role === "tenant") {
      await notifyWorkOrderWithdrawn(wo, wo.cancellation_reason);
    } else if (wo.reported_by_user_id) {
      await notifyWorkOrderCancelled(wo, wo.reported_by_user_id, wo.cancellation_reason);
    }
  }

  // Phase 12: event bus.
  if (updates.assigned_user_id) {
    await publishEvent(req.orgId, "work_order.assigned", {
      work_order_id: wo.id,
      title: wo.title,
      assignee_id: updates.assigned_user_id,
    });
  }
  if (updates.status === "done" || updates.status === "verified") {
    await publishEvent(req.orgId, "work_order.closed", {
      work_order_id: wo.id,
      title: wo.title,
      status: updates.status,
      failure_code: wo.failure_code ?? null,
      cost: wo.cost ?? null,
    });
  }
  if (updates.status === "cancelled") {
    await publishEvent(req.orgId, "work_order.cancelled", {
      work_order_id: wo.id,
      title: wo.title,
      cancelled_by: wo.cancelled_by_user_id,
      reason: wo.cancellation_reason,
    });
  }

  res.json(wo);
}));

export default router;
