import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate, uuid, trade } from "../middleware/validate.js";
import { assertTrade } from "../lib/lookups.js";
import { parsePaging, pagedResponse } from "../pagination.js";
import { publishEvent } from "../events.js";
import { needsReorder, suggestReorderQuantity } from "../reorder.js";

const router = Router();

const locationType = z.enum(["warehouse", "van"]);

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
  trade: trade.nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  quantity_on_hand: z.coerce.number().nonnegative().default(0),
  reorder_threshold: z.coerce.number().nonnegative().nullable().optional(),
  min_stock: z.coerce.number().nonnegative().nullable().optional(),
  max_stock: z.coerce.number().nonnegative().nullable().optional(),
  location_type: locationType.optional(),
  warehouse_location: z.string().trim().max(120).nullable().optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200).optional(),
  trade: trade.nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  quantity_on_hand: z.coerce.number().nonnegative().optional(),
  reorder_threshold: z.coerce.number().nonnegative().nullable().optional(),
  min_stock: z.coerce.number().nonnegative().nullable().optional(),
  max_stock: z.coerce.number().nonnegative().nullable().optional(),
  location_type: locationType.optional(),
  warehouse_location: z.string().trim().max(120).nullable().optional(),
});

const movementSchema = z.object({
  quantity_change: z.coerce.number().refine((v) => v !== 0, "quantity_change must be non-zero"),
  work_order_id: uuid.nullable().optional(),
  reason: z.string().trim().max(300).nullable().optional(),
});

const reservationSchema = z.object({
  quantity: z.coerce.number().positive("quantity must be positive"),
  work_order_id: uuid.nullable().optional(),
  reason: z.string().trim().max(300).nullable().optional(),
});

// GET /api/inventory?trade=plumbing&low=1&location=van&limit=50&offset=0
// low=1 returns only items at or below their reorder threshold.
router.get("/", asyncHandler(async (req, res) => {
  const { trade: tradeFilter, low, location } = req.query;
  const { limit, offset } = parsePaging(req.query);
  const conditions = ["i.organization_id = $1"];
  const params = [req.orgId];

  if (tradeFilter) { params.push(tradeFilter); conditions.push(`i.trade = $${params.length}`); }
  if (low === "1") {
    conditions.push(`i.reorder_threshold IS NOT NULL AND i.quantity_on_hand <= i.reorder_threshold`);
  }
  if (location === "van" || location === "warehouse") {
    params.push(location);
    conditions.push(`i.location_type = $${params.length}`);
  }

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT i.*,
       COALESCE((SELECT sum(r.quantity) FROM reservations r
         WHERE r.inventory_item_id = i.id AND r.status = 'active'), 0) AS reserved_qty,
       count(*) OVER() AS total
     FROM inventory_items i
     WHERE ${conditions.join(" AND ")}
     ORDER BY i.name LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json(pagedResponse(rows, { limit, offset }));
}));

// POST /api/inventory
router.post("/", validate(createSchema), asyncHandler(async (req, res) => {
  const { name, trade, unit, quantity_on_hand, reorder_threshold, min_stock, max_stock, location_type, warehouse_location } = req.body;
  if (trade) await assertTrade(req.orgId, trade);
  const { rows } = await query(
    `INSERT INTO inventory_items (organization_id, name, trade, unit, quantity_on_hand, reorder_threshold, min_stock, max_stock, location_type, warehouse_location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.orgId, name, trade || null, unit || null, quantity_on_hand, reorder_threshold ?? null, min_stock ?? null, max_stock ?? null, location_type || "warehouse", warehouse_location || null]
  );
  res.status(201).json(rows[0]);
}));

// PATCH /api/inventory/:id
router.patch("/:id", validate(patchSchema), asyncHandler(async (req, res) => {
  const entries = Object.entries(req.body);
  if (!entries.length) throw new ApiError(400, "No valid fields to update");

  const sets = [];
  const params = [];
  for (const [key, value] of entries) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }

  params.push(req.params.id, req.orgId);
  const { rows } = await query(
    `UPDATE inventory_items SET ${sets.join(", ")}
     WHERE id = $${params.length - 1} AND organization_id = $${params.length}
     RETURNING *`,
    params
  );
  if (!rows[0]) throw new ApiError(404, "Inventory item not found");
  res.json(rows[0]);
}));

// DELETE /api/inventory/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM inventory_items WHERE id = $1 AND organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (!rowCount) throw new ApiError(404, "Inventory item not found");
  res.status(204).end();
}));

// POST /api/inventory/:id/movements
// body: { quantity_change, work_order_id?, reason? }  — negative consumes, positive restocks.
router.post("/:id/movements", validate(movementSchema), asyncHandler(async (req, res) => {
  const { quantity_change, work_order_id, reason } = req.body;

  const movement = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT quantity_on_hand FROM inventory_items
       WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!rows[0]) throw new ApiError(404, "Inventory item not found");

    const nextQty = Number(rows[0].quantity_on_hand) + quantity_change;
    if (nextQty < 0) throw new ApiError(400, "Insufficient stock");

    await client.query(
      `UPDATE inventory_items SET quantity_on_hand = $2 WHERE id = $1 AND organization_id = $3`,
      [req.params.id, nextQty, req.orgId]
    );
    const inserted = await client.query(
      `INSERT INTO inventory_movements (inventory_item_id, work_order_id, quantity_change, reason)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, work_order_id || null, quantity_change, reason || null]
    );
    return inserted.rows[0];
  });

  // Phase 12: event bus — flag stock dropping to its reorder threshold.
  if (quantity_change < 0) {
    const { rows: item } = await query(
      `SELECT name, unit, quantity_on_hand, reorder_threshold FROM inventory_items
       WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (item[0] && item[0].reorder_threshold != null && Number(item[0].quantity_on_hand) <= Number(item[0].reorder_threshold)) {
      await publishEvent(req.orgId, "inventory.low_stock", {
        item_id: req.params.id,
        item_name: item[0].name,
        quantity_on_hand: String(item[0].quantity_on_hand),
        reorder_threshold: String(item[0].reorder_threshold),
      });
    }
  }

  res.status(201).json(movement);
}));

// GET /api/inventory/:id/movements
router.get("/:id/movements", asyncHandler(async (req, res) => {
  const { limit, offset } = parsePaging(req.query);
  const params = [req.params.id, req.orgId, limit, offset];
  const { rows } = await query(
    `SELECT m.*, count(*) OVER() AS total
     FROM inventory_movements m
     JOIN inventory_items i ON i.id = m.inventory_item_id
     WHERE m.inventory_item_id = $1 AND i.organization_id = $2
     ORDER BY m.created_at DESC
     LIMIT $3 OFFSET $4`,
    params
  );
  res.json(pagedResponse(rows, { limit, offset }));
}));

// GET /api/inventory/reorder-recommendations — items at/below their reorder
// point (net of reservations) with a suggested order quantity + last price.
router.get("/reorder-recommendations", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT i.id, i.name, i.trade, i.unit, i.quantity_on_hand, i.reorder_threshold,
            i.min_stock, i.max_stock,
       COALESCE((SELECT sum(r.quantity) FROM reservations r
         WHERE r.inventory_item_id = i.id AND r.status = 'active'), 0) AS reserved_qty,
       (SELECT poi.unit_cost FROM purchase_order_items poi
          JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE poi.inventory_item_id = i.id AND po.status = 'received' AND po.organization_id = $1
         ORDER BY po.approved_at DESC NULLS LAST, poi.created_at DESC LIMIT 1) AS last_unit_cost
     FROM inventory_items i
     WHERE i.organization_id = $1 AND i.reorder_threshold IS NOT NULL
       AND (i.quantity_on_hand -
            COALESCE((SELECT sum(r.quantity) FROM reservations r
              WHERE r.inventory_item_id = i.id AND r.status = 'active'), 0)) <= i.reorder_threshold
     ORDER BY i.name`,
    [req.orgId]
  );
  const data = rows.map((row) => {
    const suggested_qty = suggestReorderQuantity(row);
    const last_unit_cost = row.last_unit_cost != null ? Number(row.last_unit_cost) : null;
    return {
      ...row,
      suggested_qty,
      last_unit_cost,
      estimated_cost: last_unit_cost != null ? Math.round(suggested_qty * last_unit_cost * 100) / 100 : null,
    };
  });
  res.json({ data, meta: { total: data.length, limit: data.length, offset: 0 } });
}));

// POST /api/inventory/reservations/:id/release
router.post("/reservations/:id/release", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE reservations SET status = 'released'
     WHERE id = $1 AND organization_id = $2 AND status = 'active'
     RETURNING *`,
    [req.params.id, req.orgId]
  );
  if (!rows[0]) throw new ApiError(404, "Active reservation not found");
  res.json(rows[0]);
}));

// POST /api/inventory/:id/reservations — reserve stock (net of other active
// reservations) for a work order or general purpose.
router.post("/:id/reservations", validate(reservationSchema), asyncHandler(async (req, res) => {
  const { quantity, work_order_id, reason } = req.body;
  const reservation = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT quantity_on_hand,
              COALESCE((SELECT sum(r.quantity) FROM reservations r
                WHERE r.inventory_item_id = i.id AND r.status = 'active'), 0) AS reserved_qty
       FROM inventory_items i WHERE i.id = $1 AND i.organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!rows[0]) throw new ApiError(404, "Inventory item not found");
    const available = Number(rows[0].quantity_on_hand) - Number(rows[0].reserved_qty);
    if (quantity > available) {
      throw new ApiError(400, `Insufficient available stock (${available} available)`);
    }
    const inserted = await client.query(
      `INSERT INTO reservations (organization_id, inventory_item_id, work_order_id, quantity, reason, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.orgId, req.params.id, work_order_id || null, quantity, reason || null, req.userId || null]
    );
    return inserted.rows[0];
  });
  res.status(201).json(reservation);
}));

// GET /api/inventory/:id/reservations
router.get("/:id/reservations", asyncHandler(async (req, res) => {
  const { limit, offset } = parsePaging(req.query);
  const params = [req.params.id, req.orgId, limit, offset];
  const { rows } = await query(
    `SELECT r.*, count(*) OVER() AS total
     FROM reservations r
     JOIN inventory_items i ON i.id = r.inventory_item_id
     WHERE r.inventory_item_id = $1 AND i.organization_id = $2
     ORDER BY r.created_at DESC
     LIMIT $3 OFFSET $4`,
    params
  );
  res.json(pagedResponse(rows, { limit, offset }));
}));

// GET /api/inventory/:id/price-history — per-unit cost from received POs.
router.get("/:id/price-history", asyncHandler(async (req, res) => {
  const { limit, offset } = parsePaging(req.query);
  const params = [req.params.id, req.orgId, limit, offset];
  const { rows } = await query(
    `SELECT poi.id, poi.inventory_item_id, poi.quantity, poi.unit_cost,
            po.po_number, po.approved_at, s.name AS supplier_name, count(*) OVER() AS total
     FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.purchase_order_id
     LEFT JOIN suppliers s ON s.id = po.supplier_id
     WHERE poi.inventory_item_id = $1 AND po.organization_id = $2 AND po.status = 'received'
     ORDER BY po.approved_at DESC NULLS LAST, poi.created_at DESC
     LIMIT $3 OFFSET $4`,
    params
  );
  res.json(pagedResponse(rows, { limit, offset }));
}));

export default router;
