import { Router } from "express";
import { query } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";

const router = Router();

// GET /api/reliability
// Tenant-scoped reliability intelligence (Phase 6). Every query is bounded by
// organization_id so one tenant never sees another's data. Built on top of the
// structured closeout data captured in Phase 8 (failure_code, completed_at).
//   - failureCodes: most frequent failure modes + mean repair time (MTTR)
//   - badActors:    assets with repeated work orders / recurring failure modes + MTBF
//   - pmEffectiveness: preventive-maintenance on-time vs overdue ratio
//   - summary:      open/closed counts, overdue risk, fleet-wide mean repair time
router.get("/", asyncHandler(async (req, res) => {
  const org = req.orgId;

  const [fc, ba, pm, sum] = await Promise.all([
    query(
      `SELECT failure_code,
              count(*)::int AS count,
              round(avg(extract(epoch FROM (completed_at - created_at))) / 3600, 1) AS avg_repair_hours
       FROM work_orders
       WHERE organization_id = $1 AND failure_code IS NOT NULL
         AND status IN ('done','verified')
       GROUP BY failure_code
       ORDER BY count DESC
       LIMIT 12`,
      [org]
    ),

    // MTBF uses the gap between consecutive work orders on the same asset.
    query(
      `WITH base AS (
         SELECT a.id AS asset_id,
                a.name AS asset_name,
                wo.created_at,
                wo.failure_code,
                lag(wo.created_at) OVER (PARTITION BY wo.asset_id ORDER BY wo.created_at) AS prev
         FROM work_orders wo
         JOIN assets a ON a.id = wo.asset_id
         WHERE wo.organization_id = $1 AND wo.asset_id IS NOT NULL
       )
       SELECT asset_id,
              asset_name,
              count(*)::int AS wo_count,
              count(DISTINCT failure_code) FILTER (WHERE failure_code IS NOT NULL)::int AS distinct_failure_codes,
              json_agg(failure_code) FILTER (WHERE failure_code IS NOT NULL) AS failure_codes,
              round(avg(extract(epoch FROM (created_at - prev))) / 86400, 1) AS mtbf_days
       FROM base
       GROUP BY asset_id, asset_name
       HAVING count(*) > 1
       ORDER BY wo_count DESC
       LIMIT 10`,
      [org]
    ),

    query(
      `SELECT
         count(*) FILTER (WHERE source = 'plan')::int AS planned_total,
         count(*) FILTER (WHERE source = 'plan' AND status IN ('done','verified'))::int AS planned_done,
         count(*) FILTER (WHERE source = 'plan' AND status IN ('done','verified')
                          AND (due_date IS NULL OR completed_at <= due_date))::int AS planned_on_time,
         count(*) FILTER (WHERE source = 'plan' AND status NOT IN ('done','verified','cancelled')
                          AND due_date < current_date)::int AS planned_overdue
       FROM work_orders
       WHERE organization_id = $1`,
      [org]
    ),

    query(
      `SELECT
         count(*) FILTER (WHERE status IN ('done','verified'))::int AS total_closed,
         count(*) FILTER (WHERE status NOT IN ('done','verified','cancelled'))::int AS total_open,
         count(*) FILTER (WHERE status NOT IN ('done','verified','cancelled')
                          AND due_date < current_date)::int AS overdue_open,
         round(avg(extract(epoch FROM (completed_at - created_at)))
               FILTER (WHERE failure_code IS NOT NULL AND status IN ('done','verified')) / 3600, 1)
           AS avg_repair_hours_all
       FROM work_orders
       WHERE organization_id = $1`,
      [org]
    ),
  ]);

  const pmRow = pm.rows[0];
  const onTimeRate =
    pmRow.planned_done > 0 ? Math.round((pmRow.planned_on_time / pmRow.planned_done) * 100) : null;

  const badActors = ba.rows.map((r) => {
    const codes = (r.failure_codes || []).filter(Boolean);
    const seen = new Set();
    let repeat = 0;
    for (const c of codes) {
      if (seen.has(c)) repeat += 1;
      else seen.add(c);
    }
    return {
      asset_id: r.asset_id,
      asset_name: r.asset_name,
      wo_count: r.wo_count,
      distinct_failure_codes: r.distinct_failure_codes,
      failure_codes: codes,
      repeat_count: repeat,
      mtbf_days: r.mtbf_days,
    };
  });

  res.json({
    failureCodes: fc.rows,
    badActors,
    pmEffectiveness: {
      planned_total: pmRow.planned_total,
      planned_done: pmRow.planned_done,
      planned_on_time: pmRow.planned_on_time,
      planned_overdue: pmRow.planned_overdue,
      on_time_rate: onTimeRate,
    },
    summary: sum.rows[0],
  });
}));

export default router;
