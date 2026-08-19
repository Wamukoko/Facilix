import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { query } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { requireRole } from "../middleware/auth.js";
import { validate, uuid } from "../middleware/validate.js";
import { publishEvent } from "../events.js";
import { storage, contentTypeFor, newKey } from "../lib/storage.js";

const router = Router();

const permitType = z.enum(["loto", "confined_space", "hot_work", "electrical_isolation", "working_at_height", "other"]);

const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 } });

function uploadOne(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const msg = err?.code === "LIMIT_FILE_SIZE" ? "File exceeds the 20MB limit" : err?.message || "Upload failed";
      return res.status(err?.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: msg });
    }
    next();
  });
}

// GET /api/compliance/summary — dashboard queue (Phase 11)
router.get("/summary", asyncHandler(async (req, res) => {
  const params = [req.orgId];
  const { rows } = await query(
    `SELECT
       (SELECT count(*) FROM permits WHERE organization_id = $1 AND status IN ('draft','issued')) AS open_permits,
       (SELECT count(*) FROM competencies WHERE organization_id = $1 AND (expires_at IS NULL OR expires_at < now())) AS expired_competencies,
       (SELECT count(*) FROM statutory_inspections WHERE organization_id = $1 AND due_date < now()) AS overdue_inspections`,
    params
  );
  res.json(rows[0]);
}));

// --- Permits (permit-to-work) ---

const createPermit = z.object({
  work_order_id: uuid.nullable().optional(),
  type: permitType,
  notes: z.string().trim().max(2000).nullable().optional(),
  expires_at: z.coerce.date().nullable().optional(),
});

// POST /api/compliance/permits
router.post("/permits", requireRole("admin", "manager"), validate(createPermit), asyncHandler(async (req, res) => {
  const { work_order_id, type, notes, expires_at } = req.body;
  const { rows } = await query(
    `INSERT INTO permits (organization_id, work_order_id, type, notes, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.orgId, work_order_id || null, type, notes || null, expires_at || null]
  );
  res.status(201).json(rows[0]);
}));

// GET /api/compliance/permits?status=issued&work_order_id=
router.get("/permits", asyncHandler(async (req, res) => {
  const { status, work_order_id } = req.query;
  const conditions = ["organization_id = $1"];
  const params = [req.orgId];
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (work_order_id) { params.push(work_order_id); conditions.push(`work_order_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT *, (evidence_url IS NOT NULL) AS has_evidence FROM permits WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
    params
  );
  res.json({ data: rows.map((r) => ({ ...r, evidence_url: r.evidence_url ? `/files/${r.evidence_url}` : null })) });
}));

// POST /api/compliance/permits/:id/evidence — attach the signed permit / photos
// of the work area. The file is stored through the pluggable storage layer
// (MinIO in production, local disk in dev) and its key is recorded on the
// permit so the audit trail points at immutable evidence.
router.post(
  "/permits/:id/evidence",
  requireRole("admin", "manager"),
  uploadOne,
  asyncHandler(async (req, res) => {
    const { rows: existing } = await query(`SELECT id FROM permits WHERE id = $1 AND organization_id = $2`, [req.params.id, req.orgId]);
    if (!existing[0]) throw new ApiError(404, "Permit not found");
    if (!req.file) throw new ApiError(400, "file is required");

    const fileName = String(req.file.originalname || "permit").replace(/[/\\]/g, "_").slice(0, 200) || "permit";
    const contentType = req.file.mimetype || contentTypeFor(fileName);
    const key = newKey(req.orgId, fileName);
    await storage.put(key, { buffer: req.file.buffer, contentType });

    const { rows } = await query(
      `UPDATE permits SET evidence_url = $1 WHERE id = $2 RETURNING *`,
      [key, req.params.id]
    );
    res.status(201).json({ data: { ...rows[0], evidence_url: `/files/${rows[0].evidence_url}`, has_evidence: true } });
  })
);

const decidePermit = z.object({
  status: z.enum(["issued", "closed", "cancelled"]),
  notes: z.string().trim().max(2000).nullable().optional(),
  evidence_url: z.string().trim().max(2000).nullable().optional(),
});

// PATCH /api/compliance/permits/:id — issue / close / cancel
router.patch("/permits/:id", requireRole("admin", "manager"), validate(decidePermit), asyncHandler(async (req, res) => {
  const { status, notes, evidence_url } = req.body;
  const { rows: existing } = await query(`SELECT * FROM permits WHERE id = $1 AND organization_id = $2`, [req.params.id, req.orgId]);
  if (!existing[0]) throw new ApiError(404, "Permit not found");

  const sets = ["status = $1"];
  const params = [status];
  if (status === "issued") { sets.push("issued_at = now()", "issued_by = $2"); params.push(req.userId); }
  if (status === "closed") { sets.push("closed_at = now()"); }
  if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`); }
  if (evidence_url !== undefined) { params.push(evidence_url); sets.push(`evidence_url = $${params.length}`); }
  params.push(req.params.id, req.orgId);

  const { rows } = await query(
    `UPDATE permits SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND organization_id = $${params.length} RETURNING *`,
    params
  );

  // Phase 12: event bus — integrations (e.g. BMS lockout sync) can react.
  if (status === "issued") {
    await publishEvent(req.orgId, "compliance.permit_issued", {
      permit_id: rows[0].id,
      work_order_id: rows[0].work_order_id,
      type: rows[0].type,
      issued_at: rows[0].issued_at,
    });
  }

  res.json(rows[0]);
}));

// --- Competencies ---

const createCompetency = z.object({
  user_id: uuid,
  name: z.string().trim().min(1).max(200),
  trade: z.string().trim().max(40).nullable().optional(),
  expires_at: z.coerce.date().nullable().optional(),
});

// POST /api/compliance/competencies
router.post("/competencies", requireRole("admin", "manager"), validate(createCompetency), asyncHandler(async (req, res) => {
  const { user_id, name, trade, expires_at } = req.body;
  const { rows } = await query(
    `INSERT INTO competencies (organization_id, user_id, name, trade, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.orgId, user_id, name, trade || null, expires_at || null]
  );
  res.status(201).json(rows[0]);
}));

// GET /api/compliance/competencies?user_id=
router.get("/competencies", asyncHandler(async (req, res) => {
  const { user_id } = req.query;
  const conditions = ["c.organization_id = $1"];
  const params = [req.orgId];
  if (user_id) { params.push(user_id); conditions.push(`c.user_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT c.*, u.full_name AS user_name,
            (c.expires_at IS NULL OR c.expires_at < now()) AS expired
     FROM competencies c JOIN users u ON u.id = c.user_id
     WHERE ${conditions.join(" AND ")} ORDER BY c.expires_at ASC NULLS LAST`,
    params
  );
  res.json({ data: rows });
}));

// --- Statutory inspections ---

const createInspection = z.object({
  asset_id: uuid.nullable().optional(),
  requirement: z.string().trim().min(1).max(300),
  frequency_days: z.coerce.number().int().positive().optional(),
  due_date: z.coerce.date(),
  last_done_at: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

// POST /api/compliance/inspections
router.post("/inspections", requireRole("admin", "manager"), validate(createInspection), asyncHandler(async (req, res) => {
  const { asset_id, requirement, frequency_days, due_date, last_done_at, notes } = req.body;
  const { rows } = await query(
    `INSERT INTO statutory_inspections (organization_id, asset_id, requirement, frequency_days, due_date, last_done_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.orgId, asset_id || null, requirement, frequency_days || 365, due_date, last_done_at || null, notes || null]
  );
  res.status(201).json(rows[0]);
}));

// GET /api/compliance/inspections
router.get("/inspections", asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT *, (due_date < now()) AS overdue FROM statutory_inspections
     WHERE organization_id = $1 ORDER BY due_date ASC`,
    [req.orgId]
  );
  res.json({ data: rows });
}));

const doneInspection = z.object({ last_done_at: z.coerce.date().nullable().optional() });
// PATCH /api/compliance/inspections/:id — record an inspection, rolling the due date
router.patch("/inspections/:id", requireRole("admin", "manager"), validate(doneInspection), asyncHandler(async (req, res) => {
  const { rows: existing } = await query(`SELECT * FROM statutory_inspections WHERE id = $1 AND organization_id = $2`, [req.params.id, req.orgId]);
  if (!existing[0]) throw new ApiError(404, "Inspection not found");
  const doneAt = req.body.last_done_at || new Date();
  const due = new Date(doneAt.getTime() + (existing[0].frequency_days || 365) * 86400000);
  const { rows } = await query(
    `UPDATE statutory_inspections SET last_done_at = $1, due_date = $2 WHERE id = $3 RETURNING *`,
    [doneAt, due, req.params.id]
  );
  res.json(rows[0]);
}));

export default router;
