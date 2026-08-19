// Auto-assignment routing (Fixflo-inspired contractor marketplace).
//
// When an org turns on `auto_assign_suppliers`, reactive repair requests are
// routed straight to a supplier for the order's trade instead of sitting in the
// open queue. The picker is load-balanced: the least-loaded supplier for the
// trade wins, so one contractor can't be drowned while others idle.

import { query } from "../db.js";

export async function orgAutoAssignEnabled(orgId) {
  const { rows } = await query(
    `SELECT auto_assign_suppliers FROM organizations WHERE id = $1`,
    [orgId]
  );
  return rows[0]?.auto_assign_suppliers === true;
}

// Pick the least-loaded supplier for a trade, or null when none exists.
export async function pickAutoAssignSupplier(orgId, trade) {
  const { rows } = await query(
    `SELECT s.id, s.name
     FROM suppliers s
     LEFT JOIN work_orders w
            ON w.assigned_supplier_id = s.id
           AND w.status IN ('open', 'assigned', 'in_progress')
           AND w.archived_at IS NULL
     WHERE s.organization_id = $1 AND s.trade = $2
     GROUP BY s.id, s.name
     ORDER BY count(w.id) ASC, s.name ASC
     LIMIT 1`,
    [orgId, trade]
  );
  return rows[0] ?? null;
}
