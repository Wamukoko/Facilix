import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate, uuid, assetType, assetStatus } from "../middleware/validate.js";
import { assertAssetType } from "../lib/lookups.js";
import { parsePaging, pagedResponse } from "../pagination.js";
import { recordReading } from "../metering.js";

const router = Router();

const dateField = z.coerce.date();
const attributesField = z.record(z.string(), z.unknown());

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
  type: assetType,
  room_id: uuid.nullable().optional(),
  building_id: uuid.nullable().optional(),
  property_id: uuid.nullable().optional(),
  attributes: attributesField.optional(),
  install_date: dateField.nullable().optional(),
  warranty_end: dateField.nullable().optional(),
  meter_value: z.coerce.number().nonnegative().nullable().optional(),
  meter_unit: z.string().trim().max(20).nullable().optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1, "name cannot be empty").max(200).optional(),
  status: assetStatus.optional(),
  attributes: attributesField.optional(),
  meter_value: z.coerce.number().nonnegative().nullable().optional(),
  meter_unit: z.string().trim().max(20).nullable().optional(),
  warranty_end: dateField.nullable().optional(),
});

// GET /api/assets?type=plumbing&room_id=...&limit=50&offset=0
router.get("/", asyncHandler(async (req, res) => {
  const { type, room_id, property_id, status } = req.query;
  const { limit, offset } = parsePaging(req.query);
  const conditions = ["organization_id = $1"];
  const params = [req.orgId];

  if (type) { params.push(type); conditions.push(`type = $${params.length}`); }
  if (room_id) { params.push(room_id); conditions.push(`room_id = $${params.length}`); }
  if (property_id) { params.push(property_id); conditions.push(`property_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  // Search assets by name (partial match)
  if (req.query.name) {
    params.push(`%${req.query.name}%`);
    conditions.push(`name ILIKE $${params.length}`);
  }

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT *, count(*) OVER() AS total FROM assets WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json(pagedResponse(rows, { limit, offset }));
}));

// GET /api/assets/:id
router.get("/:id", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM assets WHERE id = $1 AND organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (!rows[0]) throw new ApiError(404, "Asset not found");
  res.json(rows[0]);
}));

// POST /api/assets
// body: { name, type, room_id?, building_id?, property_id?, attributes?, install_date?, warranty_end?, meter_value?, meter_unit? }
router.post("/", validate(createSchema), asyncHandler(async (req, res) => {
  const { name, type, room_id, building_id, property_id, attributes, install_date, warranty_end, meter_value, meter_unit } = req.body;
  await assertAssetType(req.orgId, type);

  const { rows } = await query(
    `INSERT INTO assets
       (organization_id, name, type, room_id, building_id, property_id, attributes, install_date, warranty_end, meter_value, meter_unit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [req.orgId, name, type, room_id || null, building_id || null, property_id || null,
     attributes || {}, install_date || null, warranty_end || null, meter_value || null, meter_unit || null]
  );
  res.status(201).json(rows[0]);
}));

// PATCH /api/assets/:id
router.patch("/:id", validate(patchSchema), asyncHandler(async (req, res) => {
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
    `UPDATE assets SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $${params.length - 1} AND organization_id = $${params.length}
     RETURNING *`,
    params
  );
  if (!rows[0]) throw new ApiError(404, "Asset not found");
  res.json(rows[0]);
}));

// DELETE /api/assets/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM assets WHERE id = $1 AND organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (!rowCount) throw new ApiError(404, "Asset not found");
  res.status(204).send();
}));

// POST /api/assets/:id/readings — record a single meter reading (Phase 14).
const readingBody = z.object({
  reading_value: z.coerce.number().positive("reading_value must be positive"),
  reading_unit: z.string().trim().max(20).optional(),
  recorded_at: z.coerce.date().optional(),
  cost: z.coerce.number().nonnegative().nullable().optional(),
});
router.post("/:id/readings", validate(readingBody), asyncHandler(async (req, res) => {
  const { reading, work_orders } = await recordReading({
    orgId: req.orgId,
    assetId: req.params.id,
    readingValue: req.body.reading_value,
    readingUnit: req.body.reading_unit,
    recordedAt: req.body.recorded_at,
    cost: req.body.cost,
  });
  res.status(201).json({ reading, work_orders });
}));

export default router;
