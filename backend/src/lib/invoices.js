// Invoice drafting (Fixflo-inspired "report → works → invoice").
//
// A work order that reaches 'done'/'verified' gets an auto-drafted invoice:
// consumed parts valued at the last received purchase-order unit cost, plus the
// accepted quote amount when a contractor bid won the job. Generation is
// best-effort and idempotent — a failed invoice must never fail a closeout,
// and a replayed closeout never double-drafts.

import { query } from "../db.js";

// Next invoice number for the org: 'INV-<year>-<seq>' where <seq> never reuses
// a number after a void/delete (max suffix + 1). Mirrors PO numbering.
function nextInvoiceNumber(rows) {
  const year = new Date().getFullYear();
  const maxSeq = rows.length
    ? Math.max(
        ...rows.map((r) => {
          const m = /^INV-\d{4}-(\d+)$/.exec(r.invoice_number);
          return m ? Number(m[1]) : 0;
        })
      )
    : 0;
  return `INV-${year}-${String(maxSeq + 1).padStart(4, "0")}`;
}

// Value of the parts consumed by a work order: quantity × last received PO
// unit cost per inventory item (same costing rule as reorder recommendations).
async function partsCost(orgId, workOrderId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(-m.quantity_change * poi.unit_cost), 0)::numeric AS parts_cost
     FROM inventory_movements m
     JOIN inventory_items ii ON ii.id = m.inventory_item_id AND ii.organization_id = $1
     LEFT JOIN LATERAL (
       SELECT poi.unit_cost
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE poi.inventory_item_id = ii.id
         AND po.status = 'received'
         AND po.organization_id = $1
       ORDER BY po.approved_at DESC NULLS LAST, poi.created_at DESC
       LIMIT 1
     ) poi ON true
     WHERE m.work_order_id = $2 AND m.quantity_change < 0`,
    [orgId, workOrderId]
  );
  return Number(rows[0]?.parts_cost ?? 0);
}

// The accepted quote (labor/fee) for the work order, if a bid won the job.
async function acceptedQuote(workOrderId) {
  const { rows } = await query(
    `SELECT amount FROM quotes
     WHERE work_order_id = $1 AND status = 'accepted'
     ORDER BY created_at DESC LIMIT 1`,
    [workOrderId]
  );
  return rows[0]?.amount ?? null;
}

// Draft an invoice for a completed work order. Returns the invoice row or null
// when there is nothing to bill (zero-cost job) or one already exists.
export async function generateInvoiceForWorkOrder(orgId, workOrder) {
  try {
    const existing = await query(
      `SELECT id FROM invoices WHERE work_order_id = $1`,
      [workOrder.id]
    );
    if (existing.rows[0]) return null;

    const [parts, quoteAmount] = await Promise.all([
      partsCost(orgId, workOrder.id),
      acceptedQuote(workOrder.id),
    ]);

    let amount = parts + Number(quoteAmount ?? 0);
    if (amount === 0 && workOrder.cost) amount = Number(workOrder.cost);
    if (amount <= 0) return null;

    const { rows: numbered } = await query(
      `SELECT invoice_number FROM invoices WHERE organization_id = $1`,
      [orgId]
    );
    const invoiceNumber = nextInvoiceNumber(numbered);

    const { rows } = await query(
      `INSERT INTO invoices
         (organization_id, invoice_number, work_order_id, supplier_id, amount, parts_cost, quote_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orgId, invoiceNumber, workOrder.id, workOrder.assigned_supplier_id ?? null, amount, parts, quoteAmount]
    );
    return rows[0];
  } catch (err) {
    console.error("[invoices] auto-draft failed", err.message);
    return null;
  }
}
