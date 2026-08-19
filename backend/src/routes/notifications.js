import { Router } from "express";
import { query } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { parsePaging } from "../pagination.js";

const router = Router();

// GET /api/notifications — the current user's in-app feed (org-scoped).
// meta includes an `unread` count so the UI can show a badge without a
// second round-trip.
router.get("/", asyncHandler(async (req, res) => {
  const { limit, offset } = parsePaging(req.query);
  const params = [req.orgId, req.userId, limit, offset];
  const { rows } = await query(
    `SELECT *, count(*) OVER() AS total,
            (SELECT count(*) FROM notifications n2
             WHERE n2.organization_id = $1 AND n2.user_id = $2 AND n2.read = false) AS unread
     FROM notifications
     WHERE organization_id = $1 AND user_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    params
  );
  const total = rows.length ? Number(rows[0].total) : 0;
  const unread = rows.length ? Number(rows[0].unread) : 0;
  const data = rows.map(({ total: _t, unread: _u, ...row }) => row);
  res.json({ data, meta: { total, limit, offset, unread } });
}));

// GET /api/notifications/unread-count — lightweight badge counter.
router.get("/unread-count", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT count(*)::int AS unread FROM notifications
     WHERE organization_id = $1 AND user_id = $2 AND read = false`,
    [req.orgId, req.userId]
  );
  res.json({ unread: rows[0].unread });
}));

// PATCH /api/notifications/:id/read — mark a notification read. Scoped to the
// owner so one user can't mutate another's feed.
router.patch("/:id/read", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE notifications SET read = true
     WHERE id = $1 AND organization_id = $2 AND user_id = $3
     RETURNING *`,
    [req.params.id, req.orgId, req.userId]
  );
  if (!rows[0]) throw new ApiError(404, "Notification not found");
  res.json(rows[0]);
}));

export default router;
