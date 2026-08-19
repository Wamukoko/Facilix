import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate, trade } from "../middleware/validate.js";
import { assertTrade } from "../lib/lookups.js";
import { parsePaging, pagedResponse } from "../pagination.js";

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
  trade,
  contact_name: z.string().trim().max(120).nullable().optional(),
  contact_email: z.string().trim().toLowerCase().email("a valid email is required").max(200).nullable().optional(),
  contact_phone: z.string().trim().max(30).nullable().optional(),
  is_internal: z.boolean().optional(),
});

// GET /api/suppliers?trade=plumbing&limit=50&offset=0
router.get("/", asyncHandler(async (req, res) => {
  const { trade } = req.query;
  const { limit, offset } = parsePaging(req.query);
  const conditions = ["organization_id = $1"];
  const params = [req.orgId];
  if (trade) { params.push(trade); conditions.push(`trade = $${params.length}`); }

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT *, count(*) OVER() AS total FROM suppliers WHERE ${conditions.join(" AND ")}
     ORDER BY name LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json(pagedResponse(rows, { limit, offset }));
}));

// POST /api/suppliers
// body: { name, trade, contact_name?, contact_email?, contact_phone?, is_internal? }
router.post("/", validate(createSchema), asyncHandler(async (req, res) => {
  const { name, trade, contact_name, contact_email, contact_phone, is_internal } = req.body;
  await assertTrade(req.orgId, trade);

  const { rows } = await query(
    `INSERT INTO suppliers (organization_id, name, trade, contact_name, contact_email, contact_phone, is_internal)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.orgId, name, trade, contact_name || null, contact_email || null, contact_phone || null, !!is_internal]
  );
  res.status(201).json(rows[0]);
}));

// GET /api/suppliers/:id/scorecard — bidding + SLA performance (Phase 10)
router.get("/:id/scorecard", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows: sup } = await query(
    `SELECT id FROM suppliers WHERE id = $1 AND organization_id = $2`,
    [id, req.orgId]
  );
  if (!sup[0]) throw new ApiError(404, "Supplier not found");

  const { rows } = await query(
    `SELECT
       (SELECT count(*) FROM quotes WHERE organization_id = $1 AND supplier_id = $2) AS total_quotes,
       (SELECT count(*) FROM quotes WHERE organization_id = $1 AND supplier_id = $2 AND status = 'accepted') AS accepted_quotes,
       (SELECT COALESCE(avg(amount), 0) FROM quotes WHERE organization_id = $1 AND supplier_id = $2 AND status = 'accepted') AS avg_accepted_amount,
       (SELECT count(*) FROM work_orders WHERE organization_id = $1 AND assigned_supplier_id = $2 AND status NOT IN ('done','verified','cancelled')) AS open_jobs,
       (SELECT count(*) FROM work_orders WHERE organization_id = $1 AND assigned_supplier_id = $2 AND status IN ('done','verified')) AS completed_jobs,
       (SELECT count(*) FROM work_orders WHERE organization_id = $1 AND assigned_supplier_id = $2 AND sla_due_at IS NOT NULL AND status NOT IN ('done','verified','cancelled') AND sla_due_at < now()) AS sla_breached_jobs`,
    [req.orgId, id]
  );
  res.json(rows[0]);
}));

// GET /api/suppliers/:id/quotes — supplier's own quotes with work order context
router.get("/:id/quotes", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows: sup } = await query(
    `SELECT id FROM suppliers WHERE id = $1 AND organization_id = $2`,
    [id, req.orgId]
  );
  if (!sup[0]) throw new ApiError(404, "Supplier not found");

  const { rows } = await query(
    `SELECT q.*, s.name AS supplier_name, w.title AS work_order_title, w.status AS work_order_status
     FROM quotes q
     JOIN suppliers s ON s.id = q.supplier_id
     LEFT JOIN work_orders w ON w.id = q.work_order_id
     WHERE q.organization_id = $1 AND q.supplier_id = $2
     ORDER BY q.created_at DESC`,
    [req.orgId, id]
  );
  res.json({ data: rows });
}));

export default router;
