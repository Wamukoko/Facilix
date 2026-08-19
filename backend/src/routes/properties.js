import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { parsePaging, pagedResponse } from "../pagination.js";
import { getCapabilities } from "../capabilities.js";
import { geocodeQuery } from "../geocode.js";

const router = Router();

const bodySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
  address: z.string().trim().max(300).optional(),
  lat: z.coerce.number().min(-90, "latitude must be between -90 and 90").max(90).optional(),
  lng: z.coerce.number().min(-180, "longitude must be between -180 and 180").max(180).optional(),
});

const patchSchema = bodySchema.partial().refine((b) => Object.keys(b).length > 0, "nothing to update");

// Without PostGIS the coordinate columns are plain NUMERIC lat/lng; with
// PostGIS we also keep the GEOGRAPHY geom point in sync so spatial queries
// keep working.
function coordParams(b, lat, lng) {
  if (b.postgis && lat != null && lng != null) {
    return { $: ", geom", val: ", ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography", args: [lat, lng] };
  }
  return { $: ", latitude, longitude", val: ", $4, $5", args: [lat, lng] };
}

// GET /api/properties/geocode?q=Kilimani Rd, Nairobi
// Address → coordinates via Nominatim (OSM). Returns up to 5 candidates so
// the UI can offer a picker; callers fall back to manual coordinates when the
// geocoder is unreachable.
router.get("/geocode", asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) throw new ApiError(400, "q is required");
  let results;
  try {
    results = await geocodeQuery(q);
  } catch {
    throw new ApiError(502, "Geocoding service unavailable — enter coordinates manually instead");
  }
  res.json(results);
}));

// GET /api/properties
router.get("/", asyncHandler(async (req, res) => {
  const { limit, offset } = parsePaging(req.query);
  const { postgis } = await getCapabilities();
  const { rows } = await query(
    `SELECT p.id, p.name, p.address, p.latitude, p.longitude,
            ${postgis ? "ST_AsGeoJSON(p.geom) AS geom," : "NULL::text AS geom,"}
            (SELECT count(*)::int FROM buildings b WHERE b.property_id = p.id) AS buildings_count,
            (SELECT count(*)::int FROM work_orders w
              JOIN assets a ON a.id = w.asset_id
              WHERE w.status NOT IN ('done','verified','cancelled')
                AND (a.property_id = p.id
                     OR EXISTS (SELECT 1 FROM buildings bb WHERE bb.id = a.building_id AND bb.property_id = p.id)
                     OR EXISTS (SELECT 1 FROM rooms rr
                                  JOIN floors ff ON ff.id = rr.floor_id
                                  JOIN buildings bb ON bb.id = ff.building_id
                                WHERE rr.id = a.room_id AND bb.property_id = p.id)))
              AS open_work_orders,
            p.created_at, count(*) OVER() AS total
     FROM properties p WHERE p.organization_id = $1 ORDER BY p.name
     LIMIT $2 OFFSET $3`,
    [req.orgId, limit, offset]
  );
  res.json(pagedResponse(rows, { limit, offset }));
}));

// POST /api/properties
// body: { name, address?, lat?, lng? }
router.post("/", validate(bodySchema), asyncHandler(async (req, res) => {
  const { name, address, lat, lng } = req.body;
  const cap = await getCapabilities();
  const c = coordParams(cap, lat ?? null, lng ?? null);
  const { rows } = await query(
    `INSERT INTO properties (organization_id, name, address${c.$})
     VALUES ($1,$2,$3${c.val}) RETURNING id, name, address, latitude, longitude, created_at`,
    [req.orgId, name, address || null, ...c.args]
  );
  res.status(201).json(rows[0]);
}));

// PATCH /api/properties/:id  (admin/manager)
router.patch("/:id", requireRole("admin", "manager"), validate(patchSchema), asyncHandler(async (req, res) => {
  const { name, address, lat, lng } = req.body;
  const cap = await getCapabilities();

  const sets = [];
  const vals = [];
  if (name !== undefined) { vals.push(name); sets.push(`name = $${vals.length}`); }
  if (address !== undefined) { vals.push(address); sets.push(`address = $${vals.length}`); }
  if (lat !== undefined) { vals.push(lat); sets.push(`latitude = $${vals.length}`); }
  if (lng !== undefined) { vals.push(lng); sets.push(`longitude = $${vals.length}`); }

  // Keep the PostGIS geom point in sync whenever coordinates change.
  if (cap.postgis && (lat !== undefined || lng !== undefined)) {
    vals.push(lat ?? null, lng ?? null);
    const li = vals.length - 1;
    sets.push(`geom = CASE WHEN $${li} IS NOT NULL AND $${li + 1} IS NOT NULL
                          THEN ST_SetSRID(ST_MakePoint($${li + 1}, $${li}), 4326)::geography END`);
  }

  vals.push(req.params.id, req.orgId);
  const { rows } = await query(
    `UPDATE properties SET ${sets.join(", ")}
     WHERE id = $${vals.length - 1} AND organization_id = $${vals.length}
     RETURNING id, name, address, latitude, longitude, created_at`,
    vals
  );
  if (rows.length === 0) return res.status(404).json({ error: "Property not found" });
  res.json(rows[0]);
}));

// DELETE /api/properties/:id  (admin/manager)
// Buildings/floors/rooms cascade; assets keep their rows with the property
// reference nulled. A property with open work orders is protected — resolve
// the jobs first, mirroring the app's no-destructive-mid-flight discipline.
router.delete("/:id", requireRole("admin", "manager"), asyncHandler(async (req, res) => {
  const { rows: found } = await query(
    `SELECT 1 FROM properties WHERE id = $1 AND organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (found.length === 0) return res.status(404).json({ error: "Property not found" });

  const { rows: open } = await query(
    `SELECT count(*)::int AS n
     FROM work_orders w JOIN assets a ON a.id = w.asset_id
     WHERE w.organization_id = $1 AND w.status NOT IN ('done','verified','cancelled')
       AND (a.property_id = $2
            OR EXISTS (SELECT 1 FROM buildings bb WHERE bb.id = a.building_id AND bb.property_id = $2)
            OR EXISTS (SELECT 1 FROM rooms rr
                         JOIN floors ff ON ff.id = rr.floor_id
                         JOIN buildings bb ON bb.id = ff.building_id
                       WHERE rr.id = a.room_id AND bb.property_id = $2))`,
    [req.orgId, req.params.id]
  );
  if (open[0].n > 0) {
    throw new ApiError(400, `Property has ${open[0].n} open work order(s) — resolve them before deleting`);
  }

  await query(`DELETE FROM properties WHERE id = $1 AND organization_id = $2`, [req.params.id, req.orgId]);
  res.status(204).end();
}));

// GET /api/properties/:id/buildings
router.get("/:id/buildings", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT b.* FROM buildings b
     JOIN properties p ON p.id = b.property_id
     WHERE b.property_id = $1 AND p.organization_id = $2
     ORDER BY b.name`,
    [req.params.id, req.orgId]
  );
  res.json(rows);
}));

export default router;
