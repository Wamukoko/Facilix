import { query } from "./db.js";
import { ApiError } from "./middleware/errors.js";
import { notifyWorkOrderCreated } from "./notifications.js";
import { publishEvent } from "./events.js";

// Phase 14 — condition-based maintenance engine. Shared by the ingestion
// endpoints and the scheduler so meter-driven work orders always carry the
// same evidence payload and never duplicate an already-open recommendation.

const OPEN_STATUSES = ["open", "assigned", "in_progress"];

function meterError(status, message) {
  return new ApiError(status, message);
}

// Creates a recommended work order for a plan whose meter threshold has been
// crossed. The description carries the evidence payload (reading, threshold,
// plan) so the recommendation is auditable end-to-end.
export async function spawnMeterWorkOrder(plan, asset, readingValue, readingUnit, recordedAt) {
  const { rows: existing } = await query(
    `SELECT 1 FROM work_orders
     WHERE maintenance_plan_id = $1 AND asset_id = $2
       AND status = ANY($3) LIMIT 1`,
    [plan.id, asset.id, OPEN_STATUSES]
  );
  if (existing[0]) return null;

  const evidence = JSON.stringify({
    type: "meter_threshold",
    plan_id: plan.id,
    plan_name: plan.name,
    threshold: String(plan.meter_threshold),
    reading_value: String(readingValue),
    reading_unit: readingUnit || "",
    recorded_at: recordedAt ? new Date(recordedAt).toISOString() : null,
  });

  const { rows } = await query(
    `INSERT INTO work_orders
       (organization_id, asset_id, maintenance_plan_id, source, trade, title, description, priority, due_date)
     VALUES ($1,$2,$3,'plan',$4,$5,$6,'normal', CURRENT_DATE + interval '7 days')
     RETURNING *`,
    [asset.organization_id, asset.id, plan.id, plan.asset_type || "general",
     `${plan.name} — meter threshold reached (${readingValue} ${readingUnit || ""})`,
     evidence]
  );
  await notifyWorkOrderCreated(rows[0]);
  await query(`UPDATE maintenance_plans SET last_run_at = now() WHERE id = $1`, [plan.id]);
  // Phase 12: event bus — BMS/integrations can see threshold crossings.
  await publishEvent(asset.organization_id, "asset.threshold_crossed", {
    asset_id: asset.id,
    asset_name: asset.name,
    plan_id: plan.id,
    reading_value: String(readingValue),
    reading_unit: readingUnit || "",
    work_order_id: rows[0].id,
  });
  return rows[0];
}

// Checks every active meter-based plan applying to this asset and spawns work
// orders for any whose threshold is now crossed. Returns the created orders.
export async function checkMeterThresholds(asset, readingValue, readingUnit, recordedAt) {
  const { rows: plans } = await query(
    `SELECT * FROM maintenance_plans
     WHERE active = true AND trigger = 'meter_based'
       AND (asset_id = $1 OR asset_type = $2)`,
    [asset.id, asset.type]
  );
  const spawned = [];
  for (const plan of plans) {
    if (plan.meter_threshold != null && Number(readingValue) >= Number(plan.meter_threshold)) {
      const wo = await spawnMeterWorkOrder(plan, asset, readingValue, readingUnit, recordedAt);
      if (wo) spawned.push(wo);
    }
  }
  return spawned;
}

// Single reading ingestion: validates the asset, enforces a monotonic meter,
// records the reading, refreshes the asset's live meter value, then evaluates
// threshold rules. Returns { reading, work_orders }.
export async function recordReading({ orgId, assetId, readingValue, readingUnit, recordedAt, cost }) {
  const { rows: assets } = await query(`SELECT * FROM assets WHERE id = $1 AND organization_id = $2`, [assetId, orgId]);
  if (!assets[0]) throw meterError(404, "Asset not found");
  const asset = assets[0];

  const unit = readingUnit || asset.meter_unit || "";
  if (!unit) throw meterError(400, "A meter unit is required (or set one on the asset)");

  const { rows: last } = await query(
    `SELECT reading_value FROM meter_readings WHERE asset_id = $1 ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [assetId]
  );
  if (last[0] && Number(readingValue) < Number(last[0].reading_value)) {
    throw meterError(
      400,
      `Reading ${readingValue} is below the previous value (${last[0].reading_value}); meter readings must be monotonic`
    );
  }

  const { rows: inserted } = await query(
    `INSERT INTO meter_readings (asset_id, reading_value, reading_unit, recorded_at, cost)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [assetId, readingValue, unit, recordedAt ? new Date(recordedAt) : new Date(), cost ?? null]
  );
  const reading = inserted[0];

  await query(`UPDATE assets SET meter_value = $1, meter_unit = $2, updated_at = now() WHERE id = $3`, [
    readingValue, unit, assetId,
  ]);
  asset.meter_value = String(readingValue);
  asset.meter_unit = unit;

  const work_orders = await checkMeterThresholds(asset, readingValue, unit, reading.recorded_at);
  return { reading, work_orders };
}
