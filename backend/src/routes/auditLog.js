import { Router } from "express";
import { query } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireRole } from "../middleware/auth.js";
import { parsePaging, pagedResponse } from "../pagination.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/audit-log — who changed what, when.
//
// Filters:
//   entity      — table name (e.g. work_orders, assets)
//   actor       — user UUID
//   action      — INSERT | UPDATE | DELETE
//   entity_id   — specific row UUID
//   after / before — date window on created_at
//   ?format=csv — download as CSV
//
// Only admins and managers can view the audit trail.
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: "created_at", label: "timestamp" },
  { key: "actor_name", label: "actor" },
  { key: "action", label: "action" },
  { key: "entity", label: "entity" },
  { key: "entity_id", label: "entity_id" },
  { key: "summary", label: "summary" },
  { key: "ip_address", label: "ip_address" },
];

function esc(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const header = COLUMNS.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => COLUMNS.map((c) => esc(r[c.key])).join(",")).join("\n");
  return `${header}\n${body}`;
}

router.get("/", requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const { entity, actor, action, entity_id, after, before, format } = req.query;
  const conditions = ["a.organization_id = $1"];
  const params = [req.orgId];

  if (entity) { params.push(entity); conditions.push(`a.entity = $${params.length}`); }
  if (actor) { params.push(actor); conditions.push(`a.actor_user_id = $${params.length}::uuid`); }
  if (action) { params.push(action); conditions.push(`a.action = $${params.length}`); }
  if (entity_id) { params.push(entity_id); conditions.push(`a.entity_id = $${params.length}::uuid`); }
  if (after) { params.push(after); conditions.push(`a.created_at >= $${params.length}::timestamptz`); }
  if (before) { params.push(before); conditions.push(`a.created_at <= $${params.length}::timestamptz`); }

  const { limit, offset } = parsePaging(req.query);

  const { rows } = await query(
    `SELECT a.id, a.created_at, a.action, a.entity, a.entity_id,
            a.old_data, a.new_data, a.ip_address,
            u.full_name AS actor_name,
            -- Concise summary: "updated title, status" or "created" etc.
            CASE
              WHEN a.action = 'INSERT' THEN 'Created'
              WHEN a.action = 'DELETE' THEN 'Deleted'
              ELSE 'Updated ' || (
                SELECT string_agg(k, ', ' ORDER BY k)
                FROM jsonb_object_keys(
                  COALESCE(a.new_data, '{}'::jsonb)
                  - 'id' - 'organization_id' - 'created_at' - 'updated_at'
                ) k
                WHERE (a.old_data ? k) AND a.old_data->k IS DISTINCT FROM a.new_data->k
                  AND k NOT LIKE '%_id'
              )
            END AS summary
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY a.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="audit-log.csv"');
    return res.send(toCsv(rows));
  }

  res.json(pagedResponse(rows, { limit, offset }));
}));

// GET /api/audit-log/entities — distinct entity names for the filter dropdown.
router.get("/entities", requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT entity FROM audit_log WHERE organization_id = $1 ORDER BY entity`,
    [req.orgId]
  );
  res.json(rows.map((r) => r.entity));
}));

export default router;
