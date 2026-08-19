// Notification dispatch — Phase 7.
//
// In-app notifications are persisted to the `notifications` table (the source
// of truth for the in-app feed). External channels (email/SMS) currently log
// via stubs so the wiring is visible and testable before real providers exist;
// each `notify*` helper records the in-app row AND fires the matching external
// stub so the pattern is consistent when providers are added.

import { query } from "./db.js";

// Persist an in-app notification row. Best-effort: never throws to the caller.
export async function recordNotification({
  orgId,
  userId,
  channel = "in_app",
  type,
  title,
  body,
  refType = null,
  refId = null,
}) {
  const { rows } = await query(
    `INSERT INTO notifications
       (organization_id, user_id, channel, type, title, body, ref_type, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [orgId, userId, channel, type, title, body, refType, refId]
  );
  return rows[0];
}

// External-channel stubs — log instead of sending until providers are wired.
const channels = {
  async email(to, { subject, body }) {
    console.log(`[notify:email] to=${to} subject=${subject}`);
    return { channel: "email", delivered: true, via: "stub" };
  },
  async sms(to, { body }) {
    console.log(`[notify:sms] to=${to} body=${body}`);
    return { channel: "sms", delivered: true, via: "stub" };
  },
};

export async function notify(target, { channel = "email", title, body, subject }) {
  const send = channels[channel];
  if (!send) throw new Error(`Unknown notification channel: ${channel}`);
  return send(target, { title, body, subject });
}

// --- Event helpers: keep callers terse and the payloads consistent. ---

export async function notifyWorkOrderCreated(workOrder, reporterId) {
  if (!reporterId) return;
  try {
    await recordNotification({
      orgId: workOrder.organization_id,
      userId: reporterId,
      type: "work_order_created",
      title: `Work order opened: ${workOrder.title}`,
      body: `${workOrder.trade} · priority ${workOrder.priority} · ${workOrder.status}`,
      refType: "work_order",
      refId: workOrder.id,
    });
  } catch (err) {
    console.error("[notify] work order created notification failed:", err);
  }
}

export async function notifyWorkOrderAssigned(workOrder, assigneeId) {
  if (!assigneeId) return;
  try {
    await recordNotification({
      orgId: workOrder.organization_id,
      userId: assigneeId,
      type: "work_order_assigned",
      title: `Assigned to you: ${workOrder.title}`,
      body: `${workOrder.trade} · priority ${workOrder.priority}`,
      refType: "work_order",
      refId: workOrder.id,
    });
  } catch (err) {
    console.error("[notify] work order assigned notification failed:", err);
  }
}

// Auto-assigned work orders land on the supplier's own job list — tell every
// user account linked to that supplier so the contractor picks it up.
export async function notifyWorkOrderAutoAssigned(workOrder, supplierId) {
  if (!supplierId) return;
  try {
    const { rows } = await query(
      `SELECT id FROM users
       WHERE organization_id = $1 AND supplier_id = $2 AND active = true AND role = 'supplier'`,
      [workOrder.organization_id, supplierId]
    );
    for (const user of rows) {
      await recordNotification({
        orgId: workOrder.organization_id,
        userId: user.id,
        type: "work_order_assigned",
        title: `Assigned to you: ${workOrder.title}`,
        body: `Auto-assigned · ${workOrder.trade} · priority ${workOrder.priority}`,
        refType: "work_order",
        refId: workOrder.id,
      });
    }
  } catch (err) {
    console.error("[notify] auto-assigned work order notification failed:", err);
  }
}

export async function notifyWorkOrderCompleted(workOrder, reporterId) {
  if (!reporterId) return;
  try {
    await recordNotification({
      orgId: workOrder.organization_id,
      userId: reporterId,
      type: "work_order_completed",
      title: `Completed: ${workOrder.title}`,
      body: `Closed as ${workOrder.status}${workOrder.failure_code ? ` · ${workOrder.failure_code}` : ""}`,
      refType: "work_order",
      refId: workOrder.id,
    });
  } catch (err) {
    console.error("[notify] work order completed notification failed:", err);
  }
}

export async function notifyWorkOrderCancelled(workOrder, reporterId, reason) {
  if (!reporterId) return;
  try {
    await recordNotification({
      orgId: workOrder.organization_id,
      userId: reporterId,
      type: "work_order_cancelled",
      title: `Cancelled: ${workOrder.title}`,
      body: reason ? `Cancelled — ${reason}` : "Cancelled",
      refType: "work_order",
      refId: workOrder.id,
    });
  } catch (err) {
    console.error("[notify] work order cancelled notification failed:", err);
  }
}

// Tenant withdrawals notify the org's active staff so the request doesn't
// silently vanish from the board. Same audit shape as a staff cancellation.
export async function notifyWorkOrderWithdrawn(workOrder, reason) {
  try {
    const { rows } = await query(
      `SELECT id FROM users
       WHERE organization_id = $1 AND active = true AND role IN ('admin', 'manager')`,
      [workOrder.organization_id]
    );
    for (const staff of rows) {
      await recordNotification({
        orgId: workOrder.organization_id,
        userId: staff.id,
        type: "work_order_withdrawn",
        title: `Withdrawn by tenant: ${workOrder.title}`,
        body: reason ? `Tenant cancelled the request — ${reason}` : "Tenant cancelled the request",
        refType: "work_order",
        refId: workOrder.id,
      });
    }
  } catch (err) {
    console.error("[notify] work order withdrawn notification failed:", err);
  }
}

// Supplier contracts entering the renewal window (or expiring) alert every
// active admin/manager so procurement can renew or re-bid before the term ends.
export async function notifyContractExpiry(contract, effectiveStatus) {
  try {
    const { rows } = await query(
      `SELECT id FROM users
       WHERE organization_id = $1 AND active = true AND role IN ('admin', 'manager')`,
      [contract.organization_id]
    );
    const expired = effectiveStatus === "expired";
    const title = expired
      ? `Contract expired: ${contract.contract_number}`
      : `Contract expiring: ${contract.contract_number}`;
    const end = contract.end_date ? String(contract.end_date).slice(0, 10) : "—";
    for (const staff of rows) {
      await recordNotification({
        orgId: contract.organization_id,
        userId: staff.id,
        type: expired ? "contract_expired" : "contract_expiring",
        title,
        body: `${contract.supplier_name ?? "Supplier"} · ${
          expired ? "term ended" : "ending within the renewal window"
        } · ${end}`,
        refType: "contract",
        refId: contract.id,
      });
    }
  } catch (err) {
    console.error("[notify] contract expiry notification failed:", err);
  }
}

// Asset warranty approaching its end date or already past. Alerts every active
// admin/manager so asset replacements or warranty claims can be pursued.
export async function notifyWarrantyExpiry(asset, effectiveStatus) {
  try {
    const { rows } = await query(
      `SELECT id FROM users
       WHERE organization_id = $1 AND active = true AND role IN ('admin', 'manager')`,
      [asset.organization_id]
    );
    const expired = effectiveStatus === "expired";
    const title = expired
      ? `Warranty expired: ${asset.name}`
      : `Warranty expiring: ${asset.name}`;
    const end = asset.warranty_end ? String(asset.warranty_end).slice(0, 10) : "—";
    for (const staff of rows) {
      await recordNotification({
        orgId: asset.organization_id,
        userId: staff.id,
        type: expired ? "asset_warranty_expired" : "asset_warranty_expiring",
        title,
        body: `${asset.name} · warranty ${expired ? "has ended" : "ending soon"} · ${end}`,
        refType: "asset",
        refId: asset.id,
      });
    }
  } catch (err) {
    console.error("[notify] warranty expiry notification failed:", err);
  }
}

// Statutory inspection overdue — alerts every active admin/manager so the
// inspection can be scheduled before regulators or auditors flag it.
export async function notifyInspectionOverdue(inspection) {
  try {
    const { rows } = await query(
      `SELECT id FROM users
       WHERE organization_id = $1 AND active = true AND role IN ('admin', 'manager')`,
      [inspection.organization_id]
    );
    const due = inspection.due_date ? String(inspection.due_date).slice(0, 10) : "—";
    for (const staff of rows) {
      await recordNotification({
        orgId: inspection.organization_id,
        userId: staff.id,
        type: "inspection_overdue",
        title: `Inspection overdue: ${inspection.requirement}`,
        body: `Statutory inspection "${inspection.requirement}" was due ${due} — schedule immediately`,
        refType: "statutory_inspection",
        refId: inspection.id,
      });
    }
  } catch (err) {
    console.error("[notify] inspection overdue notification failed:", err);
  }
}

// Competency / certification expiry — alerts every active admin/manager so
// the staff member's qualification can be renewed before they work unsafely.
export async function notifyCompetencyExpired(competency, userName) {
  try {
    const { rows } = await query(
      `SELECT id FROM users
       WHERE organization_id = $1 AND active = true AND role IN ('admin', 'manager')`,
      [competency.organization_id]
    );
    const expired = competency.expires_at ? String(competency.expires_at).slice(0, 10) : "—";
    for (const staff of rows) {
      await recordNotification({
        orgId: competency.organization_id,
        userId: staff.id,
        type: "competency_expired",
        title: `Competency expired: ${userName} — ${competency.name}`,
        body: `${userName}'s "${competency.name}" (${competency.trade}) expired ${expired} — renewal required`,
        refType: "competency",
        refId: competency.id,
      });
    }
  } catch (err) {
    console.error("[notify] competency expiry notification failed:", err);
  }
}
