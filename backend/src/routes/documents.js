// Document attachments — polymorphic upload/list/delete for any entity
// (asset, work_order, property) plus the authenticated file stream. Files are
// stored through the pluggable storage layer (local disk by default, MinIO /
// S3 via STORAGE_DRIVER=s3) under an org-scoped key, and the stream route
// refuses keys whose org prefix does not match the caller — so cross-tenant
// file reads are impossible.

import { Router } from "express";
import multer from "multer";

import { query } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { storage } from "../lib/storage.js";
import {
  ENTITY_TABLES,
  MAX_ATTACHMENT_BYTES,
  contentTypeFor,
  entityBelongsToOrg,
  isValidUuid,
  storeDocument,
} from "../lib/attachments.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

// Normalize multer failures into the API's JSON error shape (413 for the
// size cap, 400 otherwise) instead of Express's default HTML error page.
function uploadOne(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const msg = err?.code === "LIMIT_FILE_SIZE" ? "File exceeds the 20MB limit" : err?.message || "Upload failed";
      return res.status(err?.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: msg });
    }
    next();
  });
}

// GET /api/documents?entity_type=work_order&entity_id=<uuid>
router.get(
  "/documents",
  asyncHandler(async (req, res) => {
    const { entity_type, entity_id } = req.query;
    if (!(entity_type in ENTITY_TABLES) || !entity_id) {
      return res.status(400).json({ error: "entity_type and entity_id are required" });
    }
    if (!(await entityBelongsToOrg(entity_type, entity_id, req.orgId))) {
      return res.status(404).json({ error: "Entity not found in this organization" });
    }
    const { rows } = await query(
      `SELECT d.id, d.entity_type, d.entity_id, d.file_url, d.file_name, d.content_type,
              d.uploaded_by, d.created_at, u.full_name AS uploaded_by_name
         FROM documents d
         LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.organization_id = $1 AND d.entity_type = $2 AND d.entity_id = $3
        ORDER BY d.created_at DESC`,
      [req.orgId, entity_type, entity_id]
    );
    res.json({ data: rows.map((r) => ({ ...r, file_url: `/files/${r.file_url}` })) });
  })
);

// POST /api/documents — multipart/form-data: entity_type, entity_id, file
router.post(
  "/documents",
  uploadOne,
  asyncHandler(async (req, res) => {
    const { entity_type, entity_id } = req.body ?? {};
    if (!(entity_type in ENTITY_TABLES) || !isValidUuid(entity_id)) {
      return res.status(400).json({ error: "entity_type and a valid entity_id are required" });
    }
    if (!req.file) return res.status(400).json({ error: "file is required" });
    if (!(await entityBelongsToOrg(entity_type, entity_id, req.orgId))) {
      return res.status(404).json({ error: "Entity not found in this organization" });
    }

    const fileName = String(req.file.originalname || "attachment").replace(/[/\\]/g, "_").slice(0, 200) || "attachment";
    const contentType = req.file.mimetype || contentTypeFor(fileName);

    const row = await storeDocument({
      orgId: req.orgId,
      entityType: entity_type,
      entityId: entity_id,
      buffer: req.file.buffer,
      fileName,
      contentType,
      uploadedBy: req.userId,
    });
    res.status(201).json({ data: { ...row, file_url: `/files/${row.file_url}` } });
  })
);

// DELETE /api/documents/:id — removes the row and its stored file.
router.delete(
  "/documents/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, file_url FROM documents WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Document not found" });
    await storage.del(rows[0].file_url).catch(() => {});
    await query(`DELETE FROM documents WHERE id = $1`, [rows[0].id]);
    res.status(204).end();
  })
);

// GET /api/files/:key — authenticated stream of a stored object. The key's
// first dot-separated segment is the owning org; anything else is refused.
router.get(
  "/files/:key",
  asyncHandler(async (req, res) => {
    const key = req.params.key;
    const dot = key.indexOf(".");
    if (dot <= 0 || key.slice(0, dot) !== req.orgId) return res.status(404).json({ error: "File not found" });
    const file = await storage.get(key);
    if (!file) return res.status(404).json({ error: "File not found" });

    res.setHeader("Content-Type", file.contentType || contentTypeFor(key));
    res.setHeader("Content-Length", file.size);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(key.slice(dot + 1) || "attachment").replace(/"/g, "")}"`
    );
    res.setHeader("Cache-Control", "private, max-age=300");
    file.stream.on("error", () => res.destroy());
    file.stream.pipe(res);
  })
);

export default router;
