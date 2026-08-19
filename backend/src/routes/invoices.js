import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import { parsePaging, pagedResponse } from "../pagination.js";

const router = Router();

const statusSchema = z.object({
  status: z.enum(["issued", "paid", "void"]),
});

// GET /api/invoices?status=draft&limit=50&offset=0
// Org-scoped; suppliers only see invoices for their own jobs, tenants only for
// work orders they reported.
router.get("/", asyncHandler(async (req, res) => {
  const { status } = req.query;
  const { limit, offset } = parsePaging(req.query);
  const conditions = ["i.organization_id = $1"];
  const params = [req.orgId];

  if (req.role === "supplier") {
    params.push(req.supplierId);
    conditions.push(`i.supplier_id = $${params.length}`);
  } else if (req.role === "tenant") {
    params.push(req.userId);
    conditions.push(`w.reported_by_user_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`i.status = $${params.length}`);
  }

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT i.*, w.title AS work_order_title, w.status AS work_order_status,
            s.name AS supplier_name, count(*) OVER() AS total
     FROM invoices i
     LEFT JOIN work_orders w ON w.id = i.work_order_id
     LEFT JOIN suppliers s ON s.id = i.supplier_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY i.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json(pagedResponse(rows, { limit, offset }));
}));

// PATCH /api/invoices/:id — progress the money trail: draft → issued → paid,
// or void. Only staff can move an invoice.
router.patch("/:id", validate(statusSchema), requireRole("admin", "manager", "technician"), asyncHandler(async (req, res) => {
  const { rows: existing } = await query(
    `SELECT * FROM invoices WHERE id = $1 AND organization_id = $2`,
    [req.params.id, req.orgId]
  );
  const inv = existing[0];
  if (!inv) throw new ApiError(404, "Invoice not found");

  const next = req.body.status;
  const allowed = {
    issued: ["draft"],
    paid: ["issued"],
    void: ["draft", "issued", "paid"],
  }[next];
  if (!allowed.includes(inv.status)) {
    throw new ApiError(400, `Cannot move an invoice from "${inv.status}" to "${next}"`);
  }

  const sets = [`status = $1`];
  const extra = [];
  if (next === "issued") { sets.push(`issued_at = now()`); extra.push(`issued_at`); }
  if (next === "paid") { sets.push(`paid_at = now()`); extra.push(`paid_at`); }
  if (next === "void") { sets.push(`voided_at = now()`); extra.push(`voided_at`); }

  const { rows } = await query(
    `UPDATE invoices SET ${sets.join(", ")} WHERE id = $2 AND organization_id = $3 RETURNING *`,
    [next, req.params.id, req.orgId]
  );
  void extra;
  res.json(rows[0]);
}));

export default router;
