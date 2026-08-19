import cron from "node-cron";
import { query } from "./db.js";
import { notifyWorkOrderCreated, notifyContractExpiry, notifyWarrantyExpiry, notifyInspectionOverdue, notifyCompetencyExpired } from "./notifications.js";
import { spawnMeterWorkOrder } from "./metering.js";
import { publishEvent } from "./events.js";
import { effectiveContractStatus } from "./lib/contracts.js";

// Phase 2 — the engine behind Facilix's "Maintenance Manual": it reads active
// plans and spawns work orders when they're due. The daily cron is the
// background pass; the /api/maintenance-plans/:id/run endpoint lets staff
// trigger a single plan on demand, and POST /api/maintenance-plans/run runs
// every due plan for the org (used by the demo and by tests).

const OPEN_STATUSES = ["open", "assigned", "in_progress"];

// Spawns work for one scheduled plan. Returns how many work orders were
// created. A plan is skipped when it is paused, and per asset we never pile
// up: if a generated order for this plan+asset is still open/assigned/in
// progress, that asset's cycle is considered in flight and skipped. That keeps
// a monthly plan from re-spawning the same job every day it stays overdue.
export async function runPlan(plan) {
  if (!plan.active) return 0;

  const { rows: assets } = plan.asset_id
    ? await query(
        `SELECT * FROM assets WHERE id = $1 AND organization_id = $2`,
        [plan.asset_id, plan.organization_id]
      )
    : await query(
        `SELECT * FROM assets WHERE organization_id = $1 AND type = $2`,
        [plan.organization_id, plan.asset_type]
      );

  let spawned = 0;
  for (const asset of assets) {
    const { rows: existing } = await query(
      `SELECT 1 FROM work_orders
       WHERE organization_id = $1 AND maintenance_plan_id = $2 AND asset_id = $3
         AND status = ANY($4) LIMIT 1`,
      [plan.organization_id, plan.id, asset.id, OPEN_STATUSES]
    );
    if (existing.length) continue;

    const { rows } = await query(
      `INSERT INTO work_orders
         (organization_id, asset_id, maintenance_plan_id, source, trade, title,
          description, assigned_supplier_id, priority, due_date)
       VALUES ($1,$2,$3,'plan',$4,$5,$6,$7,'normal', CURRENT_DATE + interval '7 days')
       RETURNING *`,
      [plan.organization_id, asset.id, plan.id, plan.asset_type || "general",
       `${plan.name} — ${asset.name}`, JSON.stringify(plan.checklist), plan.default_supplier_id]
    );
    await notifyWorkOrderCreated(rows[0]);
    // Phase 12: event bus — integrations can react to plan-generated work.
    await publishEvent(plan.organization_id, "work_order.created", {
      work_order_id: rows[0].id,
      title: rows[0].title,
      trade: rows[0].trade,
      priority: rows[0].priority,
      status: rows[0].status,
      source: rows[0].source,
    });
    spawned += 1;
  }
  return spawned;
}

// Generates work for every active scheduled plan that is due: never run, or
// its last run (last_run_at + frequency_days) has passed. `last_run_at` only
// advances when the plan actually produced work, so an overdue-but-in-flight
// plan stays "due" until its outstanding cycle clears.
export async function runDueScheduled() {
  const { rows: duePlans } = await query(`
    SELECT * FROM maintenance_plans
    WHERE active = true
      AND trigger = 'scheduled'
      AND (
        last_run_at IS NULL
        OR last_run_at + (frequency_days || ' days')::interval <= now()
      )
  `);

  let spawned = 0;
  for (const plan of duePlans) {
    const n = await runPlan(plan);
    if (n > 0) {
      await query(`UPDATE maintenance_plans SET last_run_at = now() WHERE id = $1`, [plan.id]);
      spawned += n;
    }
  }
  return spawned;
}

export async function runMeterBased() {
  console.log("[scheduler] Checking meter-based maintenance plans...");

  const { rows: plans } = await query(
    `SELECT * FROM maintenance_plans
     WHERE active = true AND trigger = 'meter_based'`
  );

  let spawned = 0;
  for (const plan of plans) {
    // Assets tied either directly to the plan, or by matching asset_type
    const { rows: assets } = await query(
      `SELECT * FROM assets
       WHERE organization_id = $1
         AND (id = $2 OR type = $3)
         AND meter_value IS NOT NULL
         AND meter_value >= $4`,
      [plan.organization_id, plan.asset_id, plan.asset_type, plan.meter_threshold]
    );

    for (const asset of assets) {
      // Phase 14: evidence-backed recommendations via the shared engine.
      const wo = await spawnMeterWorkOrder(
        plan,
        asset,
        asset.meter_value,
        asset.meter_unit,
        new Date()
      );
      if (wo) spawned += 1;
    }
  }

  if (spawned) console.log(`[scheduler] Generated ${spawned} meter-based work order(s).`);
  return spawned;
}

export function startScheduler() {
  // Every day at 02:00
  cron.schedule("0 2 * * *", async () => {
    try {
      await runDueScheduled();
      await runMeterBased();
      await checkContractExpiry();
      await checkWarrantyExpiry();
      await checkCompliance();
    } catch (err) {
      console.error("[scheduler] Error generating work orders:", err);
    }
  });

  console.log("[scheduler] Maintenance scheduler started (daily @ 02:00).");
}

// Supplier-contract expiry pass. Persists the derived status (active/expiring/
// expired) so reads can filter on it, and raises a notification + event only
// on a transition INTO the renewal window or past the end date — extending a
// contract resets it silently. Runs for one org when orgId is given (the
// on-demand /api/contracts/check-expiry endpoint), or every org from the cron.
// Returns how many contracts were newly flagged.
export async function checkContractExpiry(orgId = null) {
  const { rows: contracts } = orgId
    ? await query(
        `SELECT c.*, s.name AS supplier_name
         FROM contracts c
         LEFT JOIN suppliers s ON s.id = c.supplier_id
         WHERE c.organization_id = $1`,
        [orgId]
      )
    : await query(
        `SELECT c.*, s.name AS supplier_name
         FROM contracts c
         LEFT JOIN suppliers s ON s.id = c.supplier_id`
      );

  let notified = 0;
  for (const contract of contracts) {
    if (contract.status === "terminated") continue;
    const effective = effectiveContractStatus(contract);
    if (effective === contract.status) continue;

    await query(
      `UPDATE contracts SET status = $2, updated_at = now() WHERE id = $1`,
      [contract.id, effective]
    );

    if (effective === "expiring" || effective === "expired") {
      await notifyContractExpiry(contract, effective);
      await publishEvent(contract.organization_id, `contract.${effective}`, {
        contract_id: contract.id,
        contract_number: contract.contract_number,
        supplier_id: contract.supplier_id,
        end_date: contract.end_date,
      });
      notified += 1;
    }
  }
  return notified;
}

// ---------------------------------------------------------------------------
// Warranty expiry — assets with warranty ending within 30 days or already
// past. Notifies once per transition (deduped against existing notifications).
// ---------------------------------------------------------------------------
export async function checkWarrantyExpiry() {
  const { rows: assets } = await query(
    `SELECT * FROM assets
     WHERE warranty_end IS NOT NULL
       AND warranty_end <= now() + interval '30 days'`
  );

  let notified = 0;
  for (const asset of assets) {
    const warrantyEnd = new Date(asset.warranty_end);
    const status = warrantyEnd <= new Date() ? "expired" : "expiring";
    const notifType = `asset_warranty_${status}`;

    const { rows: existing } = await query(
      `SELECT 1 FROM notifications
       WHERE organization_id = $1 AND ref_type = 'asset' AND ref_id = $2 AND type = $3
       LIMIT 1`,
      [asset.organization_id, asset.id, notifType]
    );
    if (existing.length) continue;

    await notifyWarrantyExpiry(asset, status);
    await publishEvent(asset.organization_id, `asset.warranty_${status}`, {
      asset_id: asset.id, name: asset.name, warranty_end: asset.warranty_end,
    });
    notified += 1;
  }
  return notified;
}

// ---------------------------------------------------------------------------
// Compliance — statutory inspections past their due date and staff competencies
// that have expired. Each is notified once (deduped against existing rows).
// ---------------------------------------------------------------------------
export async function checkCompliance() {
  // Statutory inspections — overdue when due_date has passed and the inspection
  // hasn't been marked done since it became due.
  const { rows: inspections } = await query(
    `SELECT si.*, a.name AS asset_name
     FROM statutory_inspections si
     LEFT JOIN assets a ON a.id = si.asset_id
     WHERE si.due_date <= now()
       AND (si.last_done_at IS NULL OR si.last_done_at < si.due_date)`
  );

  let inspectionNotified = 0;
  for (const insp of inspections) {
    const { rows: existing } = await query(
      `SELECT 1 FROM notifications
       WHERE organization_id = $1 AND ref_type = 'statutory_inspection' AND ref_id = $2 AND type = 'inspection_overdue'
       LIMIT 1`,
      [insp.organization_id, insp.id]
    );
    if (existing.length) continue;

    await notifyInspectionOverdue(insp);
    await publishEvent(insp.organization_id, "compliance.inspection_overdue", {
      inspection_id: insp.id, requirement: insp.requirement, due_date: insp.due_date,
    });
    inspectionNotified += 1;
  }

  // Competencies — expired when expires_at has passed.
  const { rows: competencies } = await query(
    `SELECT c.*, u.full_name AS user_name
     FROM competencies c
     JOIN users u ON u.id = c.user_id
     WHERE c.expires_at <= now()`
  );

  let competencyNotified = 0;
  for (const comp of competencies) {
    const { rows: existing } = await query(
      `SELECT 1 FROM notifications
       WHERE organization_id = $1 AND ref_type = 'competency' AND ref_id = $2 AND type = 'competency_expired'
       LIMIT 1`,
      [comp.organization_id, comp.id]
    );
    if (existing.length) continue;

    await notifyCompetencyExpired(comp, comp.user_name);
    await publishEvent(comp.organization_id, "compliance.competency_expired", {
      competency_id: comp.id, user_id: comp.user_id, user_name: comp.user_name,
      name: comp.name, trade: comp.trade,
    });
    competencyNotified += 1;
  }

  return { inspectionNotified, competencyNotified };
}
