import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import { assertTrade, assertAssetType } from "../lib/lookups.js";
import { listConnectors } from "../lib/connectors.js";
import { knownEvents } from "../events.js";

// Phase 12 — integrations: public data dictionary, connector registry,
// and self-service CSV export/import.

const router = Router();

// --- Public data dictionary (no auth — it is documentation, not data). ---

export function dataDictionaryHandler(req, res) {
  res.json({
    name: "Facilix CMMS API",
    version: "1",
    docs: "https://localhost:5173/api/integrations/data-dictionary",
    resources: {
      properties: { methods: ["GET", "POST"] },
      buildings: { methods: ["GET", "POST"] },
      floors: { methods: ["GET", "POST"] },
      rooms: { methods: ["GET", "POST"] },
      assets: { methods: ["GET", "GET /:id", "POST", "PATCH /:id", "DELETE /:id"] },
      "work-orders": { methods: ["GET", "POST", "PATCH /:id"] },
      "maintenance-plans": { methods: ["GET", "POST"] },
      inventory: { methods: ["GET", "POST", "PATCH /:id", "POST /:id/movements"] },
      suppliers: { methods: ["GET", "POST"] },
      quotes: { methods: ["GET", "POST"] },
      compliance: { methods: ["permits", "competencies", "inspections", "summary"] },
      notifications: { methods: ["GET", "PATCH /:id/read"] },
      users: { methods: ["GET", "POST", "PATCH /:id", "DELETE /:id"] },
      config: { methods: ["GET", "POST /:kind", "PATCH /:kind/:value"] },
      webhooks: { methods: ["GET", "POST", "PATCH /:id", "DELETE /:id", "POST /flush", "GET /deliveries"] },
      "integrations": { methods: ["GET /connectors", "GET /export/:kind", "POST /import/:kind"] },
    },
    events: {
      summary: "Outbound webhooks. POSTed to your endpoint as JSON with an HMAC-SHA256 signature in X-Facilix-Signature (sha256=<hex>) using your webhook secret; X-Facilix-Event names the event; event_id is the dedupe key.",
      catalog: knownEvents().map((name) => ({ name })),
    },
    enums: {
      role: ["admin", "manager", "technician", "tenant", "supplier"],
      wo_status: ["open", "assigned", "in_progress", "done", "verified", "cancelled"],
      wo_priority: ["low", "normal", "high", "urgent"],
      wo_source: ["plan", "breakdown", "tenant_request"],
      failure_code: [
        "wear_and_tear", "corrosion", "lubrication", "blockage", "leak",
        "electrical_fault", "overload", "foreign_object", "operator_error",
        "installation_error", "manufacturer_defect", "water_damage",
        "no_fault_found", "other",
      ],
      asset_status: ["active", "retired", "under_repair"],
      permit_type: ["loto", "confined_space", "hot_work", "electrical_isolation", "working_at_height", "other"],
      permit_status: ["draft", "issued", "closed", "cancelled"],
      trigger_type: ["scheduled", "meter_based", "on_demand"],
    },
    export_kinds: ["work_orders", "assets", "inventory_items", "users", "properties"],
    import_kinds: ["assets", "inventory_items", "properties"],
  });
}

// --- Connector registry ---

router.get("/connectors", asyncHandler(async (req, res) => {
  res.json({ data: listConnectors() });
}));

// --- CSV export ---

const EXPORT_COLUMNS = {
  work_orders: [
    { key: "id", label: "id" },
    { key: "title", label: "title" },
    { key: "trade", label: "trade" },
    { key: "priority", label: "priority" },
    { key: "status", label: "status" },
    { key: "source", label: "source" },
    { key: "asset_name", label: "asset" },
    { key: "cost", label: "cost" },
    { key: "due_date", label: "due_date" },
    { key: "failure_code", label: "failure_code" },
    { key: "created_at", label: "created_at" },
    { key: "completed_at", label: "completed_at" },
  ],
  assets: [
    { key: "id", label: "id" },
    { key: "name", label: "name" },
    { key: "type", label: "type" },
    { key: "status", label: "status" },
    { key: "install_date", label: "install_date" },
    { key: "warranty_end", label: "warranty_end" },
    { key: "meter_value", label: "meter_value" },
    { key: "meter_unit", label: "meter_unit" },
    { key: "created_at", label: "created_at" },
  ],
  inventory_items: [
    { key: "id", label: "id" },
    { key: "name", label: "name" },
    { key: "trade", label: "trade" },
    { key: "unit", label: "unit" },
    { key: "quantity_on_hand", label: "quantity_on_hand" },
    { key: "reorder_threshold", label: "reorder_threshold" },
    { key: "warehouse_location", label: "warehouse_location" },
    { key: "created_at", label: "created_at" },
  ],
  users: [
    { key: "id", label: "id" },
    { key: "full_name", label: "full_name" },
    { key: "email", label: "email" },
    { key: "role", label: "role" },
    { key: "trade", label: "trade" },
    { key: "active", label: "active" },
  ],
  properties: [
    { key: "id", label: "id" },
    { key: "name", label: "name" },
    { key: "address", label: "address" },
    { key: "created_at", label: "created_at" },
  ],
};

const EXPORT_QUERIES = {
  work_orders: (orgId) => ({
    text: `SELECT wo.id, wo.title, wo.trade, wo.priority, wo.status, wo.source,
                  a.name AS asset_name, wo.cost, wo.due_date, wo.failure_code,
                  wo.created_at, wo.completed_at
           FROM work_orders wo LEFT JOIN assets a ON a.id = wo.asset_id
           WHERE wo.organization_id = $1 ORDER BY wo.created_at DESC`,
    params: [orgId],
  }),
  assets: (orgId) => ({
    text: `SELECT id, name, type, status, install_date, warranty_end, meter_value, meter_unit, created_at
           FROM assets WHERE organization_id = $1 ORDER BY name`,
    params: [orgId],
  }),
  inventory_items: (orgId) => ({
    text: `SELECT id, name, trade, unit, quantity_on_hand, reorder_threshold, warehouse_location, created_at
           FROM inventory_items WHERE organization_id = $1 ORDER BY name`,
    params: [orgId],
  }),
  users: (orgId) => ({
    text: `SELECT id, full_name, email, role, trade, active
           FROM users WHERE organization_id = $1 AND role != 'supplier' ORDER BY full_name`,
    params: [orgId],
  }),
  properties: (orgId) => ({
    text: `SELECT id, name, address, created_at FROM properties WHERE organization_id = $1 ORDER BY name`,
    params: [orgId],
  }),
};

function esc(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(",")).join("\n");
  return `${header}\n${body}`;
}

router.get("/export/:kind", asyncHandler(async (req, res) => {
  const { kind } = req.params;
  const columns = EXPORT_COLUMNS[kind];
  const build = EXPORT_QUERIES[kind];
  if (!columns || !build) throw new ApiError(404, `Unknown export kind "${kind}"`);

  const { text, params } = build(req.orgId);
  const { rows } = await query(text, params);

  if (req.query.format === "json") return res.json(rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${kind}.csv"`);
  res.send(toCsv(rows, columns));
}));

// --- CSV import ---

// Minimal RFC-4180-ish parser: quoted fields, escaped quotes, CRLF-tolerant.
// Good enough for files produced by the export endpoint or a spreadsheet.
export function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) throw new ApiError(400, "CSV is empty — expected a header row");
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? "").trim(); });
    return obj;
  });
}

const importSchema = z.object({
  csv: z.string().min(1, "csv is required"),
});

const IMPORT_HANDLERS = {
  // name,type[,status,install_date,warranty_end,meter_value,meter_unit]
  async assets(orgId, records) {
    let imported = 0;
    const errors = [];
    for (const r of records) {
      if (!r.name) { errors.push({ row: r, message: "name is required" }); continue; }
      if (!r.type) { errors.push({ row: r, message: "type is required" }); continue; }
      try {
        await assertAssetType(orgId, r.type);
      } catch (err) {
        errors.push({ row: r, message: err.message }); continue;
      }
      try {
        await query(
          `INSERT INTO assets (organization_id, name, type, status, install_date, warranty_end, meter_value, meter_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orgId, r.name, r.type, r.status || "active",
           r.install_date || null, r.warranty_end || null,
           r.meter_value !== "" ? Number(r.meter_value) : null, r.meter_unit || null]
        );
        imported += 1;
      } catch (err) {
        errors.push({ row: r, message: err.message });
      }
    }
    return { imported, skipped: errors.length, errors };
  },
  // name,unit[,trade,quantity_on_hand,reorder_threshold,warehouse_location]
  async inventory_items(orgId, records) {
    let imported = 0;
    const errors = [];
    for (const r of records) {
      if (!r.name) { errors.push({ row: r, message: "name is required" }); continue; }
      if (r.trade) {
        try {
          await assertTrade(orgId, r.trade);
        } catch (err) {
          errors.push({ row: r, message: err.message }); continue;
        }
      }
      try {
        await query(
          `INSERT INTO inventory_items (organization_id, name, trade, unit, quantity_on_hand, reorder_threshold, warehouse_location)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [orgId, r.name, r.trade || null, r.unit || null,
           r.quantity_on_hand !== "" ? Number(r.quantity_on_hand) : 0,
           r.reorder_threshold !== "" ? Number(r.reorder_threshold) : null,
           r.warehouse_location || null]
        );
        imported += 1;
      } catch (err) {
        errors.push({ row: r, message: err.message });
      }
    }
    return { imported, skipped: errors.length, errors };
  },
  // name[,address]
  async properties(orgId, records) {
    let imported = 0;
    const errors = [];
    for (const r of records) {
      if (!r.name) { errors.push({ row: r, message: "name is required" }); continue; }
      try {
        await query(
          `INSERT INTO properties (organization_id, name, address) VALUES ($1,$2,$3)`,
          [orgId, r.name, r.address || null]
        );
        imported += 1;
      } catch (err) {
        errors.push({ row: r, message: err.message });
      }
    }
    return { imported, skipped: errors.length, errors };
  },
};

router.post(
  "/import/:kind",
  requireRole("admin", "manager"),
  validate(importSchema),
  asyncHandler(async (req, res) => {
    const handler = IMPORT_HANDLERS[req.params.kind];
    if (!handler) throw new ApiError(404, `Unknown import kind "${req.params.kind}"`);
    const records = rowsToObjects(parseCsv(req.body.csv));
    const result = await handler(req.orgId, records);
    res.status(result.imported ? 201 : 200).json(result);
  })
);

export default router;
