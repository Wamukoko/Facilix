import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate, userRole } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import { assertTrade } from "../lib/lookups.js";

const router = Router();

// POST /api/users — admin/manager adds a staff member (admin, manager, or
// technician) who can then log in with the given email + temporary password.
const createSchema = z.object({
  full_name: z.string().trim().min(1, "full_name is required").max(120),
  email: z.string().trim().toLowerCase().email("a valid email is required").max(200),
  password: z.string().min(8, "password must be at least 8 characters").max(200),
  role: userRole,
  trade: z.string().trim().max(40).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
});

// GET /api/users — roster for pickers (competency assignment etc.) and the
// Team screen. Excludes supplier logins, which are scoped to the contractor
// portal. Returns active + inactive accounts (inactive flagged) so an admin
// can restore; tenants appear here so staff can issue them portal logins.
router.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, full_name, email, role, trade, supplier_id, active
     FROM users
     WHERE organization_id = $1 AND role != 'supplier'
     ORDER BY active DESC, full_name`,
    [req.orgId]
  );
  res.json({ data: rows });
}));

const prefsSchema = z.object({
  // Ordered dashboard panel ids; unknown ids are ignored on the client so a
  // stale pref (panel removed in a later build) never breaks the layout.
  dashboard: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
});

// GET /api/users/me/prefs — the caller's saved dashboard layout.
router.get("/me/prefs", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT dashboard_prefs FROM users WHERE id = $1`,
    [req.userId]
  );
  const prefs = rows[0]?.dashboard_prefs ?? {};
  res.json({ dashboard: Array.isArray(prefs.dashboard) ? prefs.dashboard : [] });
}));

// PUT /api/users/me/prefs — persist the caller's dashboard layout.
router.put("/me/prefs", validate(prefsSchema), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE users SET dashboard_prefs = $1 WHERE id = $2
     RETURNING dashboard_prefs`,
    [JSON.stringify({ dashboard: req.body.dashboard ?? [] }), req.userId]
  );
  res.json({ dashboard: rows[0]?.dashboard_prefs?.dashboard ?? [] });
}));

router.post(
  "/",
  validate(createSchema),
  requireRole("admin", "manager"),
  asyncHandler(async (req, res) => {
    // Only an admin can create another admin; managers can add staff/techs.
    if (req.body.role === "admin" && req.role !== "admin") {
      throw new ApiError(403, "Only an admin can create admins");
    }
    if (req.body.trade) await assertTrade(req.orgId, req.body.trade);

    const { full_name, email, password, role, trade, phone } = req.body;
    const password_hash = await bcrypt.hash(password, 10);
    try {
      const { rows } = await query(
        `INSERT INTO users (organization_id, email, password_hash, full_name, role, trade, phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, full_name, email, role, trade, active`,
        [req.orgId, email, password_hash, full_name, role, trade || null, phone || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === "23505") {
        throw new ApiError(409, "A user with that email already exists");
      }
      throw err;
    }
  })
);

const deactivateSchema = z.object({
  active: z.boolean(),
});

// PATCH /api/users/:id — deactivate/restore a staff account. Deactivated users
// can no longer log in but their historical records (work orders, competencies,
// notifications) are preserved — FKs point at them, so accounts are never
// hard-deleted.
router.patch(
  "/:id",
  validate(deactivateSchema),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { rows: targets } = await query(
      `SELECT id, role, active FROM users
       WHERE id = $1 AND organization_id = $2 AND role != 'supplier'`,
      [req.params.id, req.orgId]
    );
    const target = targets[0];
    if (!target) throw new ApiError(404, "Staff member not found");

    if (!req.body.active && target.id === req.userId) {
      throw new ApiError(400, "You cannot deactivate your own account");
    }

    // Don't let an org end up with zero active admins.
    if (!req.body.active && target.role === "admin") {
      const { rows: admins } = await query(
        `SELECT count(*) AS n FROM users
         WHERE organization_id = $1 AND role = 'admin' AND active = true`,
        [req.orgId]
      );
      if (Number(admins[0].n) <= 1) {
        throw new ApiError(400, "Cannot deactivate the last active admin");
      }
    }

    const { rows } = await query(
      `UPDATE users SET active = $1
       WHERE id = $2 AND organization_id = $3
       RETURNING id, full_name, email, role, trade, active`,
      [req.body.active, req.params.id, req.orgId]
    );
    res.json(rows[0]);
  })
);

// DELETE /api/users/:id — permanently remove a staff account (admin only).
// Links in history are preserved where possible: work-order assignments and
// reporters, document uploaders, and permit/competency issuers are NULLed, so
// those records survive without the person. The member's own notifications and
// competency certificates are deleted with them.
router.delete(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { rows: targets } = await query(
      `SELECT id, role, active FROM users
       WHERE id = $1 AND organization_id = $2 AND role != 'supplier'`,
      [req.params.id, req.orgId]
    );
    const target = targets[0];
    if (!target) throw new ApiError(404, "Staff member not found");

    if (target.id === req.userId) {
      throw new ApiError(400, "You cannot delete your own account");
    }

    // Don't let an org end up with zero active admins.
    if (target.role === "admin") {
      const { rows: admins } = await query(
        `SELECT count(*) AS n FROM users
         WHERE organization_id = $1 AND role = 'admin' AND active = true`,
        [req.orgId]
      );
      if (Number(admins[0].n) <= 1) {
        throw new ApiError(400, "Cannot delete the last active admin");
      }
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE work_orders SET assigned_user_id = NULL WHERE assigned_user_id = $1`,
        [target.id]
      );
      await client.query(
        `UPDATE work_orders SET reported_by_user_id = NULL WHERE reported_by_user_id = $1`,
        [target.id]
      );
      await client.query(
        `UPDATE work_orders SET cancelled_by_user_id = NULL WHERE cancelled_by_user_id = $1`,
        [target.id]
      );
      await client.query(`UPDATE documents SET uploaded_by = NULL WHERE uploaded_by = $1`, [target.id]);
      await client.query(`UPDATE permits SET issued_by = NULL WHERE issued_by = $1`, [target.id]);
      await client.query(`UPDATE competencies SET issued_by = NULL WHERE issued_by = $1`, [target.id]);
      // notifications.user_id and competencies.user_id cascade.
      await client.query(`DELETE FROM users WHERE id = $1`, [target.id]);
    });

    res.status(204).end();
  })
);

export default router;
