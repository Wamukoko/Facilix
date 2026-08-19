import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate, uuid } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";

const router = Router({ mergeParams: true });

// Suppliers bid on open work orders through the contractor portal. A supplier
// can only submit quotes attributed to their own supplier_id (from the JWT).
const submitSchema = z.object({
  amount: z.coerce.number().positive("amount must be positive"),
  currency: z.string().trim().max(4).default("KES"),
  note: z.string().trim().max(2000).nullable().optional(),
});

// POST /api/work-orders/:id/quotes — supplier submits a quote
router.post(
  "/",
  requireRole("supplier"),
  validate(submitSchema),
  asyncHandler(async (req, res) => {
    const workOrderId = req.params.workOrderId;
    const { amount, currency, note } = req.body;

    const { rows: woRows } = await query(
      `SELECT id, status FROM work_orders WHERE id = $1 AND organization_id = $2`,
      [workOrderId, req.orgId]
    );
    if (!woRows[0]) throw new ApiError(404, "Work order not found");
    if (woRows[0].status !== "open") {
      throw new ApiError(400, "Quotes can only be submitted for open work orders");
    }

    const { rows } = await query(
      `INSERT INTO quotes (organization_id, supplier_id, work_order_id, amount, currency, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.orgId, req.supplierId, workOrderId, amount, currency, note || null]
    );
    res.status(201).json(rows[0]);
  })
);

// GET /api/work-orders/:id/quotes — admins see all; suppliers see only their own
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const workOrderId = req.params.workOrderId;
    const { rows: woRows } = await query(
      `SELECT id FROM work_orders WHERE id = $1 AND organization_id = $2`,
      [workOrderId, req.orgId]
    );
    if (!woRows[0]) throw new ApiError(404, "Work order not found");

    const params = [req.orgId, workOrderId];
    let where = "q.organization_id = $1 AND q.work_order_id = $2";
    if (req.role === "supplier") {
      // suppliers only see their own bids (never a competitor's pricing)
      params.push(req.supplierId);
      where += ` AND q.supplier_id = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT q.*, s.name AS supplier_name FROM quotes q
       JOIN suppliers s ON s.id = q.supplier_id
       WHERE ${where} ORDER BY q.created_at DESC`,
      params
    );
    res.json({ data: rows });
  })
);

// PATCH /api/quotes/:id — admin/manager accepts or rejects a quote.
// Accepting assigns the supplier to the work order and rejects all other bids.
const decideSchema = z.object({ status: z.enum(["accepted", "rejected"]) });

router.patch(
  "/:quoteId",
  requireRole("admin", "manager"),
  validate(decideSchema),
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    const { rows: quoteRows } = await query(
      `SELECT * FROM quotes WHERE id = $1 AND organization_id = $2`,
      [req.params.quoteId, req.orgId]
    );
    if (!quoteRows[0]) throw new ApiError(404, "Quote not found");
    const quote = quoteRows[0];

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE quotes SET status = $1 WHERE id = $2 RETURNING *`,
        [status, quote.id]
      );
      if (status === "accepted") {
        await client.query(
          `UPDATE quotes SET status = 'rejected'
           WHERE work_order_id = $1 AND id <> $2 AND status <> 'rejected'`,
          [quote.work_order_id, quote.id]
        );
        await client.query(
          `UPDATE work_orders SET assigned_supplier_id = $1 WHERE id = $2`,
          [quote.supplier_id, quote.work_order_id]
        );
      }
      return rows[0];
    });
    res.json(result);
  })
);

export default router;
