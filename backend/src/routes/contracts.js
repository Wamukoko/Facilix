import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate, uuid } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import { CONTRACT_TYPES, effectiveContractStatus, daysToExpiry, nextContractNumber } from "../lib/contracts.js";
import { checkContractExpiry } from "../scheduler.js";
import { publishEvent } from "../events.js";
import { parsePaging } from "../pagination.js";

const router = Router();

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["active", "expiring", "expired", "terminated"];

const createSchema = z.object({
  contract_type: z.enum(CONTRACT_TYPES),
  supplier_id: uuid.nullable().optional(),
  property_id: uuid.nullable().optional(),
  start_date: z.string().regex(dateRe, "start_date must be YYYY-MM-DD").nullable().optional(),
  end_date: z.string().regex(dateRe, "end_date must be YYYY-MM-DD").nullable().optional(),
  annual_value: z.coerce.number().nonnegative("annual_value must be non-negative").nullable().optional(),
  renewal_notice_days: z.coerce.number().int().min(1, "renewal_notice_days must be at least 1").max(365).default(30),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const patchSchema = z.object({
  contract_type: z.enum(CONTRACT_TYPES).optional(),
  supplier_id: uuid.nullable().optional(),
  property_id: uuid.nullable().optional(),
  start_date: z.string().regex(dateRe, "start_date must be YYYY-MM-DD").nullable().optional(),
  end_date: z.string().regex(dateRe, "end_date must be YYYY-MM-DD").nullable().optional(),
  annual_value: z.coerce.number().nonnegative("annual_value must be non-negative").nullable().optional(),
  renewal_notice_days: z.coerce.number().int().min(1).max(365).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

function assertDates(startDate, endDate) {
  if (startDate && endDate && endDate < startDate) {
    throw new ApiError(400, "end_date must be on or after start_date");
  }
}

async function assertRefs(client, orgId, supplierId, propertyId) {
  if (supplierId) {
    const { rows } = await client.query(
      `SELECT id FROM suppliers WHERE id = $1 AND organization_id = $2`,
      [supplierId, orgId]
    );
    if (!rows[0]) throw new ApiError(400, "Supplier not found in this organization");
  }
  if (propertyId) {
    const { rows } = await client.query(
      `SELECT id FROM properties WHERE id = $1 AND organization_id = $2`,
      [propertyId, orgId]
    );
    if (!rows[0]) throw new ApiError(400, "Property not found in this organization");
  }
}

// POs that count toward contract spend — committed spend (submitted/approved)
// and received goods. Drafts and cancelled orders don't count.
const SPEND_STATUSES = ["submitted", "approved", "received"];

async function loadContract(id, orgId) {
  const { rows } = await query(
    `SELECT c.*, s.name AS supplier_name, p.name AS property_name
     FROM contracts c
     LEFT JOIN suppliers s ON s.id = c.supplier_id
     LEFT JOIN properties p ON p.id = c.property_id
     WHERE c.id = $1 AND c.organization_id = $2`,
    [id, orgId]
  );
  if (!rows[0]) throw new ApiError(404, "Contract not found");
  const contract = rows[0];

  const { rows: pos } = await query(
    `SELECT po.id, po.po_number, po.status, po.expected_date,
            COALESCE((SELECT sum(poi.quantity * poi.unit_cost)
                      FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id), 0) AS po_total
     FROM purchase_orders po
     WHERE po.contract_id = $1
     ORDER BY po.created_at DESC`,
    [id]
  );

  const committed = pos.filter((po) => SPEND_STATUSES.includes(po.status));
  const po_spend = committed.reduce((sum, po) => sum + Number(po.po_total), 0);
  return {
    ...contract,
    effective_status: effectiveContractStatus(contract),
    days_to_expiry: daysToExpiry(contract),
    po_spend,
    po_count: committed.length,
    over_budget: contract.annual_value != null && po_spend > Number(contract.annual_value),
    purchase_orders: pos.map((po) => ({ ...po, po_total: Number(po.po_total) })),
  };
}

// GET /api/contracts?status=expiring&supplier_id=<uuid>&limit=50&offset=0
router.get("/", asyncHandler(async (req, res) => {
  const { status, supplier_id } = req.query;
  const { limit, offset } = parsePaging(req.query);
  const params = [req.orgId];
  const conditions = ["c.organization_id = $1"];

  if (status && STATUSES.includes(status)) {
    params.push(status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (supplier_id) {
    params.push(supplier_id);
    conditions.push(`c.supplier_id = $${params.length}`);
  }

  params.push(limit, offset);
  // SPEND_STATUSES is appended last, so its placeholder is params.length + 1.
  const { rows } = await query(
    `SELECT c.*, s.name AS supplier_name, p.name AS property_name,
            COALESCE((SELECT sum(poi.quantity * poi.unit_cost)
                      FROM purchase_orders po
                      JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
                      WHERE po.contract_id = c.id AND po.status = ANY($${params.length + 1}::text[])), 0) AS po_spend,
            (SELECT count(*) FROM purchase_orders po
             WHERE po.contract_id = c.id AND po.status = ANY($${params.length + 1}::text[])) AS po_count,
            count(*) OVER() AS total
     FROM contracts c
     LEFT JOIN suppliers s ON s.id = c.supplier_id
     LEFT JOIN properties p ON p.id = c.property_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    [...params, SPEND_STATUSES]
  );

  const total = rows.length ? Number(rows[0].total) : 0;
  const data = rows.map((r) => ({
    ...r,
    effective_status: effectiveContractStatus(r),
    days_to_expiry: daysToExpiry(r),
    po_spend: Number(r.po_spend),
    po_count: Number(r.po_count),
    over_budget: r.annual_value != null && Number(r.po_spend) > Number(r.annual_value),
  }));
  res.json({ data, meta: { total, limit, offset } });
}));

// POST /api/contracts — create a contract. The org-scoped number
// (CTR-YYYY-NNNN) is assigned automatically; status is derived from the term.
// body: { contract_type, supplier_id?, property_id?, start_date?, end_date?,
//         annual_value?, renewal_notice_days?, notes? }
router.post("/", validate(createSchema), requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const body = req.body;
  assertDates(body.start_date, body.end_date);

  const created = await withTransaction(async (client) => {
    await assertRefs(client, req.orgId, body.supplier_id, body.property_id);
    const { rows: existing } = await client.query(
      `SELECT contract_number FROM contracts WHERE organization_id = $1`,
      [req.orgId]
    );
    const contract_number = nextContractNumber(existing);
    const status = effectiveContractStatus({ ...body, status: "active" });

    const { rows } = await client.query(
      `INSERT INTO contracts (organization_id, contract_number, supplier_id, property_id,
                              contract_type, status, start_date, end_date, annual_value,
                              renewal_notice_days, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.orgId, contract_number, body.supplier_id ?? null, body.property_id ?? null,
       body.contract_type, status, body.start_date ?? null, body.end_date ?? null,
       body.annual_value ?? null, body.renewal_notice_days, body.notes ?? null]
    );
    return rows[0];
  });

  res.status(201).json(await loadContract(created.id, req.orgId));
}));

// GET /api/contracts/:id — contract detail with linked purchase orders.
router.get("/:id", asyncHandler(async (req, res) => {
  res.json(await loadContract(req.params.id, req.orgId));
}));

// PATCH /api/contracts/:id — edit terms (admin/manager). Extending end_date
// pulls a contract back out of the expiry window; termination is separate.
router.patch("/:id", validate(patchSchema), requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const body = req.body;
  assertDates(body.start_date, body.end_date);

  const updated = await withTransaction(async (client) => {
    const { rows: cur } = await client.query(
      `SELECT * FROM contracts WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!cur[0]) throw new ApiError(404, "Contract not found");
    if (cur[0].status === "terminated") throw new ApiError(400, "A terminated contract cannot be edited");
    await assertRefs(client, req.orgId, body.supplier_id, body.property_id);

    const merged = {
      contract_type: body.contract_type ?? cur[0].contract_type,
      supplier_id: body.supplier_id !== undefined ? body.supplier_id : cur[0].supplier_id,
      property_id: body.property_id !== undefined ? body.property_id : cur[0].property_id,
      start_date: body.start_date !== undefined ? body.start_date : cur[0].start_date,
      end_date: body.end_date !== undefined ? body.end_date : cur[0].end_date,
      annual_value: body.annual_value !== undefined ? body.annual_value : cur[0].annual_value,
      renewal_notice_days: body.renewal_notice_days !== undefined ? body.renewal_notice_days : cur[0].renewal_notice_days,
      notes: body.notes !== undefined ? body.notes : cur[0].notes,
    };
    merged.status = effectiveContractStatus({ ...cur[0], ...merged });

    const { rows } = await client.query(
      `UPDATE contracts SET contract_type=$3, supplier_id=$4, property_id=$5, status=$6,
                           start_date=$7, end_date=$8, annual_value=$9, renewal_notice_days=$10,
                           notes=$11, updated_at=now()
       WHERE id=$1 AND organization_id=$2 RETURNING *`,
      [req.params.id, req.orgId, merged.contract_type, merged.supplier_id, merged.property_id,
       merged.status, merged.start_date, merged.end_date, merged.annual_value,
       merged.renewal_notice_days, merged.notes]
    );
    return rows[0];
  });

  res.json(await loadContract(updated.id, req.orgId));
}));

// POST /api/contracts/:id/terminate — close a contract out (admin/manager).
router.post("/:id/terminate", requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE contracts SET status = 'terminated', updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND status <> 'terminated' RETURNING *`,
    [req.params.id, req.orgId]
  );
  if (!rows[0]) throw new ApiError(400, "Contract not found or already terminated");
  await publishEvent(req.orgId, "contract.terminated", {
    contract_id: rows[0].id,
    contract_number: rows[0].contract_number,
    supplier_id: rows[0].supplier_id,
    end_date: rows[0].end_date,
  });
  res.json(await loadContract(rows[0].id, req.orgId));
}));

// POST /api/contracts/check-expiry — run the expiry pass for this org now
// (admin/manager). Same logic as the daily scheduler job, exposed so the UI
// can re-check on demand and tests can drive it deterministically.
router.post("/check-expiry", requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const notified = await checkContractExpiry(req.orgId);
  res.json({ checked: true, notified });
}));

export default router;
