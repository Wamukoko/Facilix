import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

// value = machine slug (what gets stored), label = human display name.
const entrySchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, "value is required")
    .max(40)
    .regex(/^[a-z0-9_]+$/, "value must be lowercase letters, numbers, or underscores"),
  label: z.string().trim().min(1, "label is required").max(80),
});

const toggleSchema = z.object({
  active: z.boolean(),
});

async function getVocabulary(orgId) {
  const [trades, assetTypes, org] = await Promise.all([
    query(
      `SELECT value, label, active FROM trades WHERE organization_id = $1 ORDER BY label`,
      [orgId]
    ),
    query(
      `SELECT value, label, active FROM asset_types WHERE organization_id = $1 ORDER BY label`,
      [orgId]
    ),
    query(`SELECT auto_assign_suppliers FROM organizations WHERE id = $1`, [orgId]),
  ]);
  return {
    trades: trades.rows,
    asset_types: assetTypes.rows,
    // Fixflo-inspired: route urgent breakdowns straight to a trade supplier.
    auto_assign_suppliers: org.rows[0]?.auto_assign_suppliers === true,
  };
}

// GET /api/config — the org's configurable vocabulary (trades + asset types)
// plus org-level routing flags.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await getVocabulary(req.orgId));
  })
);

// PATCH /api/config/auto-assign — toggle automatic supplier routing. Applies to
// work orders created from that point on (existing rows are untouched).
router.patch(
  "/auto-assign",
  validate(z.object({ auto_assign_suppliers: z.boolean() })),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE organizations SET auto_assign_suppliers = $1 WHERE id = $2
       RETURNING auto_assign_suppliers`,
      [req.body.auto_assign_suppliers, req.orgId]
    );
    res.json({ auto_assign_suppliers: rows[0]?.auto_assign_suppliers === true });
  })
);

// POST /api/config/trades | /api/config/asset-types — add a new option.
router.post(
  "/:kind",
  validate(entrySchema),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const kind = req.params.kind;
    if (!["trades", "asset_types"].includes(kind)) throw new ApiError(404, "Route not found");
    const { value, label } = req.body;

    try {
      const { rows } = await query(
        `INSERT INTO ${kind} (organization_id, value, label)
         VALUES ($1, $2, $3)
         RETURNING value, label, active`,
        [req.orgId, value, label]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === "23505") {
        throw new ApiError(409, `"${value}" already exists — use the toggle to activate it`);
      }
      throw err;
    }
  })
);

// PATCH /api/config/:kind/:value — activate/deactivate an existing option.
router.patch(
  "/:kind/:value",
  validate(toggleSchema),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { kind, value } = req.params;
    if (!["trades", "asset_types"].includes(kind)) throw new ApiError(404, "Route not found");

    const { rows } = await query(
      `UPDATE ${kind} SET active = $1
       WHERE organization_id = $2 AND value = $3
       RETURNING value, label, active`,
      [req.body.active, req.orgId, value]
    );
    if (rows.length === 0) throw new ApiError(404, `"${value}" not found`);
    res.json(rows[0]);
  })
);

export default router;
