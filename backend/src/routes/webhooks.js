import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import { flushOrgOutbox, knownEvents } from "../events.js";

// Phase 12 — webhook subscriptions. Admins/managers point an HTTPS endpoint
// at Facilix events; the event bus delivers JSON payloads signed with an
// HMAC-SHA256 shared secret (X-Facilix-Signature header).

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  url: z.string().trim().url("url must be a valid http(s) URL").max(1000),
  secret: z.string().trim().min(16, "secret must be at least 16 characters").max(200).optional(),
  events: z.array(z.string().trim().min(1).max(100)).min(1, "at least one event is required").max(50),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  url: z.string().trim().url("url must be a valid http(s) URL").max(1000).optional(),
  secret: z.string().trim().min(16).max(200).optional(),
  events: z.array(z.string().trim().min(1).max(100)).min(1).max(50).optional(),
  active: z.boolean().optional(),
});

// GET /api/webhooks — the org's subscriptions, with the latest delivery status.
router.get("/", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT w.*,
            (SELECT d.response_status FROM webhook_deliveries d
             WHERE d.webhook_id = w.id ORDER BY d.created_at DESC LIMIT 1) AS last_status,
            (SELECT d.created_at FROM webhook_deliveries d
             WHERE d.webhook_id = w.id ORDER BY d.created_at DESC LIMIT 1) AS last_attempt_at
     FROM webhooks w
     WHERE w.organization_id = $1
     ORDER BY w.created_at DESC`,
    [req.orgId]
  );
  res.json({ data: rows });
}));

router.post(
  "/",
  requireRole("admin", "manager"),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    for (const ev of req.body.events) {
      if (!knownEvents().includes(ev)) throw new ApiError(400, `Unknown event "${ev}"`);
    }
    const secret = req.body.secret ?? crypto.randomBytes(24).toString("hex");
    const { rows } = await query(
      `INSERT INTO webhooks (organization_id, name, url, secret, events)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, url, events, active, created_at`,
      [req.orgId, req.body.name, req.body.url, secret, req.body.events]
    );
    res.status(201).json(rows[0]);
  })
);

// POST /api/webhooks/flush — deliver anything pending now (also used by tests).
router.post(
  "/flush",
  requireRole("admin", "manager"),
  asyncHandler(async (req, res) => {
    const result = await flushOrgOutbox(req.orgId);
    res.json(result);
  })
);

// GET /api/webhooks/deliveries?webhook_id=&limit=50 — delivery attempt log.
router.get("/deliveries", asyncHandler(async (req, res) => {
  const { webhook_id } = req.query;
  const conditions = ["organization_id = $1"];
  const params = [req.orgId];
  if (webhook_id) { params.push(webhook_id); conditions.push(`webhook_id = $${params.length}`); }
  params.push(Math.min(Number(req.query.limit) || 50, 200));
  const { rows } = await query(
    `SELECT * FROM webhook_deliveries WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json({ data: rows });
}));

router.patch(
  "/:id",
  requireRole("admin", "manager"),
  validate(patchSchema),
  asyncHandler(async (req, res) => {
    if (req.body.events) {
      for (const ev of req.body.events) {
        if (!knownEvents().includes(ev)) throw new ApiError(400, `Unknown event "${ev}"`);
      }
    }
    const entries = Object.entries(req.body);
    if (!entries.length) throw new ApiError(400, "No valid fields to update");
    const sets = [];
    const params = [];
    for (const [key, value] of entries) {
      params.push(value);
      sets.push(`${key} = $${params.length}`);
    }
    params.push(req.params.id, req.orgId);
    const { rows } = await query(
      `UPDATE webhooks SET ${sets.join(", ")}
       WHERE id = $${params.length - 1} AND organization_id = $${params.length}
       RETURNING id, name, url, events, active, created_at`,
      params
    );
    if (!rows[0]) throw new ApiError(404, "Webhook not found");
    res.json(rows[0]);
  })
);

router.delete(
  "/:id",
  requireRole("admin", "manager"),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query(
      `DELETE FROM webhooks WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!rowCount) throw new ApiError(404, "Webhook not found");
    res.status(204).end();
  })
);

export default router;
