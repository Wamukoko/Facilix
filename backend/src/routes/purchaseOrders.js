import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate, uuid } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import { parsePaging, pagedResponse } from "../pagination.js";

const router = Router();

const poStatuses = new Set(["draft", "submitted", "approved", "received", "cancelled"]);

const itemSchema = z.object({
  item_id: uuid,
  quantity: z.coerce.number().positive("quantity must be positive"),
  unit_cost: z.coerce.number().nonnegative("unit_cost must be non-negative").default(0),
});

const createSchema = z.object({
  supplier_id: uuid.nullable().optional(),
  contract_id: uuid.nullable().optional(),
  expected_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected_date must be YYYY-MM-DD").nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  items: z.array(itemSchema).max(200).default([]),
});

const patchSchema = z.object({
  supplier_id: uuid.nullable().optional(),
  contract_id: uuid.nullable().optional(),
  expected_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected_date must be YYYY-MM-DD").nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

// Next PO number for the org: 'PO-<year>-<next>' where <next> never reuses a
// number after a delete (max suffix + 1).
function nextPoNumber(rows) {
  const year = new Date().getFullYear();
  const maxSeq = rows.length
    ? Math.max(...rows.map((r) => {
        const m = /^PO-\d{4}-(\d+)$/.exec(r.po_number);
        return m ? Number(m[1]) : 0;
      }))
    : 0;
  return `PO-${year}-${String(maxSeq + 1).padStart(4, "0")}`;
}

async function loadDetail(poId, orgId) {
  const { rows: poRows } = await query(
    `SELECT po.*, s.name AS supplier_name, c.contract_number,
            u.full_name AS ordered_by_name, a.full_name AS approved_by_name
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN contracts c ON c.id = po.contract_id
     LEFT JOIN users u ON u.id = po.ordered_by_user_id
     LEFT JOIN users a ON a.id = po.approved_by_user_id
     WHERE po.id = $1 AND po.organization_id = $2`,
    [poId, orgId]
  );
  if (!poRows[0]) throw new ApiError(404, "Purchase order not found");

  const { rows: items } = await query(
    `SELECT poi.*, i.name AS item_name, i.unit
     FROM purchase_order_items poi
     JOIN inventory_items i ON i.id = poi.inventory_item_id
     WHERE poi.purchase_order_id = $1
     ORDER BY poi.created_at`,
    [poId]
  );
  const total = items.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unit_cost), 0);
  return { ...poRows[0], total, items };
}

// GET /api/purchase-orders?status=draft&limit=50&offset=0
router.get("/", asyncHandler(async (req, res) => {
  const { status } = req.query;
  const { limit, offset } = parsePaging(req.query);
  const params = [req.orgId];
  const conditions = ["po.organization_id = $1"];
  if (status && poStatuses.has(status)) {
    params.push(status);
    conditions.push(`po.status = $${params.length}`);
  }

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT po.*, s.name AS supplier_name, c.contract_number,
            COALESCE((SELECT sum(poi.quantity * poi.unit_cost) FROM purchase_order_items poi
               WHERE poi.purchase_order_id = po.id), 0) AS po_total,
            (SELECT count(*) FROM purchase_order_items poi
               WHERE poi.purchase_order_id = po.id) AS item_count,
            u.full_name AS ordered_by_name,
            count(*) OVER() AS total
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN contracts c ON c.id = po.contract_id
     LEFT JOIN users u ON u.id = po.ordered_by_user_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY po.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const paged = pagedResponse(rows, { limit, offset });
  paged.data = paged.data.map((row) => ({ ...row, total: Number(row.po_total) }));
  res.json(paged);
}));

// POST /api/purchase-orders — create a draft PO, optionally with line items.
// body: { supplier_id?, contract_id?, expected_date?, notes?, items?: [...] }
router.post("/", validate(createSchema), asyncHandler(async (req, res) => {
  const { supplier_id, contract_id, expected_date, notes, items } = req.body;

  const created = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT po_number FROM purchase_orders WHERE organization_id = $1`,
      [req.orgId]
    );
    const po_number = nextPoNumber(existing);

    if (contract_id) {
      const { rows: contract } = await client.query(
        `SELECT id FROM contracts WHERE id = $1 AND organization_id = $2`,
        [contract_id, req.orgId]
      );
      if (!contract[0]) throw new ApiError(400, "Contract not found in this organization");
    }

    const { rows } = await client.query(
      `INSERT INTO purchase_orders (organization_id, po_number, supplier_id, contract_id, ordered_by_user_id, expected_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.orgId, po_number, supplier_id || null, contract_id || null, req.userId || null, expected_date || null, notes || null]
    );

    for (const item of items) {
      const { rows: exists } = await client.query(
        `SELECT id FROM inventory_items WHERE id = $1 AND organization_id = $2`,
        [item.item_id, req.orgId]
      );
      if (!exists[0]) throw new ApiError(400, `Inventory item ${item.item_id} not found in this organization`);
      await client.query(
        `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, quantity, unit_cost)
         VALUES ($1,$2,$3,$4)`,
        [rows[0].id, item.item_id, item.quantity, item.unit_cost]
      );
    }
    return rows[0];
  });

  res.status(201).json(await loadDetail(created.id, req.orgId));
}));

// GET /api/purchase-orders/:id
router.get("/:id", asyncHandler(async (req, res) => {
  res.json(await loadDetail(req.params.id, req.orgId));
}));

// PATCH /api/purchase-orders/:id — edit supplier/contract/expected date/notes while still a draft or submitted.
router.patch("/:id", validate(patchSchema), asyncHandler(async (req, res) => {
  if (req.body.contract_id) {
    const { rows: contract } = await query(
      `SELECT id FROM contracts WHERE id = $1 AND organization_id = $2`,
      [req.body.contract_id, req.orgId]
    );
    if (!contract[0]) throw new ApiError(400, "Contract not found in this organization");
  }
  const { rows } = await query(
    `UPDATE purchase_orders
     SET supplier_id = COALESCE($1, supplier_id),
         contract_id = COALESCE($2, contract_id),
         expected_date = COALESCE($3, expected_date),
         notes = COALESCE($4, notes),
         updated_at = now()
     WHERE id = $5 AND organization_id = $6 AND status IN ('draft', 'submitted')
     RETURNING id`,
    [req.body.supplier_id ?? null, req.body.contract_id ?? null, req.body.expected_date ?? null, req.body.notes ?? null, req.params.id, req.orgId]
  );
  if (!rows[0]) throw new ApiError(404, "Purchase order not found or no longer editable");
  res.json(await loadDetail(req.params.id, req.orgId));
}));

// POST /api/purchase-orders/:id/items — add a line item (draft only).
router.post("/:id/items", validate(itemSchema), asyncHandler(async (req, res) => {
  const { item_id, quantity, unit_cost } = req.body;
  const added = await withTransaction(async (client) => {
    const { rows: po } = await client.query(
      `SELECT status FROM purchase_orders WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!po[0]) throw new ApiError(404, "Purchase order not found");
    if (po[0].status !== "draft") throw new ApiError(400, "Line items can only be added to a draft PO");

    const { rows: exists } = await client.query(
      `SELECT id FROM inventory_items WHERE id = $1 AND organization_id = $2`,
      [item_id, req.orgId]
    );
    if (!exists[0]) throw new ApiError(400, "Inventory item not found in this organization");

    const inserted = await client.query(
      `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, quantity, unit_cost)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, item_id, quantity, unit_cost]
    );
    await client.query(`UPDATE purchase_orders SET updated_at = now() WHERE id = $1`, [req.params.id]);
    return inserted.rows[0];
  });
  res.status(201).json(added);
}));

// DELETE /api/purchase-orders/:id/items/:itemId — remove a line item (draft only).
router.delete("/:id/items/:itemId", asyncHandler(async (req, res) => {
  const { rowCount } = await withTransaction(async (client) => {
    const { rows: po } = await client.query(
      `SELECT status FROM purchase_orders WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!po[0]) throw new ApiError(404, "Purchase order not found");
    if (po[0].status !== "draft") throw new ApiError(400, "Line items can only be removed from a draft PO");
    const result = await client.query(
      `DELETE FROM purchase_order_items WHERE id = $1 AND purchase_order_id = $2`,
      [req.params.itemId, req.params.id]
    );
    await client.query(`UPDATE purchase_orders SET updated_at = now() WHERE id = $1`, [req.params.id]);
    return result;
  });
  if (!rowCount) throw new ApiError(404, "Purchase order item not found");
  res.status(204).end();
}));

// POST /api/purchase-orders/:id/submit — draft → submitted (ready for approval).
router.post("/:id/submit", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE purchase_orders SET status = 'submitted', updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND status = 'draft' RETURNING id`,
    [req.params.id, req.orgId]
  );
  if (!rows[0]) throw new ApiError(400, "Only a draft purchase order can be submitted");
  res.json(await loadDetail(req.params.id, req.orgId));
}));

// POST /api/purchase-orders/:id/approve — submitted → approved (admin/manager).
router.post("/:id/approve", requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE purchase_orders SET status = 'approved', approved_by_user_id = $3, approved_at = now(), updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND status = 'submitted' RETURNING id`,
    [req.params.id, req.orgId, req.userId]
  );
  if (!rows[0]) throw new ApiError(400, "Only a submitted purchase order can be approved");
  res.json(await loadDetail(req.params.id, req.orgId));
}));

// POST /api/purchase-orders/:id/receive — approved → received. Adds the
// ordered quantity to stock for each line (one movement per line) and records
// the unit cost as received price history.
router.post("/:id/receive", asyncHandler(async (req, res) => {
  const received = await withTransaction(async (client) => {
    const { rows: po } = await client.query(
      `SELECT id, po_number, status FROM purchase_orders WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!po[0]) throw new ApiError(404, "Purchase order not found");
    if (po[0].status !== "approved") throw new ApiError(400, "Only an approved purchase order can be received");

    const { rows: items } = await client.query(
      `SELECT id, inventory_item_id, quantity, received_qty FROM purchase_order_items
       WHERE purchase_order_id = $1`,
      [req.params.id]
    );

    for (const item of items) {
      const remaining = Number(item.quantity) - Number(item.received_qty);
      if (remaining <= 0) continue;
      await client.query(
        `UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + $2 WHERE id = $1`,
        [item.inventory_item_id, remaining]
      );
      await client.query(
        `INSERT INTO inventory_movements (inventory_item_id, quantity_change, reason)
         VALUES ($1,$2,$3)`,
        [item.inventory_item_id, remaining, `PO ${po[0].po_number} received`]
      );
      await client.query(
        `UPDATE purchase_order_items SET received_qty = received_qty + $2 WHERE id = $1`,
        [item.id, remaining]
      );
    }

    await client.query(
      `UPDATE purchase_orders SET status = 'received', updated_at = now() WHERE id = $1`,
      [req.params.id]
    );
  });

  res.json(await loadDetail(req.params.id, req.orgId));
}));

// POST /api/purchase-orders/:id/cancel — draft/submitted/approved → cancelled.
router.post("/:id/cancel", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE purchase_orders SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND status IN ('draft', 'submitted', 'approved')
     RETURNING id`,
    [req.params.id, req.orgId]
  );
  if (!rows[0]) throw new ApiError(400, "This purchase order cannot be cancelled");
  res.json(await loadDetail(req.params.id, req.orgId));
}));

// DELETE /api/purchase-orders/:id — remove a draft PO entirely.
router.delete("/:id", asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM purchase_orders WHERE id = $1 AND organization_id = $2 AND status = 'draft'`,
    [req.params.id, req.orgId]
  );
  if (!rowCount) throw new ApiError(404, "Draft purchase order not found");
  res.status(204).end();
}));

export default router;
