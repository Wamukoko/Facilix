import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { validate, uuid } from "../middleware/validate.js";
import { recordReading } from "../metering.js";

const router = Router();

// --- Trends & anomaly detection ---

// GET /api/meter-readings/assets/:id/trend — recent readings with deltas and
// per-day rates, rate-spike anomalies, and threshold projections.
router.get("/assets/:id/trend", asyncHandler(async (req, res) => {
  const { rows: assets } = await query(
    `SELECT id, name, type, meter_value, meter_unit FROM assets WHERE id = $1 AND organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (!assets[0]) return res.status(404).json({ error: "Asset not found" });
  const asset = assets[0];

  const { rows } = await query(
    `SELECT id, reading_value, reading_unit, recorded_at, cost
     FROM meter_readings WHERE asset_id = $1
     ORDER BY recorded_at DESC, id DESC LIMIT 25`,
    [req.params.id]
  );

  // Chronological order for deltas/rates.
  const readings = rows.reverse();
  const withRates = readings.map((r, i) => {
    const value = Number(r.reading_value);
    const prev = i > 0 ? Number(readings[i - 1].reading_value) : null;
    const prevAt = i > 0 ? new Date(readings[i - 1].recorded_at).getTime() : null;
    const at = new Date(r.recorded_at).getTime();
    const delta = prev != null ? value - prev : null;
    const days = prevAt != null ? (at - prevAt) / 86400000 : null;
    const rate_per_day = delta != null && days != null && days > 0 ? delta / days : null;
    return { ...r, value, delta, rate_per_day };
  });

  // Spike = rate more than 2.5× the median of the other rates.
  const rates = withRates.map((r) => r.rate_per_day).filter((x) => x != null && x > 0);
  const median = rates.length ? rates.sort((a, b) => a - b)[Math.floor(rates.length / 2)] : null;
  for (const r of withRates) {
    r.anomaly = r.rate_per_day != null && median != null && median > 0 && r.rate_per_day > median * 2.5;
  }

  // Threshold rules for this asset + how far away they are.
  const { rows: plans } = await query(
    `SELECT id, name, meter_threshold FROM maintenance_plans
     WHERE active = true AND trigger = 'meter_based'
       AND (asset_id = $1 OR asset_type = $2) AND meter_threshold IS NOT NULL`,
    [asset.id, asset.type]
  );
  const lastRate = withRates.filter((r) => r.rate_per_day != null && r.rate_per_day > 0).at(-1)?.rate_per_day ?? null;
  const current = asset.meter_value != null ? Number(asset.meter_value) : null;
  const thresholds = plans.map((p) => {
    const t = Number(p.meter_threshold);
    const predicted_days =
      current != null && lastRate != null && lastRate > 0 && current < t ? (t - current) / lastRate : null;
    return {
      plan_id: p.id,
      plan_name: p.name,
      threshold: String(t),
      reached: current != null && current >= t,
      predicted_days: predicted_days != null ? Math.max(0, Math.round(predicted_days)) : null,
    };
  });

  res.json({
    asset,
    readings: withRates.map((r) => ({
      id: r.id,
      reading_value: r.reading_value,
      reading_unit: r.reading_unit,
      recorded_at: r.recorded_at,
      cost: r.cost,
      delta: r.delta,
      rate_per_day: r.rate_per_day != null ? Math.round(r.rate_per_day * 10) / 10 : null,
      anomaly: r.anomaly,
    })),
    thresholds,
  });
}));

// --- Alerts (for the dashboard) ---

// GET /api/meter-readings/alerts — assets at or approaching a threshold.
router.get("/alerts", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id AS asset_id, a.name AS asset_name, a.type AS asset_type,
            a.meter_value, a.meter_unit, mp.id AS plan_id, mp.name AS plan_name,
            mp.meter_threshold
     FROM assets a
     JOIN maintenance_plans mp ON mp.active = true AND mp.trigger = 'meter_based'
       AND (mp.asset_id = a.id OR mp.asset_type = a.type)
     WHERE a.organization_id = $1 AND a.meter_value IS NOT NULL AND a.status <> 'retired'
     ORDER BY a.name`,
    [req.orgId]
  );
  const alerts = [];
  for (const row of rows) {
    const value = Number(row.meter_value);
    const threshold = Number(row.meter_threshold);
    if (threshold <= 0) continue;
    if (value >= threshold) {
      alerts.push({ ...row, status: "breached" });
    } else if (value >= threshold * 0.9) {
      alerts.push({ ...row, status: "near" });
    }
  }
  res.json({ data: alerts });
}));

// --- Ingestion ---

const readingSchema = z.object({
  asset_id: uuid,
  reading_value: z.coerce.number().positive("reading_value must be positive"),
  reading_unit: z.string().trim().max(20).optional(),
  recorded_at: z.coerce.date().optional(),
  cost: z.coerce.number().nonnegative().nullable().optional(),
});

// POST /api/meter-readings — sensor-style bulk ingestion.
// body: { readings: [ { asset_id, reading_value, reading_unit?, recorded_at?, cost? }, ... ] }
router.post("/", validate(z.object({ readings: z.array(readingSchema).min(1).max(500) })), asyncHandler(async (req, res) => {
  const inserted = [];
  const work_orders = [];
  const errors = [];
  for (const r of req.body.readings) {
    try {
      const out = await recordReading({
        orgId: req.orgId,
        assetId: r.asset_id,
        readingValue: r.reading_value,
        readingUnit: r.reading_unit,
        recordedAt: r.recorded_at,
        cost: r.cost,
      });
      inserted.push(out.reading);
      work_orders.push(...out.work_orders);
    } catch (err) {
      errors.push({ asset_id: r.asset_id, error: err.message });
    }
  }
  res.status(201).json({ inserted: inserted.length, work_orders: work_orders.length, errors });
}));

export default router;
