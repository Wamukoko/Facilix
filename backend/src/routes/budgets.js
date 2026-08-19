import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate, uuid } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  trade: z.string().trim().min(1).max(80),
  property_id: uuid.nullable().optional(),
  fiscal_year: z.coerce.number().int().min(2020).max(2100),
  planned_amount: z.coerce.number().min(0),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const updateSchema = createSchema.partial();

// GET /api/budgets — list budgets with actual spend
router.get("/", requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const { trade, fiscal_year, property_id, format } = req.query;
  const conditions = ["b.organization_id = $1"];
  const params = [req.orgId];

  if (trade) { params.push(trade); conditions.push(`b.trade = $${params.length}`); }
  if (fiscal_year) { params.push(Number(fiscal_year)); conditions.push(`b.fiscal_year = $${params.length}`); }
  if (property_id) { params.push(property_id); conditions.push(`b.property_id = $${params.length}::uuid`); }

  const { rows } = await query(
    `SELECT b.*,
            p.name AS property_name,
            COALESCE(actual.spend, 0) AS actual_spend,
            COALESCE(actual.spent_invoices, 0) AS spent_invoices
     FROM budgets b
     LEFT JOIN properties p ON p.id = b.property_id
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(SUM(CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END), 0) AS spent_invoices,
         COALESCE(SUM(CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END), 0) AS spend
       FROM work_orders wo
       LEFT JOIN invoices i ON i.work_order_id = wo.id
       WHERE wo.organization_id = b.organization_id
         AND wo.trade = b.trade
         AND wo.status IN ('done', 'verified')
         AND wo.archived_at IS NULL
         AND EXTRACT(YEAR FROM COALESCE(wo.completed_at, wo.created_at)) = b.fiscal_year
         AND (b.property_id IS NULL OR wo.asset_id IN (
           SELECT a.id FROM assets a WHERE a.property_id = b.property_id
         ))
     ) actual ON true
     WHERE ${conditions.join(" AND ")}
     ORDER BY b.fiscal_year DESC, b.trade`,
    params
  );

  if (format === "csv") {
    const header = "name,trade,property,fiscal_year,planned_amount,actual_spend,utilization,remaining";
    const body = rows.map((r) => {
      const util = Number(r.planned_amount) > 0 ? ((Number(r.actual_spend) / Number(r.planned_amount)) * 100).toFixed(1) : "0";
      const remaining = (Number(r.planned_amount) - Number(r.actual_spend)).toFixed(2);
      return [r.name, r.trade, r.property_name || "", r.fiscal_year, r.planned_amount, r.actual_spend, `${util}%`, remaining].join(",");
    }).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="budgets.csv"');
    return res.send(`${header}\n${body}`);
  }

  res.json(rows);
}));

// POST /api/budgets
router.post("/", requireRole("admin"), validate(createSchema), asyncHandler(async (req, res) => {
  const { name, trade, property_id, fiscal_year, planned_amount, notes } = req.body;
  const { rows } = await query(
    `INSERT INTO budgets (organization_id, name, trade, property_id, fiscal_year, planned_amount, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.orgId, name, trade, property_id || null, fiscal_year, planned_amount, notes || null]
  );
  res.status(201).json(rows[0]);
}));

// PATCH /api/budgets/:id
router.patch("/:id", requireRole("admin"), validate(updateSchema), asyncHandler(async (req, res) => {
  const { rows: existing } = await query(
    `SELECT id FROM budgets WHERE id = $1 AND organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (!existing[0]) throw new ApiError(404, "Budget not found");

  const fields = req.body;
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) throw new ApiError(400, "Nothing to update");
  sets.push("updated_at = now()");
  params.push(req.params.id, req.orgId);

  const { rows } = await query(
    `UPDATE budgets SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND organization_id = $${params.length} RETURNING *`,
    params
  );
  res.json(rows[0]);
}));

// DELETE /api/budgets/:id
router.delete("/:id", requireRole("admin"), asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM budgets WHERE id = $1 AND organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (!rowCount) throw new ApiError(404, "Budget not found");
  res.status(204).end();
}));

export default router;
