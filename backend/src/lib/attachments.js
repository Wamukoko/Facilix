// Shared attachment helpers for the documents route and the offline sync op.
// Both POST /api/documents (multipart) and the /sync/ops `document.create`
// op store through the same object-storage layer and enforce the same
// entity-ownership rules, so the whitelist and row-writing logic live here
// instead of drifting in two places.

import { query } from "../db.js";
import { storage, contentTypeFor, newKey } from "./storage.js";

export { contentTypeFor } from "./storage.js";

// Entities that accept attachments. The table name is looked up from this
// fixed whitelist (never from request input), so the ownership query below
// cannot be injected into.
export const ENTITY_TABLES = {
  asset: "assets",
  work_order: "work_orders",
  property: "properties",
  contract: "contracts",
};

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// True when the entity exists and belongs to the caller's organization. The
// table name is taken from the fixed whitelist, never from request input.
export async function entityBelongsToOrg(entityType, entityId, orgId) {
  const table = ENTITY_TABLES[entityType];
  if (!table || !isValidUuid(entityId)) return false;
  const { rows } = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2`, [entityId, orgId]);
  return rows.length === 1;
}

// Store a file in object storage and record its documents row. Returns the
// new row (file_url is the storage key, not the public /files path).
export async function storeDocument({ orgId, entityType, entityId, buffer, fileName, contentType, uploadedBy }) {
  const key = newKey(orgId, fileName);
  await storage.put(key, { buffer, contentType });
  const { rows } = await query(
    `INSERT INTO documents (organization_id, entity_type, entity_id, file_url, file_name, content_type, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, entity_type, entity_id, file_url, file_name, content_type, uploaded_by, created_at`,
    [orgId, entityType, entityId, key, fileName, contentType, uploadedBy]
  );
  return rows[0];
}
