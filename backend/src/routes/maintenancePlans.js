import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate, uuid, assetType, triggerType } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import { assertAssetType } from "../lib/lookups.js";
import { parsePaging, pagedResponse } from "../pagination.js";
import { runPlan, runDueScheduled } from "../scheduler.js";

const router = Router();

const checklistItem = z.object({
  step: z.string().trim().min(1, "checklist steps need text").max(500),
  done: z.boolean().optional(),
});

const planBody = z
  .object({
    name: z.string().trim().min(1, "name is required").max(200).optional(),
    asset_type: assetType.nullable().optional(),
    asset_id: uuid.nullable().optional(),
    trigger: triggerType.optional(),
    frequency_days: z.coerce.number().int().positive().nullable().optional(),
    meter_threshold: z.coerce.number().positive().nullable().optional(),
    checklist: z.array(checklistItem).optional(),
    default_supplier_id: uuid.nullable().optional(),
    active: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.trigger === "scheduled" && !val.frequency_days) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "frequency_days is required for scheduled plans",
        path: ["frequency_days"],
      });
    }
    if (val.trigger === "meter_based" && !val.meter_threshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "meter_threshold is required for meter_based plans",
        path: ["meter_threshold"],
      });
    }
  });

const createSchema = planBody.superRefine((val, ctx) => {
  if (!val.trigger) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "trigger is required",
      path: ["trigger"],
    });
  }
});

const patchSchema = planBody.superRefine((val, ctx) => {
  if (val.trigger && val.trigger === "scheduled" && !val.frequency_days) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "frequency_days is required for scheduled plans",
      path: ["frequency_days"],
    });
  }
  if (val.trigger && val.trigger === "meter_based" && !val.meter_threshold) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "meter_threshold is required for meter_based plans",
      path: ["meter_threshold"],
    });
  }
});

// Columns every list/read adds so the UI can show the live schedule state:
// next_run_at (when the next cycle is due for scheduled plans), due (already
// due?), and open_work_orders (how many generated jobs are in flight).
const PLAN_FIELDS = `
  p.*,
  CASE
    WHEN p.trigger = 'scheduled' AND p.frequency_days IS NOT NULL
      THEN COALESCE(p.last_run_at, p.created_at) + (p.frequency_days || ' days')::interval
    ELSE NULL
  END AS next_run_at,
  CASE
    WHEN p.trigger = 'scheduled' AND p.frequency_days IS NOT NULL
      THEN COALESCE(p.last_run_at, p.created_at) + (p.frequency_days || ' days')::interval <= now()
    ELSE false
  END AS due,
  (SELECT count(*) FROM work_orders w
   WHERE w.maintenance_plan_id = p.id
     AND w.status NOT IN ('done','verified','cancelled'))::int AS open_work_orders
`;

async function loadPlan(orgId, id) {
  const { rows } = await query(
    `SELECT ${PLAN_FIELDS} FROM maintenance_plans p WHERE p.id = $1 AND p.organization_id = $2`,
    [id, orgId]
  );
  return rows[0];
}

// GET /api/maintenance-plans
router.get("/", asyncHandler(async (req, res) => {
  const { limit, offset } = parsePaging(req.query);
  const { rows } = await query(
    `SELECT ${PLAN_FIELDS}, count(*) OVER() AS total FROM maintenance_plans p
     WHERE p.organization_id = $1 ORDER BY p.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.orgId, limit, offset]
  );
  res.json(pagedResponse(rows, { limit, offset }));
}));

// POST /api/maintenance-plans
// body: { name, asset_type?, asset_id?, trigger, frequency_days?, meter_threshold?, checklist?, default_supplier_id? }
router.post("/", requireRole("admin", "manager"), validate(createSchema), asyncHandler(async (req, res) => {
  const { name, asset_type, asset_id, trigger, frequency_days, meter_threshold, checklist, default_supplier_id } = req.body;
  if (asset_type) await assertAssetType(req.orgId, asset_type);

  const { rows } = await query(
    `INSERT INTO maintenance_plans
       (organization_id, name, asset_type, asset_id, trigger, frequency_days, meter_threshold, checklist, default_supplier_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [req.orgId, name, asset_type || null, asset_id || null, trigger,
     frequency_days || null, meter_threshold || null, JSON.stringify(checklist || []), default_supplier_id || null]
  );
  res.status(201).json(rows[0]);
}));

// PATCH /api/maintenance-plans/:id — update the plan, its cadence, or toggle active.
router.patch("/:id", requireRole("admin", "manager"), validate(patchSchema), asyncHandler(async (req, res) => {
  const { name, asset_type, asset_id, trigger, frequency_days, meter_threshold, checklist, default_supplier_id, active } = req.body;
  if (asset_type) await assertAssetType(req.orgId, asset_type);

  const current = await loadPlan(req.orgId, req.params.id);
  if (!current) throw new ApiError(404, "Maintenance plan not found");

  const updates = {
    name: name ?? current.name,
    asset_type: asset_type === null ? null : (asset_type ?? current.asset_type),
    asset_id: asset_id === null ? null : (asset_id ?? current.asset_id),
    trigger: trigger ?? current.trigger,
    frequency_days: frequency_days === null ? null : (frequency_days ?? current.frequency_days),
    meter_threshold: meter_threshold === null ? null : (meter_threshold ?? current.meter_threshold),
    checklist: checklist ?? current.checklist,
    default_supplier_id: default_supplier_id === null ? null : (default_supplier_id ?? current.default_supplier_id),
    active: active ?? current.active,
  };

  const { rows } = await query(
    `UPDATE maintenance_plans SET
       name = $2, asset_type = $3, asset_id = $4, trigger = $5,
       frequency_days = $6, meter_threshold = $7, checklist = $8,
       default_supplier_id = $9, active = $10, updated_at = now()
     WHERE id = $1 AND organization_id = $11
     RETURNING *`,
    [req.params.id, updates.name, updates.asset_type, updates.asset_id, updates.trigger,
     updates.frequency_days, updates.meter_threshold, JSON.stringify(updates.checklist),
     updates.default_supplier_id, updates.active, req.orgId]
  );
  res.json(rows[0]);
}));

// DELETE /api/maintenance-plans/:id — permanent removal; generated work orders
// keep their history (work_orders.maintenance_plan_id is ON DELETE SET NULL).
router.delete("/:id", requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `DELETE FROM maintenance_plans WHERE id = $1 AND organization_id = $2 RETURNING id`,
    [req.params.id, req.orgId]
  );
  if (!rows[0]) throw new ApiError(404, "Maintenance plan not found");
  res.status(204).end();
}));

// POST /api/maintenance-plans/:id/run — run one plan now (the demo/tests use
// this instead of waiting for the 02:00 cron). Returns how many work orders
// were spawned. A paused plan or an in-flight cycle yields 0.
router.post("/:id/run", requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const plan = await loadPlan(req.orgId, req.params.id);
  if (!plan) throw new ApiError(404, "Maintenance plan not found");

  const spawned = await runPlan(plan);
  if (spawned > 0) {
    await query(`UPDATE maintenance_plans SET last_run_at = now() WHERE id = $1`, [plan.id]);
  }
  res.json({ spawned });
}));

// POST /api/maintenance-plans/run — run every due plan for the org now.
router.post("/run", requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const spawned = await runDueScheduled();
  res.json({ generated: spawned });
}));

export default router;
