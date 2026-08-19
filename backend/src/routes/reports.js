import { Router } from "express";
import { query } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";

const router = Router();

// ---------------------------------------------------------------------------
// Generic CSV generation — each report defines its own COLUMNS array.
// ---------------------------------------------------------------------------
function esc(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const header = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(",")).join("\n");
  return `${header}\n${body}`;
}

function sendReport(res, { columns, rows, filename, format }) {
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
    return res.send(toCsv(columns, rows));
  }
  res.json({ columns: columns.map((c) => c.label), rows });
}

// ---------------------------------------------------------------------------
// 1. Work Orders — existing report, kept for backward compat.
//    ?status=&trade=&priority=&asset_id=&created_after=&created_before=&format=csv
// ---------------------------------------------------------------------------
const WO_COLUMNS = [
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
];

router.get("/work-orders", asyncHandler(async (req, res) => {
  const { status, trade, priority, asset_id, created_after, created_before, format } = req.query;
  const conditions = ["wo.organization_id = $1", "wo.archived_at IS NULL"];
  const params = [req.orgId];

  if (status) { params.push(status); conditions.push(`wo.status = $${params.length}`); }
  if (trade) { params.push(trade); conditions.push(`wo.trade = $${params.length}`); }
  if (priority) { params.push(priority); conditions.push(`wo.priority = $${params.length}`); }
  if (asset_id) { params.push(asset_id); conditions.push(`wo.asset_id = $${params.length}`); }
  if (created_after) { params.push(created_after); conditions.push(`wo.created_at >= $${params.length}::timestamptz`); }
  if (created_before) { params.push(created_before); conditions.push(`wo.created_at <= $${params.length}::timestamptz`); }

  const { rows } = await query(
    `SELECT wo.id, wo.title, wo.trade, wo.priority, wo.status, wo.source,
            a.name AS asset_name, b.name AS building_name,
            wo.cost, wo.due_date, wo.failure_code,
            wo.created_at, wo.completed_at
     FROM work_orders wo
     LEFT JOIN assets a ON a.id = wo.asset_id
     LEFT JOIN buildings b ON b.id = a.building_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY wo.created_at DESC`,
    params
  );

  sendReport(res, { columns: WO_COLUMNS, rows, filename: "work-orders", format });
}));

// ---------------------------------------------------------------------------
// 2. Asset Register — full asset inventory with location + warranty.
//    ?type=&status=&property_id=&format=csv
// ---------------------------------------------------------------------------
const ASSET_COLUMNS = [
  { key: "id", label: "id" },
  { key: "name", label: "name" },
  { key: "type", label: "type" },
  { key: "status", label: "status" },
  { key: "property_name", label: "property" },
  { key: "building_name", label: "building" },
  { key: "room_label", label: "room" },
  { key: "install_date", label: "install_date" },
  { key: "warranty_end", label: "warranty_end" },
  { key: "meter_value", label: "meter_value" },
  { key: "meter_unit", label: "meter_unit" },
  { key: "created_at", label: "created_at" },
];

router.get("/assets", asyncHandler(async (req, res) => {
  const { type, status, property_id, format } = req.query;
  const conditions = ["a.organization_id = $1"];
  const params = [req.orgId];

  if (type) { params.push(type); conditions.push(`a.type = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`a.status = $${params.length}`); }
  if (property_id) { params.push(property_id); conditions.push(`a.property_id = $${params.length}`); }

  const { rows } = await query(
    `SELECT a.id, a.name, a.type, a.status,
            p.name AS property_name, b.name AS building_name,
            r.label AS room_label,
            a.install_date, a.warranty_end,
            a.meter_value, a.meter_unit, a.created_at
     FROM assets a
     LEFT JOIN properties p ON p.id = a.property_id
     LEFT JOIN buildings b ON b.id = a.building_id
     LEFT JOIN rooms r ON r.id = a.room_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY a.name`,
    params
  );

  sendReport(res, { columns: ASSET_COLUMNS, rows, filename: "asset-register", format });
}));

// ---------------------------------------------------------------------------
// 3. Compliance — statutory inspections + staff competencies in one report.
//    ?kind=inspections|competencies|all (default: all)
// ---------------------------------------------------------------------------
const INSPECTION_COLUMNS = [
  { key: "id", label: "id" },
  { key: "requirement", label: "requirement" },
  { key: "asset_name", label: "asset" },
  { key: "frequency_days", label: "frequency_days" },
  { key: "last_done_at", label: "last_done_at" },
  { key: "due_date", label: "due_date" },
  { key: "overdue", label: "overdue" },
];

const COMPETENCY_COLUMNS = [
  { key: "id", label: "id" },
  { key: "user_name", label: "staff" },
  { key: "name", label: "competency" },
  { key: "trade", label: "trade" },
  { key: "expires_at", label: "expires_at" },
  { key: "expired", label: "expired" },
];

router.get("/compliance", asyncHandler(async (req, res) => {
  const { kind = "all", format } = req.query;
  const result = {};

  if (kind === "all" || kind === "inspections") {
    const { rows } = await query(
      `SELECT si.id, si.requirement, a.name AS asset_name,
              si.frequency_days, si.last_done_at, si.due_date,
              si.due_date < now() AND (si.last_done_at IS NULL OR si.last_done_at < si.due_date) AS overdue
       FROM statutory_inspections si
       LEFT JOIN assets a ON a.id = si.asset_id
       WHERE si.organization_id = $1
       ORDER BY si.due_date`,
      [req.orgId]
    );
    result.inspections = rows;
  }

  if (kind === "all" || kind === "competencies") {
    const { rows } = await query(
      `SELECT c.id, u.full_name AS user_name, c.name, c.trade,
              c.expires_at,
              c.expires_at < now() AS expired
       FROM competencies c
       JOIN users u ON u.id = c.user_id
       WHERE c.organization_id = $1
       ORDER BY c.expires_at`,
      [req.orgId]
    );
    result.competencies = rows;
  }

  if (format === "csv") {
    // Merge into a single CSV — inspection rows first, then a blank separator,
    // then competency rows.  This keeps the download simple for auditors.
    const parts = [];
    if (result.inspections) {
      parts.push(toCsv(INSPECTION_COLUMNS, result.inspections));
    }
    if (result.competencies) {
      if (parts.length) parts.push("");
      parts.push(toCsv(COMPETENCY_COLUMNS, result.competencies));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="compliance-report.csv"');
    return res.send(parts.join("\n"));
  }

  res.json(result);
}));

// ---------------------------------------------------------------------------
// 4. Spending — PO + invoice totals grouped by month/quarter.
//    ?period=month|quarter (default: month), start_date, end_date, format=csv
// ---------------------------------------------------------------------------
const SPENDING_COLUMNS = [
  { key: "period", label: "period" },
  { key: "po_count", label: "po_count" },
  { key: "po_total", label: "po_total" },
  { key: "invoice_count", label: "invoice_count" },
  { key: "invoice_total", label: "invoice_total" },
  { key: "paid_total", label: "paid_total" },
];

router.get("/spending", asyncHandler(async (req, res) => {
  const { period = "month", start_date, end_date, format } = req.query;
  const trunc = period === "quarter" ? "quarter" : "month";

  const conditions = ["o.organization_id = $1"];
  const params = [req.orgId];
  if (start_date) { params.push(start_date); conditions.push(`o.created_at >= $${params.length}::timestamptz`); }
  if (end_date) { params.push(end_date); conditions.push(`o.created_at <= $${params.length}::timestamptz`); }

  const wClause = conditions.join(" AND ");

  // PO side — aggregate submitted/received POs by period.
  const { rows: poRows } = await query(
    `SELECT date_trunc('${trunc}', o.created_at)::date AS period,
            count(*)::int AS po_count,
            coalesce(sum(pi.quantity * pi.unit_cost), 0)::numeric AS po_total
     FROM purchase_orders o
     LEFT JOIN purchase_order_items pi ON pi.purchase_order_id = o.id
     WHERE ${wClause} AND o.status != 'cancelled'
     GROUP BY 1 ORDER BY 1`,
    params
  );

  // Invoice side — aggregate issued invoices and paid amounts.
  const { rows: invRows } = await query(
    `SELECT date_trunc('${trunc}', created_at)::date AS period,
            count(*)::int AS invoice_count,
            coalesce(sum(amount), 0)::numeric AS invoice_total,
            coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0)::numeric AS paid_total
     FROM invoices
     WHERE ${wClause} AND status != 'void'
     GROUP BY 1 ORDER BY 1`,
    params
  );

  // Merge both sides on period.
  const byPeriod = new Map();
  for (const r of poRows) {
    const key = String(r.period);
    byPeriod.set(key, { period: key, po_count: r.po_count, po_total: r.po_total, invoice_count: 0, invoice_total: "0", paid_total: "0" });
  }
  for (const r of invRows) {
    const key = String(r.period);
    const existing = byPeriod.get(key);
    if (existing) {
      existing.invoice_count = r.invoice_count;
      existing.invoice_total = r.invoice_total;
      existing.paid_total = r.paid_total;
    } else {
      byPeriod.set(key, { period: key, po_count: 0, po_total: "0", invoice_count: r.invoice_count, invoice_total: r.invoice_total, paid_total: r.paid_total });
    }
  }

  const rows = [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));

  sendReport(res, { columns: SPENDING_COLUMNS, rows, filename: "spending-report", format });
}));

// ---------------------------------------------------------------------------
// 5. Inventory — stock levels and reorder status.
//    ?trade=&low_only=true format=csv
// ---------------------------------------------------------------------------
const INV_COLUMNS = [
  { key: "id", label: "id" },
  { key: "name", label: "name" },
  { key: "trade", label: "trade" },
  { key: "unit", label: "unit" },
  { key: "quantity_on_hand", label: "quantity_on_hand" },
  { key: "reorder_threshold", label: "reorder_threshold" },
  { key: "min_stock", label: "min_stock" },
  { key: "max_stock", label: "max_stock" },
  { key: "location_type", label: "location_type" },
  { key: "warehouse_location", label: "warehouse_location" },
  { key: "needs_reorder", label: "needs_reorder" },
];

router.get("/inventory", asyncHandler(async (req, res) => {
  const { trade, low_only, format } = req.query;
  const conditions = ["i.organization_id = $1"];
  const params = [req.orgId];

  if (trade) { params.push(trade); conditions.push(`i.trade = $${params.length}`); }
  if (low_only === "true") {
    conditions.push(`i.reorder_threshold IS NOT NULL AND i.quantity_on_hand <= i.reorder_threshold`);
  }

  const { rows } = await query(
    `SELECT i.id, i.name, i.trade, i.unit,
            i.quantity_on_hand, i.reorder_threshold,
            i.min_stock, i.max_stock,
            i.location_type, i.warehouse_location,
            (i.reorder_threshold IS NOT NULL AND i.quantity_on_hand <= i.reorder_threshold) AS needs_reorder
     FROM inventory_items i
     WHERE ${conditions.join(" AND ")}
     ORDER BY i.name`,
    params
  );

  sendReport(res, { columns: INV_COLUMNS, rows, filename: "inventory-report", format });
}));

export default router;
