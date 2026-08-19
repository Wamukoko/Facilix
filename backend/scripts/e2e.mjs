// Dev-only end-to-end check against a real API + database:
// boots the server, runs signup → auth → lists → work-order lifecycle →
// closeout rejection/acceptance → meter capture, then tears down.
//
//   npm run e2e

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { pool, query } from "../src/db.js";

const BASE = "http://127.0.0.1:4000/api";
const run = Date.now();

// A client timestamp clearly newer than any row the test just created. The
// device clock and the server share a millisecond here, and toISOString()
// truncates to ms — using a fresh-but-future stamp keeps the LWW gate
// deterministic (a write the test intends to win must not look stale).
const laterTs = (ms = 5000) => new Date(Date.now() + ms).toISOString();

let results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function startServer() {
  // stdio inherit so boot errors (e.g. EADDRINUSE) are visible in the run.
  const child = spawn(process.execPath, ["src/index.js"], { cwd: process.cwd(), stdio: "inherit" });
  child.unref();
  return child;
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let firstError = null;
  while (Date.now() < deadline) {
    try {
      // /health is mounted at the root, not under /api.
      const res = await fetch("http://localhost:4000/health");
      if (res.ok) return true;
      firstError = firstError ?? `HTTP ${res.status}`;
    } catch (err) {
      firstError = firstError ?? err.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`  health probe failed: ${firstError}`);
  return false;
}

// Phase 12 — a tiny local HTTP sink that captures outbound webhook POSTs so
// the e2e run can verify the payload + HMAC signature without a real provider.
function startWebhookSink() {
  return new Promise((resolve) => {
    const received = [];
    const server = createServer((req, res) => {
      let chunks = "";
      req.on("data", (c) => (chunks += c));
      req.on("end", () => {
        received.push({ method: req.method, headers: req.headers, body: chunks });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port }));
  });
}

async function main() {
  const server = startServer();
  if (!(await waitForHealth())) {
    check("server boots + /health", false, "timed out waiting for /health");
    server.kill();
    process.exit(1);
  }
  check("server boots + /health", true);

  const email = `e2e-${run}@test.local`;
  let token;
  let orgId;
  let extraOrgId;

  try {
    // 1. Signup creates org + admin and returns a JWT
    const signup = await api("/auth/signup", {
      method: "POST",
      body: { orgName: `E2E Org ${run}`, fullName: "Tester", email, password: "password-123" },
    });
    check("signup → 201 + token", signup.status === 201 && !!signup.data?.token, `status ${signup.status}`);
    token = signup.data?.token;
    orgId = signup.data?.user?.organization_id;
    const userId = signup.data?.user?.id;
    if (!token) throw new Error("signup did not return a token");

    // 2. Unauthenticated access is rejected
    const unauth = await api("/work-orders");
    check("unauthenticated request → 401", unauth.status === 401, `status ${unauth.status}`);

    // 3. Authenticated list returns the pagination envelope
    const list = await api("/work-orders", { token });
    check(
      "GET /work-orders → { data, meta }",
      list.status === 200 && Array.isArray(list.data?.data) && typeof list.data?.meta?.total === "number",
      `status ${list.status}`
    );

    // 3b. Configurable vocabulary — seeded at signup, addable/toggleable at runtime
    const cfg = await api("/config", { token });
    check(
      "GET /config seeds default vocabulary",
      cfg.status === 200 &&
        cfg.data?.trades?.some((t) => t.value === "plumbing") &&
        cfg.data?.asset_types?.some((t) => t.value === "electrical"),
      `status ${cfg.status}`
    );

    const newTrade = await api("/config/trades", { method: "POST", token, body: { value: "welding", label: "Welding" } });
    check("POST /config/trades → 201", newTrade.status === 201 && newTrade.data?.value === "welding", `status ${newTrade.status}`);

    const dupTrade = await api("/config/trades", { method: "POST", token, body: { value: "welding", label: "Welding" } });
    check("duplicate trade → 409", dupTrade.status === 409, `status ${dupTrade.status}`);

    const badTrade = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "not_a_trade", title: "bad", source: "breakdown" },
    });
    check("unknown trade rejected → 400", badTrade.status === 400, `status ${badTrade.status}`);

    const customWo = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "welding", title: "Weld test", source: "breakdown" },
    });
    check("custom trade accepted → 201", customWo.status === 201, `status ${customWo.status}`);

    const deact = await api("/config/trades/welding", { method: "PATCH", token, body: { active: false } });
    check("deactivate trade → active=false", deact.status === 200 && deact.data?.active === false, `status ${deact.status}`);

    const deactWo = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "welding", title: "Weld 2", source: "breakdown" },
    });
    check("inactive trade rejected → 400", deactWo.status === 400, `status ${deactWo.status}`);

    const newType = await api("/config/asset_types", { method: "POST", token, body: { value: "solar", label: "Solar PV" } });
    check("POST /config/asset_types → 201", newType.status === 201 && newType.data?.value === "solar", `status ${newType.status}`);
    const solarAsset = await api("/assets", { method: "POST", token, body: { name: "PV Array", type: "solar" } });
    check("asset with custom type → 201", solarAsset.status === 201, `status ${solarAsset.status}`);

    // 4. Create a breakdown work order
    const created = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "plumbing", title: "E2E test leak", source: "breakdown", priority: "high" },
    });
    check("POST /work-orders → 201", created.status === 201 && created.data?.id, `status ${created.status}`);
    const woId = created.data.id;

    // 5. Advance open → assigned → in_progress
    for (const [next, label] of [["assigned", "assigned"], ["in_progress", "in_progress"]]) {
      const r = await api(`/work-orders/${woId}`, { method: "PATCH", token, body: { status: next } });
      check(`advance → ${label}`, r.status === 200 && r.data.status === next, `status ${r.status}`);
    }

    // 5b. Assigning a work order notifies the assignee (Phase 7)
    const assigned = await api(`/work-orders/${woId}`, { method: "PATCH", token, body: { assigned_user_id: userId } });
    check("assign → 200", assigned.status === 200, `status ${assigned.status}`);
    const notifs = await api("/notifications", { token });
    check(
      "assignment creates a notification for the assignee",
      notifs.status === 200 &&
        Array.isArray(notifs.data?.data) &&
        notifs.data.data.some((n) => n.type === "work_order_assigned" && n.user_id === userId),
      `status ${notifs.status}`
    );

    // 5c. Contractor portal — supplier, quotes, SLA clock, scorecard (Phase 10)
    const sup = await api("/suppliers", { method: "POST", token, body: { name: "Test Plumbing Co", trade: "plumbing", contact_email: `sup-${run}@test.co` } });
    check("create supplier → 201", sup.status === 201, `status ${sup.status}`);
    const supplierId = sup.data?.id;

    // A supplier login is a DB-row with role='supplier' linked to the supplier.
    const supHash = await bcrypt.hash("facilix-demo", 10);
    await query(
      `INSERT INTO users (organization_id, email, password_hash, full_name, role, trade, supplier_id)
       VALUES ($1,$2,$3,$4,'supplier','plumbing',$5)`,
      [orgId, `supplier-${run}@test.co`, supHash, "Test Supplier", supplierId]
    );
    const supLogin = await api("/auth/login", { method: "POST", body: { email: `supplier-${run}@test.co`, password: "facilix-demo" } });
    check("supplier login → 200", supLogin.status === 200 && !!supLogin.data?.token, `status ${supLogin.status}`);
    const supplierToken = supLogin.data?.token;

    // A fresh open work order to bid on; assert the SLA clock is stamped.
    const qWo = await api("/work-orders", { method: "POST", token, body: { trade: "plumbing", title: "Bid test — pump", source: "breakdown" } });
    check("SLA due stamped on create", !!qWo.data?.sla_due_at, `sla_due_at=${qWo.data?.sla_due_at}`);
    const qWoId = qWo.data?.id;
    const qList = await api("/work-orders", { token });
    const qRow = qList.data?.data?.find((w) => w.id === qWoId);
    check("sla_breached computed on list", typeof qRow?.sla_breached === "boolean", `sla_breached=${qRow?.sla_breached}`);

    const bid = await api(`/work-orders/${qWoId}/quotes`, { method: "POST", token: supplierToken, body: { amount: 5000, note: "Labour + parts" } });
    check("supplier submits quote → 201", bid.status === 201, `status ${bid.status}`);

    const adminQuotes = await api(`/work-orders/${qWoId}/quotes`, { token });
    check("admin sees quotes with supplier name", adminQuotes.status === 200 && adminQuotes.data?.data?.length === 1 && !!adminQuotes.data.data[0].supplier_name, `status ${adminQuotes.status}`);
    const supQuotes = await api(`/work-orders/${qWoId}/quotes`, { token: supplierToken });
    check("supplier sees only own quote", supQuotes.status === 200 && supQuotes.data?.data?.length === 1, `status ${supQuotes.status}`);

    const quoteId = adminQuotes.data.data[0].id;
    const accept = await api(`/work-orders/${qWoId}/quotes/${quoteId}`, { method: "PATCH", token, body: { status: "accepted" } });
    check("accept quote → 200", accept.status === 200 && accept.data?.status === "accepted", `status ${accept.status}`);
    const afterAccept = await api("/work-orders", { token });
    const acceptedRow = afterAccept.data?.data?.find((w) => w.id === qWoId);
    check("accepting assigns supplier to work order", acceptedRow?.assigned_supplier_id === supplierId, `assigned=${acceptedRow?.assigned_supplier_id}`);

    const sc = await api(`/suppliers/${supplierId}/scorecard`, { token });
    check("supplier scorecard aggregates", sc.status === 200 && Number(sc.data?.total_quotes) >= 1 && Number(sc.data?.accepted_quotes) >= 1, `status ${sc.status}`);

    // 6. Closing without failure data is rejected (Phase 8)
    const noCloseout = await api(`/work-orders/${woId}`, { method: "PATCH", token, body: { status: "done" } });
    check("closeout without failure_code → 400", noCloseout.status === 400, `status ${noCloseout.status}`);

    // 7. Vague closeout answers are rejected
    const vague = await api(`/work-orders/${woId}`, {
      method: "PATCH",
      token,
      body: { status: "done", failure_code: "leak", root_cause: "fixed", remedy: "done" },
    });
    check("vague root_cause/remedy → 400", vague.status === 400 && /root_cause/.test(vague.data.error || ""), `status ${vague.status}`);

    // 8. A structured closeout succeeds and stamps completion
    const closed = await api(`/work-orders/${woId}`, {
      method: "PATCH",
      token,
      body: {
        status: "done",
        failure_code: "leak",
        root_cause: "Seal worn through at the union joint",
        remedy: "Replaced the 20mm washer and retightened the union",
        parts_used: "Washer 20mm ×2",
      },
    });
    check(
      "structured closeout → 200 + completed_at",
      closed.status === 200 && closed.data.status === "done" && !!closed.data.completed_at && closed.data.failure_code === "leak",
      `status ${closed.status}`
    );

    // 9. Closing a metered asset work order records a meter reading
    const asset = await api("/assets", {
      method: "POST",
      token,
      body: { name: `E2E Pump ${run}`, type: "plumbing", meter_value: 1000, meter_unit: "hours" },
    });
    check("POST /assets → 201", asset.status === 201 && asset.data?.id, `status ${asset.status}`);

    const metered = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "plumbing", title: "E2E metered closeout", source: "plan", asset_id: asset.data.id },
    });
    const meterClose = await api(`/work-orders/${metered.data.id}`, {
      method: "PATCH",
      token,
      body: {
        status: "done",
        failure_code: "wear_and_tear",
        root_cause: "Expected end-of-interval service",
        remedy: "Replaced filters per plan",
        meter_value_at_closeout: 1234,
      },
    });
    check("metered closeout → 200", meterClose.status === 200, `status ${meterClose.status}`);

    const readings = await query(
      `SELECT reading_value, reading_unit FROM meter_readings WHERE asset_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
      [asset.data.id]
    );
    check(
      "meter reading captured with asset unit",
      Number(readings.rows[0]?.reading_value) === 1234 && readings.rows[0]?.reading_unit === "hours",
      JSON.stringify(readings.rows[0])
    );

    // 10. Inventory: create, list, restock, consume, low-stock filter (Phase 9)
    const item = await api("/inventory", {
      method: "POST",
      token,
      body: { name: `E2E washer ${run}`, trade: "plumbing", unit: "pcs", quantity_on_hand: 5, reorder_threshold: 3 },
    });
    check("POST /inventory → 201", item.status === 201 && item.data?.id, `status ${item.status}`);
    const itemId = item.data?.id;

    const invList = await api("/inventory", { token });
    check("GET /inventory lists item", invList.status === 200 && invList.data?.data?.some((i) => i.id === itemId), `status ${invList.status}`);

    const restock = await api(`/inventory/${itemId}/movements`, { method: "POST", token, body: { quantity_change: 3, reason: "Delivery" } });
    check("restock +3 → qty 8", restock.status === 201, `status ${restock.status}`);

    const overdraw = await api(`/inventory/${itemId}/movements`, { method: "POST", token, body: { quantity_change: -999 } });
    check("overdraw → 400", overdraw.status === 400, `status ${overdraw.status}`);

    const consume = await api(`/inventory/${itemId}/movements`, { method: "POST", token, body: { quantity_change: -2, reason: "E2E consumption" } });
    check("consume −2 → 201", consume.status === 201, `status ${consume.status}`);

    const lowItem = await api("/inventory", {
      method: "POST",
      token,
      body: { name: `E2E low stock ${run}`, trade: "plumbing", quantity_on_hand: 1, reorder_threshold: 5 },
    });
    const lowItemId = lowItem.data?.id;
    const lowList = await api("/inventory?low=1", { token });
    check(
      "low=1 filter returns reorder items",
      lowList.status === 200 && lowList.data?.data?.length > 0 && lowList.data.data.every((i) => Number(i.quantity_on_hand) <= Number(i.reorder_threshold)),
      `status ${lowList.status}`
    );

    // 11. Closing a work order with `parts` decrements stock + writes a movement
    const invWo = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "plumbing", title: "E2E parts closeout", source: "breakdown" },
    });
    const invClose = await api(`/work-orders/${invWo.data.id}`, {
      method: "PATCH",
      token,
      body: {
        status: "done",
        failure_code: "leak",
        root_cause: "Worn seal in the tap assembly",
        remedy: "Replaced the washer and reseated the seal",
        parts: [{ item_id: itemId, quantity: 2 }],
      },
    });
    check("closeout with parts → 200", invClose.status === 200, `status ${invClose.status}`);

    const after = await query(`SELECT quantity_on_hand FROM inventory_items WHERE id = $1`, [itemId]);
    const movement = await query(
      `SELECT quantity_change FROM inventory_movements WHERE inventory_item_id = $1 AND work_order_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [itemId, invWo.data.id]
    );
    check(
      "parts consumption decrements stock + writes movement",
      Number(after.rows[0]?.quantity_on_hand) === 4 && Number(movement.rows[0]?.quantity_change) === -2,
      `qty=${after.rows[0]?.quantity_on_hand} movement=${movement.rows[0]?.quantity_change}`
    );

    // 11b. Procurement: min/max + van stock, reservations, reorder
    // recommendations, and the full purchase-order lifecycle (Phase 9)
    const confItem = await api(`/inventory/${itemId}`, {
      method: "PATCH",
      token,
      body: { min_stock: 2, max_stock: 12, location_type: "van" },
    });
    check(
      "PATCH inventory min/max/van → 200",
      confItem.status === 200 && confItem.data?.location_type === "van" && Number(confItem.data?.max_stock) === 12,
      `status ${confItem.status}`
    );

    const reserve = await api(`/inventory/${itemId}/reservations`, {
      method: "POST",
      token,
      body: { quantity: 2, reason: "E2E held for scheduled job" },
    });
    check("create reservation → 201", reserve.status === 201 && reserve.data?.status === "active", `status ${reserve.status}`);

    const invWithRes = await api("/inventory", { token });
    const resRow = invWithRes.data?.data?.find((i) => i.id === itemId);
    check(
      "GET inventory exposes reserved_qty",
      invWithRes.status === 200 && Number(resRow?.reserved_qty) === 2,
      `reserved=${resRow?.reserved_qty}`
    );

    const overReserve = await api(`/inventory/${itemId}/reservations`, { method: "POST", token, body: { quantity: 9999 } });
    check("over-reservation → 400", overReserve.status === 400, `status ${overReserve.status}`);

    const release = await api(`/inventory/reservations/${reserve.data.id}/release`, { method: "POST", token });
    check("release reservation → 200", release.status === 200 && release.data?.status === "released", `status ${release.status}`);

    const recs = await api("/inventory/reorder-recommendations", { token });
    const recRow = recs.data?.data?.find((r) => r.id === lowItemId);
    check(
      "reorder recommendations list low items with suggested qty",
      recs.status === 200 && !!recRow && Number(recRow.suggested_qty) > 0 && recRow.last_unit_cost === null,
      `status ${recs.status}`
    );

    const po = await api("/purchase-orders", {
      method: "POST",
      token,
      body: {
        supplier_id: supplierId,
        expected_date: "2026-09-01",
        notes: "E2E procurement",
        items: [{ item_id: itemId, quantity: 5, unit_cost: 150 }],
      },
    });
    check(
      "create PO draft → 201 with po_number",
      po.status === 201 && po.data?.status === "draft" && /^PO-\d{4}-\d{4}$/.test(po.data?.po_number ?? ""),
      `status ${po.status} number=${po.data?.po_number}`
    );
    const poId = po.data?.id;

    const poList = await api("/purchase-orders", { token });
    const poRow = poList.data?.data?.find((p) => p.id === poId);
    check(
      "PO list shows supplier + total",
      poList.status === 200 && poRow?.supplier_name === "Test Plumbing Co" && Number(poRow?.total) === 750,
      `total=${poRow?.total}`
    );

    const addLine = await api(`/purchase-orders/${poId}/items`, {
      method: "POST",
      token,
      body: { item_id: lowItemId, quantity: 2, unit_cost: 80 },
    });
    check("add PO line item → 201", addLine.status === 201 && Number(addLine.data?.quantity) === 2, `status ${addLine.status}`);

    const submitPo = await api(`/purchase-orders/${poId}/submit`, { method: "POST", token });
    check("submit PO → submitted", submitPo.status === 200 && submitPo.data?.status === "submitted", `status ${submitPo.status}`);

    const nonAdminApprove = await api(`/purchase-orders/${poId}/approve`, { method: "POST", token: supplierToken });
    check("non-admin approve → 403", nonAdminApprove.status === 403, `status ${nonAdminApprove.status}`);

    const approvePo = await api(`/purchase-orders/${poId}/approve`, { method: "POST", token });
    check("approve PO → approved", approvePo.status === 200 && approvePo.data?.status === "approved" && !!approvePo.data?.approved_by_name, `status ${approvePo.status}`);

    const beforeRecv = await query(`SELECT quantity_on_hand FROM inventory_items WHERE id = $1`, [itemId]);
    const recvPo = await api(`/purchase-orders/${poId}/receive`, { method: "POST", token });
    const afterRecv = await query(`SELECT quantity_on_hand FROM inventory_items WHERE id = $1`, [itemId]);
    check(
      "receive PO → received + stock incremented",
      recvPo.status === 200 &&
        recvPo.data?.status === "received" &&
        Number(afterRecv.rows[0]?.quantity_on_hand) === Number(beforeRecv.rows[0]?.quantity_on_hand) + 5,
      `status ${recvPo.status} qty=${afterRecv.rows[0]?.quantity_on_hand}`
    );
    const recvMovement = await query(
      `SELECT quantity_change FROM inventory_movements WHERE inventory_item_id = $1 AND reason LIKE 'PO % received' ORDER BY created_at DESC LIMIT 1`,
      [itemId]
    );
    check("receiving writes a restock movement", Number(recvMovement.rows[0]?.quantity_change) === 5, `movement=${recvMovement.rows[0]?.quantity_change}`);

    const priceHist = await api(`/inventory/${itemId}/price-history`, { token });
    check(
      "price history records received unit cost",
      priceHist.status === 200 && priceHist.data?.data?.some((p) => Number(p.unit_cost) === 150 && p.po_number === po.data?.po_number),
      `status ${priceHist.status} rows=${priceHist.data?.data?.length}`
    );

    const delDraft = await api("/purchase-orders", { method: "POST", token, body: {} });
    const delRes = await api(`/purchase-orders/${delDraft.data?.id}`, { method: "DELETE", token });
    check("delete draft PO → 204", delRes.status === 204, `status ${delRes.status}`);

    const cancelPo = await api("/purchase-orders", { method: "POST", token, body: {} });
    const cancelRes = await api(`/purchase-orders/${cancelPo.data?.id}/cancel`, { method: "POST", token });
    check("cancel PO → cancelled", cancelRes.status === 200 && cancelRes.data?.status === "cancelled", `status ${cancelRes.status}`);

    // --- Supplier contracts (roadmap row 3: suppliers, contracts, cost) ---
    const yearNow = new Date().getFullYear();
    const dateStr = (offsetDays) => {
      const d = new Date(Date.now() + offsetDays * 86400000);
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      return `${d.getUTCFullYear()}-${m}-${day}`;
    };
    const farEnd = `${yearNow + 3}-12-31`;
    const suffixOf = (n) => Number((/CTR-\d{4}-(\d+)/.exec(n ?? "") || [])[1] ?? 0);

    const badDates = await api("/contracts", { method: "POST", token, body: { contract_type: "service", start_date: dateStr(10), end_date: dateStr(0) } });
    check("contracts: end before start → 400", badDates.status === 400, `status ${badDates.status}`);
    const badSupplier = await api("/contracts", { method: "POST", token, body: { contract_type: "service", supplier_id: crypto.randomUUID() } });
    check("contracts: unknown supplier → 400", badSupplier.status === 400, `status ${badSupplier.status}`);
    const noType = await api("/contracts", { method: "POST", token, body: {} });
    check("contracts: missing contract_type → 400", noType.status === 400, `status ${noType.status}`);

    const c1 = await api("/contracts", {
      method: "POST", token,
      body: { contract_type: "service", supplier_id: supplierId, annual_value: 100000, end_date: farEnd },
    });
    check(
      "create contract → 201 + CTR number + active",
      c1.status === 201 && /^CTR-\d{4}-\d{4}$/.test(c1.data?.contract_number ?? "") && c1.data?.status === "active",
      `status ${c1.status} number=${c1.data?.contract_number}`
    );
    const c1Id = c1.data?.id;

    const c1Po = await api("/purchase-orders", {
      method: "POST", token,
      body: { supplier_id: supplierId, contract_id: c1Id, notes: "linked to contract", items: [{ item_id: itemId, quantity: 2, unit_cost: 500 }] },
    });
    check("contract-linked PO draft → 201 + contract_number", c1Po.status === 201 && c1Po.data?.contract_number === c1.data?.contract_number, `status ${c1Po.status}`);
    const c1Draft = await api(`/contracts/${c1Id}`, { token });
    check(
      "draft PO excluded from contract spend",
      c1Draft.status === 200 && Number(c1Draft.data?.po_spend) === 0 && c1Draft.data?.purchase_orders?.length === 1,
      `spend=${c1Draft.data?.po_spend} pos=${c1Draft.data?.purchase_orders?.length}`
    );

    await api(`/purchase-orders/${c1Po.data?.id}/submit`, { method: "POST", token });
    const c1After = await api(`/contracts/${c1Id}`, { token });
    check(
      "submitted PO counts toward contract spend",
      Number(c1After.data?.po_spend) === 1000 && Number(c1After.data?.po_count) === 1 && Number(c1After.data?.purchase_orders?.[0]?.po_total) === 1000,
      `spend=${c1After.data?.po_spend} count=${c1After.data?.po_count}`
    );

    const obOn = await api(`/contracts/${c1Id}`, { method: "PATCH", token, body: { annual_value: 500 } });
    check("contract over budget when spend > annual", obOn.status === 200 && obOn.data?.over_budget === true, `over=${obOn.data?.over_budget}`);
    const obOff = await api(`/contracts/${c1Id}`, { method: "PATCH", token, body: { annual_value: 200000 } });
    check("contract under budget again", obOff.status === 200 && obOff.data?.over_budget === false, `over=${obOff.data?.over_budget}`);

    const c2 = await api("/contracts", { method: "POST", token, body: { contract_type: "rental", end_date: farEnd } });
    check(
      "second contract number increments",
      c2.status === 201 && suffixOf(c2.data?.contract_number) === suffixOf(c1.data?.contract_number) + 1,
      `${c1.data?.contract_number} → ${c2.data?.contract_number}`
    );

    // Deterministic expiry transitions: park two contracts in the 'active'
    // stored state (as if the daily pass hasn't run), then drive /check-expiry.
    const c3 = await api("/contracts", { method: "POST", token, body: { contract_type: "service", end_date: dateStr(15) } });
    const c4 = await api("/contracts", { method: "POST", token, body: { contract_type: "utility", end_date: dateStr(-1) } });
    check("near-term + past-term contracts created", c3.status === 201 && c4.status === 201, `c3=${c3.status} c4=${c4.status}`);
    await query(`UPDATE contracts SET status = 'active' WHERE id = $1`, [c3.data?.id]);
    await query(`UPDATE contracts SET status = 'active' WHERE id = $1`, [c4.data?.id]);

    const recheck = await api("/contracts/check-expiry", { method: "POST", token });
    const c3After = await query(`SELECT status FROM contracts WHERE id = $1`, [c3.data?.id]);
    const c4After = await query(`SELECT status FROM contracts WHERE id = $1`, [c4.data?.id]);
    check(
      "check-expiry transitions + returns notified count",
      recheck.status === 200 && recheck.data?.checked === true && recheck.data?.notified >= 2 &&
        c3After.rows[0]?.status === "expiring" && c4After.rows[0]?.status === "expired",
      `notified=${recheck.data?.notified} c3=${c3After.rows[0]?.status} c4=${c4After.rows[0]?.status}`
    );

    const expiryNotes = await query(
      `SELECT type, count(*)::int AS n FROM notifications WHERE organization_id = $1 AND ref_type = 'contract' GROUP BY type`,
      [orgId]
    );
    const noteTypes = expiryNotes.rows.map((r) => r.type);
    check(
      "expiry notifications raised (expiring + expired)",
      noteTypes.includes("contract_expiring") && noteTypes.includes("contract_expired"),
      `types=${noteTypes.join(",")}`
    );

    const outbox = await query(
      `SELECT event, payload FROM event_outbox WHERE organization_id = $1 AND event IN ('contract.expiring','contract.expired')`,
      [orgId]
    );
    const expiringPayload = outbox.rows.find((r) => r.event === "contract.expiring")?.payload;
    check(
      "contract expiry events published to outbox",
      outbox.rows.some((r) => r.event === "contract.expiring") && outbox.rows.some((r) => r.event === "contract.expired") && JSON.stringify(expiringPayload).includes(c3.data?.contract_number),
      `events=${outbox.rows.map((r) => r.event).join(",")}`
    );

    const recheck2 = await api("/contracts/check-expiry", { method: "POST", token });
    check("second check-expiry → no new notifications", recheck2.data?.notified === 0, `notified=${recheck2.data?.notified}`);

    const expiringList = await api("/contracts?status=expiring", { token });
    const expiredList = await api("/contracts?status=expired", { token });
    check(
      "list filters: expiring + expired",
      expiringList.data?.data?.some((c) => c.id === c3.data?.id) && !expiringList.data?.data?.some((c) => c.id === c1Id) &&
        expiredList.data?.data?.some((c) => c.id === c4.data?.id),
      `expiring=${expiringList.data?.data?.length} expired=${expiredList.data?.data?.length}`
    );

    const bySupplier = await api(`/contracts?supplier_id=${supplierId}`, { token });
    check(
      "list filter: by supplier",
      bySupplier.data?.data?.length === 1 && bySupplier.data?.data?.[0]?.id === c1Id && bySupplier.data?.data?.[0]?.supplier_name === "Test Plumbing Co",
      `n=${bySupplier.data?.data?.length}`
    );

    // Role gating: technicians cannot create or trigger expiry passes; a manager can.
    const ctrTech = await api("/users", { method: "POST", token, body: { full_name: "E2E Contracts Tech", email: `ctrtech-${run}@test.co`, password: "facilix-demo", role: "technician" } });
    const ctrTechToken = (await api("/auth/login", { method: "POST", body: { email: `ctrtech-${run}@test.co`, password: "facilix-demo" } })).data?.token;
    const ctrManager = await api("/users", { method: "POST", token, body: { full_name: "E2E Contracts Mgr", email: `ctrmgr-${run}@test.co`, password: "facilix-demo", role: "manager" } });
    const ctrMgrToken = (await api("/auth/login", { method: "POST", body: { email: `ctrmgr-${run}@test.co`, password: "facilix-demo" } })).data?.token;
    const techCreate = await api("/contracts", { method: "POST", token: ctrTechToken, body: { contract_type: "service", end_date: farEnd } });
    const techCheck = await api("/contracts/check-expiry", { method: "POST", token: ctrTechToken });
    const supCreate = await api("/contracts", { method: "POST", token: supplierToken, body: { contract_type: "service", end_date: farEnd } });
    const mgrCreate = await api("/contracts", { method: "POST", token: ctrMgrToken, body: { contract_type: "rental", end_date: farEnd } });
    check(
      "contracts role gating (technician 403, supplier 403, manager 201)",
      techCreate.status === 403 && techCheck.status === 403 && supCreate.status === 403 && mgrCreate.status === 201,
      `tech=${techCreate.status}/${techCheck.status} supplier=${supCreate.status} manager=${mgrCreate.status}`
    );
    await api(`/users/${ctrTech.data?.id}`, { method: "DELETE", token });
    await api(`/users/${ctrManager.data?.id}`, { method: "DELETE", token });

    // Cross-org isolation
    const ctrCross = await api("/auth/signup", {
      method: "POST",
      body: { orgName: `E2E Contracts Org ${run}`, fullName: "Cross Tester", email: `ctrcross-${run}@test.local`, password: "password-123" },
    });
    const ctrCrossOrg = ctrCross.data?.user?.organization_id;
    const crossRead = await api(`/contracts/${c1Id}`, { token: ctrCross.data?.token });
    const crossTerm = await api(`/contracts/${c1Id}/terminate`, { method: "POST", token: ctrCross.data?.token });
    check(
      "contracts cross-org isolated (read 404, terminate 400)",
      crossRead.status === 404 && crossTerm.status === 400,
      `read=${crossRead.status} terminate=${crossTerm.status}`
    );
    await query(`DELETE FROM organizations WHERE id = $1`, [ctrCrossOrg]).catch(() => {});

    // Terminate lifecycle
    const term = await api(`/contracts/${c2.data?.id}/terminate`, { method: "POST", token });
    check("terminate contract → 200 terminated", term.status === 200 && term.data?.status === "terminated", `status ${term.status}`);
    const termAgain = await api(`/contracts/${c2.data?.id}/terminate`, { method: "POST", token });
    check("terminate again → 400", termAgain.status === 400, `status ${termAgain.status}`);
    const editTerm = await api(`/contracts/${c2.data?.id}`, { method: "PATCH", token, body: { notes: "nope" } });
    check("edit terminated contract → 400", editTerm.status === 400, `status ${editTerm.status}`);

    // 12. Compliance & safety: permit-to-work gate + registries (Phase 11)
    const permitWo = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "electrical", title: "E2E permit work", source: "breakdown", requires_permit: true },
    });
    check("permits-required WO → 201", permitWo.status === 201 && permitWo.data?.requires_permit === true, `status ${permitWo.status}`);
    const permitWoId = permitWo.data?.id;

    const gateClose = await api(`/work-orders/${permitWoId}`, {
      method: "PATCH",
      token,
      body: { status: "done", failure_code: "wear_and_tear", root_cause: "Expected service interval reached", remedy: "Serviced per schedule" },
    });
    check("closeout without issued permit → 400", gateClose.status === 400 && /permit/.test(gateClose.data.error || ""), `status ${gateClose.status}`);

    const permit = await api("/compliance/permits", {
      method: "POST",
      token,
      body: { work_order_id: permitWoId, type: "electrical_isolation", notes: "E2E permit" },
    });
    check("create permit (draft) → 201", permit.status === 201 && permit.data?.status === "draft", `status ${permit.status}`);
    const permitId = permit.data?.id;

    const issuePermit = await api(`/compliance/permits/${permitId}`, { method: "PATCH", token, body: { status: "issued" } });
    check(
      "issue permit → issued + stamped",
      issuePermit.status === 200 && issuePermit.data?.status === "issued" && !!issuePermit.data?.issued_at && !!issuePermit.data?.issued_by,
      `status ${issuePermit.status}`
    );

    const permitClose = await api(`/work-orders/${permitWoId}`, {
      method: "PATCH",
      token,
      body: { status: "done", failure_code: "wear_and_tear", root_cause: "Expected service interval reached", remedy: "Serviced per schedule" },
    });
    check("closeout with issued permit → 200", permitClose.status === 200 && permitClose.data?.status === "done", `status ${permitClose.status}`);

    const summary = await api("/compliance/summary", { token });
    check(
      "summary counts open permits",
      summary.status === 200 && Number(summary.data?.open_permits) >= 1,
      `status ${summary.status} open_permits=${summary.data?.open_permits}`
    );

    const expiredComp = await api("/compliance/competencies", {
      method: "POST",
      token,
      body: { user_id: userId, name: "E2E expired cert", trade: "electrical", expires_at: new Date(Date.now() - 86400000).toISOString() },
    });
    check("create competency → 201", expiredComp.status === 201, `status ${expiredComp.status}`);

    const comps = await api("/compliance/competencies?user_id=" + userId, { token });
    const expiredRow = comps.data?.data?.find((c) => c.name === "E2E expired cert");
    check("expired competency flagged", comps.status === 200 && expiredRow?.expired === true, `status ${comps.status} expired=${expiredRow?.expired}`);

    const insp = await api("/compliance/inspections", {
      method: "POST",
      token,
      body: { requirement: "E2E fire check", frequency_days: 30, due_date: new Date(Date.now() - 86400000).toISOString() },
    });
    check("create inspection → 201", insp.status === 201, `status ${insp.status}`);
    const inspId = insp.data?.id;

    const inspList = await api("/compliance/inspections", { token });
    const inspRow = inspList.data?.data?.find((i) => i.id === inspId);
    check("overdue inspection flagged", inspList.status === 200 && inspRow?.overdue === true, `status ${inspList.status} overdue=${inspRow?.overdue}`);

    const markInsp = await api(`/compliance/inspections/${inspId}`, { method: "PATCH", token, body: {} });
    check(
      "marking inspection done rolls due date",
      markInsp.status === 200 && !!markInsp.data?.last_done_at && new Date(markInsp.data?.due_date).getTime() > Date.now(),
      `status ${markInsp.status} due=${markInsp.data?.due_date}`
    );

    // 13. Properties endpoints work without PostGIS (geom gracefully null)
    const prop = await api("/properties", { method: "POST", token, body: { name: `E2E Lot ${run}`, address: "1 Test St", lat: 40.1, lng: -74.5 } });
    check("POST /properties (no PostGIS) → 201", prop.status === 201, `status ${prop.status}`);
    const props = await api("/properties", { token });
    check("GET /properties → geom null without PostGIS", props.data?.data?.[0]?.geom == null, "geom present or missing gracefully");

    // 13. Self-service report export (Phase 6) — JSON + CSV
    const jsonReport = await api("/reports/work-orders", { token });
    check("GET /reports/work-orders → JSON with columns+rows", jsonReport.status === 200 && Array.isArray(jsonReport.data.columns) && Array.isArray(jsonReport.data.rows), `status ${jsonReport.status}`);

    const csvRes = await fetch(`${BASE}/reports/work-orders?format=csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const csvText = await csvRes.text();
    check(
      "GET /reports/work-orders?format=csv → text/csv with header",
      csvRes.headers.get("content-type")?.includes("text/csv") &&
        csvText.startsWith("id,title,trade,priority,status,source,asset,cost,due_date,failure_code,created_at,completed_at"),
      `ct=${csvRes.headers.get("content-type")}`
    );

    // 14. Condition-based maintenance: ingestion, monotonicity, threshold
    //     recommendations, alerts, and trends (Phase 14)
    const meterAsset = await api("/assets", {
      method: "POST",
      token,
      body: { name: `E2E Meter ${run}`, type: "hvac", meter_value: 100, meter_unit: "hours" },
    });
    check("metered asset → 201", meterAsset.status === 201 && meterAsset.data?.id, `status ${meterAsset.status}`);
    const meterAssetId = meterAsset.data?.id;

    const ingest = await api(`/assets/${meterAssetId}/readings`, {
      method: "POST",
      token,
      body: { reading_value: 150, reading_unit: "hours" },
    });
    check("record reading → 201 + asset refreshed", ingest.status === 201 && Number(ingest.data?.reading?.reading_value) === 150, `status ${ingest.status}`);

    const mono = await api(`/assets/${meterAssetId}/readings`, {
      method: "POST",
      token,
      body: { reading_value: 120 },
    });
    check("lower reading rejected (monotonic)", mono.status === 400 && /monotonic/.test(mono.data?.error || ""), `status ${mono.status}`);

    const plan = await api("/maintenance-plans", {
      method: "POST",
      token,
      body: { name: "E2E meter overhaul", asset_id: meterAssetId, trigger: "meter_based", meter_threshold: 200 },
    });
    check("meter-based plan → 201", plan.status === 201 && plan.data?.meter_threshold === "200", `status ${plan.status}`);

    const cross = await api(`/assets/${meterAssetId}/readings`, {
      method: "POST",
      token,
      body: { reading_value: 210, reading_unit: "hours" },
    });
    check(
      "threshold crossing recommends a work order",
      cross.status === 201 && cross.data?.work_orders?.length === 1 && /meter_threshold/.test(cross.data.work_orders[0].description || ""),
      `status ${cross.status} wos=${cross.data?.work_orders?.length}`
    );

    const alerts = await api("/meter-readings/alerts", { token });
    check(
      "alerts include breached asset",
      alerts.status === 200 && alerts.data?.data?.some((a) => a.asset_id === meterAssetId && a.status === "breached"),
      `status ${alerts.status}`
    );

    const trend = await api(`/meter-readings/assets/${meterAssetId}/trend`, { token });
    const reached = trend.data?.thresholds?.find((t) => t.plan_id === plan.data?.id);
    check(
      "trend returns readings + reached threshold",
      trend.status === 200 && Array.isArray(trend.data?.readings) && trend.data.readings.length >= 2 && reached?.reached === true,
      `status ${trend.status} readings=${trend.data?.readings?.length}`
    );

    // Staff management — admins create accounts that can immediately log in.
    const techUser = await api("/users", {
      method: "POST",
      token,
      body: { full_name: "E2E Tech", email: `tech-${run}@test.co`, password: "facilix-demo", role: "technician", trade: "plumbing" },
    });
    check("POST /users technician → 201", techUser.status === 201 && techUser.data?.role === "technician", `status ${techUser.status}`);

    const techLogin = await api("/auth/login", { method: "POST", body: { email: `tech-${run}@test.co`, password: "facilix-demo" } });
    check("new technician can log in → 200", techLogin.status === 200 && techLogin.data?.user?.role === "technician", `status ${techLogin.status}`);

    const mgrUser = await api("/users", {
      method: "POST",
      token,
      body: { full_name: "E2E Manager", email: `mgr-${run}@test.co`, password: "facilix-demo", role: "manager" },
    });
    check("POST /users manager → 201", mgrUser.status === 201, `status ${mgrUser.status}`);

    const mgrLogin = await api("/auth/login", { method: "POST", body: { email: `mgr-${run}@test.co`, password: "facilix-demo" } });
    const mgrMakesAdmin = await api("/users", {
      method: "POST",
      token: mgrLogin.data?.token,
      body: { full_name: "X", email: `x-${run}@test.co`, password: "facilix-demo", role: "admin" },
    });
    check("manager cannot create admin → 403", mgrMakesAdmin.status === 403, `status ${mgrMakesAdmin.status}`);

    // Deactivation — admin removes staff (soft), last-admin and self-protected.
    const deactUser = await api(`/users/${techUser.data?.id}`, { method: "PATCH", token, body: { active: false } });
    check("deactivate technician → 200 inactive", deactUser.status === 200 && deactUser.data?.active === false, `status ${deactUser.status}`);

    const techLogin2 = await api("/auth/login", { method: "POST", body: { email: `tech-${run}@test.co`, password: "facilix-demo" } });
    check("deactivated tech cannot log in → 401", techLogin2.status === 401, `status ${techLogin2.status}`);

    const restore = await api(`/users/${techUser.data?.id}`, { method: "PATCH", token, body: { active: true } });
    check("restore technician → 200 active", restore.status === 200 && restore.data?.active === true, `status ${restore.status}`);

    const selfDeact = await api(`/users/${userId}`, { method: "PATCH", token, body: { active: false } });
    check("admin cannot deactivate self → 400", selfDeact.status === 400, `status ${selfDeact.status}`);

    // Permanent removal — account gone, historical links preserved (NULLed).
    const fkWo = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "plumbing", title: "FK-safety deletion", source: "breakdown", priority: "normal" },
    });
    const fkAssigned = await api(`/work-orders/${fkWo.data?.id}`, { method: "PATCH", token, body: { assigned_user_id: techUser.data?.id } });
    check("assign WO to tech (pre-delete)", fkAssigned.status === 200, `status ${fkAssigned.status}`);

    const permDel = await api(`/users/${techUser.data?.id}`, { method: "DELETE", token });
    check("permanently delete technician → 204", permDel.status === 204, `status ${permDel.status}`);

    const roster = await api("/users", { token });
    check("deleted tech gone from roster", roster.status === 200 && !roster.data.data.some((u) => u.id === techUser.data?.id), "still listed");

    const techLogin3 = await api("/auth/login", { method: "POST", body: { email: `tech-${run}@test.co`, password: "facilix-demo" } });
    check("deleted tech cannot log in → 401", techLogin3.status === 401, `status ${techLogin3.status}`);

    const woList = await api("/work-orders", { token });
    const fkWoRow = woList.data?.data?.find((w) => w.id === fkWo.data?.id);
    check("WO survives with assignee nulled", !!fkWoRow && fkWoRow.assigned_user_id === null, `assigned=${fkWoRow?.assigned_user_id}`);

    const selfDel = await api(`/users/${userId}`, { method: "DELETE", token });
    check("admin cannot delete self → 400", selfDel.status === 400, `status ${selfDel.status}`);

    // ============================================================
    // Phase 4 — tenant self-service portal (login, request, tracking scope).
    // ============================================================
    const tenantUser = await api("/users", {
      method: "POST",
      token,
      body: { full_name: "E2E Tenant", email: `tenant-${run}@test.co`, password: "facilix-demo", role: "tenant" },
    });
    check("POST /users tenant → 201", tenantUser.status === 201 && tenantUser.data?.role === "tenant", `status ${tenantUser.status}`);

    const roster4 = await api("/users", { token });
    check("tenant appears in roster", roster4.status === 200 && roster4.data.data.some((u) => u.id === tenantUser.data?.id), "not listed");

    const tenantLogin = await api("/auth/login", { method: "POST", body: { email: `tenant-${run}@test.co`, password: "facilix-demo" } });
    check("tenant can log in → 200", tenantLogin.status === 200 && tenantLogin.data?.user?.role === "tenant", `status ${tenantLogin.status}`);
    const tenantToken = tenantLogin.data?.token;

    const otherWo = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "plumbing", title: "Admin breakdown not mine", source: "breakdown", priority: "normal" },
    });
    check("admin opens a non-tenant WO", otherWo.status === 201, `status ${otherWo.status}`);

    const tenantWo = await api("/work-orders", {
      method: "POST",
      token: tenantToken,
      body: { trade: "electrical", title: "My flickering light", source: "breakdown", priority: "normal", reported_by_user_id: userId },
    });
    check(
      "tenant POST forced tenant_request + self-reported",
      tenantWo.status === 201 && tenantWo.data?.source === "tenant_request" && tenantWo.data?.reported_by_user_id === tenantUser.data?.id,
      `src=${tenantWo.data?.source} reporter=${tenantWo.data?.reported_by_user_id}`
    );

    const tenantList = await api("/work-orders", { token: tenantToken });
    const ids = (tenantList.data?.data ?? []).map((w) => w.id);
    check(
      "tenant sees own request only (not admin's)",
      tenantList.status === 200 && ids.includes(tenantWo.data?.id) && !ids.includes(otherWo.data?.id),
      `count=${ids.length}`
    );

    const tenantPatch = await api(`/work-orders/${tenantWo.data?.id}`, { method: "PATCH", token: tenantToken, body: { status: "assigned" } });
    check("tenant cannot advance work order → 403", tenantPatch.status === 403, `status ${tenantPatch.status}`);

    const adminSeesTenantWo = await api("/work-orders", { token });
    check("admin sees the tenant request in full list", adminSeesTenantWo.status === 200 && adminSeesTenantWo.data.data.some((w) => w.id === tenantWo.data?.id), "missing");

    // Tenant withdrawal — cancelling your own request while it's still open.
    const withdrawn = await api(`/work-orders/${tenantWo.data?.id}`, {
      method: "PATCH",
      token: tenantToken,
      body: { status: "cancelled", cancellation_reason: "Tenant resolved it themselves" },
    });
    check(
      "tenant can withdraw own open request → 200 audited",
      withdrawn.status === 200 &&
        withdrawn.data?.status === "cancelled" &&
        withdrawn.data?.cancelled_by_user_id === tenantUser.data?.id &&
        !!withdrawn.data?.cancelled_at &&
        withdrawn.data?.cancellation_reason === "Tenant resolved it themselves",
      `status ${withdrawn.status} by=${withdrawn.data?.cancelled_by_user_id}`
    );

    const withdrawAgain = await api(`/work-orders/${tenantWo.data?.id}`, {
      method: "PATCH",
      token: tenantToken,
      body: { status: "cancelled", cancellation_reason: "already gone" },
    });
    check("withdraw a withdrawn request → 400", withdrawAgain.status === 400, `status ${withdrawAgain.status}`);

    const tenantCancelsOther = await api(`/work-orders/${otherWo.data?.id}`, {
      method: "PATCH",
      token: tenantToken,
      body: { status: "cancelled", cancellation_reason: "not mine" },
    });
    check("tenant cannot cancel staff's breakdown WO → 403", tenantCancelsOther.status === 403, `status ${tenantCancelsOther.status}`);

    const withdrawnStaffNotif = await query(
      `SELECT count(*)::int AS n FROM notifications n
       JOIN users u ON u.id = n.user_id
       WHERE n.organization_id = $1 AND n.type = 'work_order_withdrawn' AND u.role IN ('admin','manager')`,
      [orgId]
    );
    check("withdraw notifies staff", withdrawnStaffNotif.rows[0].n >= 1, `n=${withdrawnStaffNotif.rows[0].n}`);

    // --- Phase 4 extensions: AI triage, device location, and media evidence. ---
    const triage = await api("/triage", {
      method: "POST",
      token: tenantToken,
      body: { title: "Bathroom tap won't stop dripping", description: "Water leaking from the tap under the kitchen sink" },
    });
    check(
      "triage suggests plumbing + high for a dripping tap",
      triage.status === 200 &&
        triage.data?.suggestion?.trade === "plumbing" &&
        ["high", "urgent"].includes(triage.data?.suggestion?.priority) &&
        triage.data?.suggestion?.confidence > 0.5,
      `trade=${triage.data?.suggestion?.trade} pri=${triage.data?.suggestion?.priority} conf=${triage.data?.suggestion?.confidence}`
    );

    const triageUnknown = await api("/triage", {
      method: "POST",
      token: tenantToken,
      body: { title: "Organise a rooftop barbecue for residents" },
    });
    check(
      "triage returns nulls when nothing matches",
      triageUnknown.status === 200 && triageUnknown.data?.suggestion?.trade === null && triageUnknown.data?.suggestion?.priority === null,
      `trade=${triageUnknown.data?.suggestion?.trade}`
    );

    const triageEmpty = await api("/triage", { method: "POST", token: tenantToken, body: {} });
    check("triage with no text → null suggestion (200)", triageEmpty.status === 200 && triageEmpty.data?.suggestion?.trade === null, `status ${triageEmpty.status}`);

    const triageAnon = await api("/triage", { method: "POST", body: { title: "leak" } });
    check("triage without auth → 401", triageAnon.status === 401, `status ${triageAnon.status}`);

    const locWo = await api("/work-orders", {
      method: "POST",
      token: tenantToken,
      body: { trade: "plumbing", title: "Geotagged puddle in the lobby", source: "tenant_request", latitude: -1.2921, longitude: 36.8219 },
    });
    check(
      "tenant WO carries device location",
      locWo.status === 201 && Number(locWo.data?.latitude) === -1.2921 && Number(locWo.data?.longitude) === 36.8219,
      `lat=${locWo.data?.latitude} lng=${locWo.data?.longitude}`
    );

    const locBad = await api("/work-orders", {
      method: "POST",
      token: tenantToken,
      body: { trade: "plumbing", title: "Out of range latitude", source: "tenant_request", latitude: 91, longitude: 0 },
    });
    check("out-of-range latitude → 400", locBad.status === 400, `status ${locBad.status}`);

    const evForm = new FormData();
    evForm.append("entity_type", "work_order");
    evForm.append("entity_id", locWo.data?.id);
    evForm.append("file", new Blob([Buffer.from(`tenant-photo-${run}`)], { type: "image/jpeg" }), "puddle-photo.jpg");
    const evRes = await fetch(`${BASE}/documents`, { method: "POST", headers: { Authorization: `Bearer ${tenantToken}` }, body: evForm });
    const evData = await evRes.json();
    check("tenant evidence upload → 201", evRes.status === 201 && !!evData?.data?.id, `status ${evRes.status}`);

    const locList = await api("/work-orders", { token: tenantToken });
    const locRow = locList.data?.data?.find((w) => w.id === locWo.data?.id);
    check(
      "tenant list exposes document_count + location",
      locList.status === 200 && Number(locRow?.document_count) === 1 && locRow?.latitude != null && locRow?.longitude != null,
      `docs=${locRow?.document_count}`
    );

    const deleteTenant = await api(`/users/${tenantUser.data?.id}`, { method: "DELETE", token });
    check("cleanup: delete tenant → 204", deleteTenant.status === 204, `status ${deleteTenant.status}`);

    // ============================================================
    // Phase 2 — preventive-maintenance scheduler. Plans spawn plan-sourced
    // work orders when run; the no-pile-up guard stops re-spawning while a
    // generated order is still in flight; cadence/active toggles and the
    // bulk due-run complete the cycle.
    // ============================================================
    const pmAsset = await api("/assets", {
      method: "POST",
      token,
      body: { name: `E2E Pump ${run}`, type: "plumbing", meter_value: 100, meter_unit: "hours" },
    });
    check("pm asset → 201", pmAsset.status === 201 && pmAsset.data?.id, `status ${pmAsset.status}`);

    const pmPlan = await api("/maintenance-plans", {
      method: "POST",
      token,
      body: { name: "E2E quarterly service", asset_id: pmAsset.data.id, trigger: "scheduled", frequency_days: 30, checklist: [{ step: "Inspect seals" }, { step: "Grease bearings" }] },
    });
    check("scheduled plan → 201", pmPlan.status === 201 && pmPlan.data?.frequency_days === 30, `status ${pmPlan.status}`);
    const pmPlanId = pmPlan.data?.id;

    const run1 = await api(`/maintenance-plans/${pmPlanId}/run`, { method: "POST", token });
    const pmWoId = (await api("/work-orders", { token })).data?.data?.find((w) => w.maintenance_plan_id === pmPlanId)?.id;
    check(
      "run plan → spawned 1 plan-sourced WO",
      run1.status === 200 && Number(run1.data?.spawned) === 1 && !!pmWoId,
      `spawned=${run1.data?.spawned} wo=${pmWoId}`
    );
    const pmWo = (await api("/work-orders", { token })).data?.data?.find((w) => w.id === pmWoId);
    check("generated WO is plan-sourced + linked", pmWo?.source === "plan" && pmWo?.maintenance_plan_id === pmPlanId, `src=${pmWo?.source} link=${pmWo?.maintenance_plan_id}`);

    const run2 = await api(`/maintenance-plans/${pmPlanId}/run`, { method: "POST", token });
    check("run again while in flight → spawned 0 (no pile-up)", run2.status === 200 && Number(run2.data?.spawned) === 0, `spawned=${run2.data?.spawned}`);

    const closePm = await api(`/work-orders/${pmWoId}`, {
      method: "PATCH",
      token,
      body: { status: "done", failure_code: "wear_and_tear", root_cause: "End of interval", remedy: "Full service performed" },
    });
    check("close generated WO → 200", closePm.status === 200, `status ${closePm.status}`);

    const run3 = await api(`/maintenance-plans/${pmPlanId}/run`, { method: "POST", token });
    check("run again after completion → spawned 1", run3.status === 200 && Number(run3.data?.spawned) === 1, `spawned=${run3.data?.spawned}`);

    const pause = await api(`/maintenance-plans/${pmPlanId}`, { method: "PATCH", token, body: { active: false } });
    check("pause plan → 200", pause.status === 200 && pause.data?.active === false, `status ${pause.status}`);

    const runPaused = await api(`/maintenance-plans/${pmPlanId}/run`, { method: "POST", token });
    check("paused plan runs nothing → spawned 0", runPaused.status === 200 && Number(runPaused.data?.spawned) === 0, `spawned=${runPaused.data?.spawned}`);

    const resume = await api(`/maintenance-plans/${pmPlanId}`, { method: "PATCH", token, body: { active: true } });
    check("resume plan → 200 active", resume.status === 200 && resume.data?.active === true, `status ${resume.status}`);

    const plansList = await api("/maintenance-plans", { token });
    const planRow = plansList.data?.data?.find((p) => p.id === pmPlanId);
    check(
      "list exposes next_run_at/due/open_work_orders",
      plansList.status === 200 && planRow && planRow.next_run_at != null && typeof planRow.due === "boolean" && typeof planRow.open_work_orders === "number",
      `due=${planRow?.due} open=${planRow?.open_work_orders}`
    );

    // Technician cannot manage plans (admin/manager only).
    const pmTech = await api("/users", {
      method: "POST",
      token,
      body: { full_name: "E2E PM Tech", email: `pmtech-${run}@test.co`, password: "facilix-demo", role: "technician", trade: "plumbing" },
    });
    const techToken2 = (await api("/auth/login", { method: "POST", body: { email: `pmtech-${run}@test.co`, password: "facilix-demo" } })).data?.token;
    const pmForbidden = await api(`/maintenance-plans/${pmPlanId}/run`, { method: "POST", token: techToken2 });
    check("technician cannot run plans → 403", pmForbidden.status === 403, `status ${pmForbidden.status}`);
    await api(`/users/${pmTech.data?.id}`, { method: "DELETE", token });

    // Bulk due-run: a fresh never-run plan (last_run_at NULL) is due and its
    // asset has no in-flight order, so it must produce exactly one WO.
    const bulkPlan = await api("/maintenance-plans", {
      method: "POST",
      token,
      body: { name: "E2E bulk plan", asset_id: asset.data.id, trigger: "scheduled", frequency_days: 60 },
    });
    const bulkRun = await api("/maintenance-plans/run", { method: "POST", token });
    const bulkWo = (await api("/work-orders", { token })).data?.data?.find((w) => w.maintenance_plan_id === bulkPlan.data?.id);
    check(
      "bulk due run generates for the due plan",
      bulkRun.status === 200 && Number(bulkRun.data?.generated) >= 1 && !!bulkWo,
      `generated=${bulkRun.data?.generated} bulkWo=${bulkWo?.id}`
    );

    const delBulk = await api(`/maintenance-plans/${bulkPlan.data?.id}`, { method: "DELETE", token });
    check("delete bulk plan → 204", delBulk.status === 204, `status ${delBulk.status}`);

    const delPlan = await api(`/maintenance-plans/${pmPlanId}`, { method: "DELETE", token });
    check("delete plan → 204", delPlan.status === 204, `status ${delPlan.status}`);

    const afterDel = await api("/maintenance-plans", { token });
    check("plan gone from list", afterDel.status === 200 && !afterDel.data.data.some((p) => p.id === pmPlanId), "still listed");

    // ============================================================
    // Cancellation discipline — admin/manager only, reason required, audited,
    // terminal, and surfaced as a work_order.cancelled event.
    // ============================================================
    const cancelTech = await api("/users", {
      method: "POST",
      token,
      body: { full_name: "E2E Cancel Tech", email: `canceltech-${run}@test.co`, password: "facilix-demo", role: "technician", trade: "plumbing" },
    });
    const cancelTechLogin = await api("/auth/login", { method: "POST", body: { email: `canceltech-${run}@test.co`, password: "facilix-demo" } });
    check("cancel: technician login → 200", cancelTechLogin.status === 200, `status ${cancelTechLogin.status}`);
    const cancelTechToken = cancelTechLogin.data?.token;

    const cancelWo = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "plumbing", title: "Cancel discipline WO", source: "breakdown", priority: "normal" },
    });
    check("cancel: WO created → 201", cancelWo.status === 201, `status ${cancelWo.status}`);

    const techCancel = await api(`/work-orders/${cancelWo.data?.id}`, {
      method: "PATCH",
      token: cancelTechToken,
      body: { status: "cancelled", cancellation_reason: "Technician decided to stop" },
    });
    check("cancel: technician blocked → 403", techCancel.status === 403, `status ${techCancel.status}`);

    const noReason = await api(`/work-orders/${cancelWo.data?.id}`, {
      method: "PATCH",
      token,
      body: { status: "cancelled" },
    });
    check("cancel: no reason rejected → 400", noReason.status === 400, `status ${noReason.status}`);

    const vagueReason = await api(`/work-orders/${cancelWo.data?.id}`, {
      method: "PATCH",
      token,
      body: { status: "cancelled", cancellation_reason: "n/a" },
    });
    check("cancel: vague reason rejected → 400", vagueReason.status === 400, `status ${vagueReason.status}`);

    const doCancel = await api(`/work-orders/${cancelWo.data?.id}`, {
      method: "PATCH",
      token,
      body: { status: "cancelled", cancellation_reason: "Duplicate request — superseded by WO-C41" },
    });
    check(
      "cancel: audited stamp (by/at/reason)",
      doCancel.status === 200 &&
        doCancel.data?.status === "cancelled" &&
        doCancel.data?.cancelled_by_user_id === userId &&
        !!doCancel.data?.cancelled_at &&
        doCancel.data?.cancellation_reason === "Duplicate request — superseded by WO-C41",
      `status ${doCancel.status} by=${doCancel.data?.cancelled_by_user_id}`
    );

    const cancelledList = await api("/work-orders?status=cancelled", { token });
    const cancelledRow = cancelledList.data?.data?.find((w) => w.id === cancelWo.data?.id);
    check(
      "cancel: listed with canceller name + reason",
      cancelledList.status === 200 &&
        !!cancelledRow &&
        cancelledRow.cancelled_by_name === signup.data?.user?.full_name &&
        !!cancelledRow.cancelled_at,
      `by=${cancelledRow?.cancelled_by_name}`
    );

    const advanceCancelled = await api(`/work-orders/${cancelWo.data?.id}`, {
      method: "PATCH",
      token,
      body: { status: "assigned" },
    });
    check("cancel: terminal state frozen → 400", advanceCancelled.status === 400, `status ${advanceCancelled.status}`);

    const cancelEvent = await query(
      `SELECT count(*)::int AS n FROM event_outbox WHERE organization_id = $1 AND event = 'work_order.cancelled'`,
      [orgId]
    );
    check("cancel: work_order.cancelled in outbox", cancelEvent.rows[0].n >= 1, `n=${cancelEvent.rows[0].n}`);

    const dict2 = await api("/integrations/data-dictionary");
    check(
      "cancel: event in public catalog",
      dict2.status === 200 && dict2.data?.events?.catalog?.some((e) => e.name === "work_order.cancelled"),
      `status ${dict2.status}`
    );

    // ============================================================
    // Archive & purge — soft "clear" (undoable) then permanent delete.
    // ============================================================
    const techArchive = await api(`/work-orders/${cancelWo.data?.id}`, {
      method: "PATCH",
      token: cancelTechToken,
      body: { archive: true },
    });
    check("archive: technician blocked → 403", techArchive.status === 403, `status ${techArchive.status}`);

    const bulkCancel = await api("/work-orders/archive", { method: "POST", token, body: { status: "cancelled" } });
    check("archive: bulk cancelled → archived >= 1", bulkCancel.status === 200 && Number(bulkCancel.data?.archived) >= 1, JSON.stringify(bulkCancel.data));

    const bulkDone = await api("/work-orders/archive", { method: "POST", token, body: { status: "done" } });
    check("archive: bulk done → archived >= 1", bulkDone.status === 200 && Number(bulkDone.data?.archived) >= 1, JSON.stringify(bulkDone.data));

    const normalCancel = await api("/work-orders?status=cancelled", { token });
    check("archive: hidden from default list", normalCancel.status === 200 && !normalCancel.data.data.some((w) => w.id === cancelWo.data?.id), "still visible");

    const archivedList = await api("/work-orders?status=cancelled&archived=1", { token });
    const archivedRow = archivedList.data?.data?.find((w) => w.id === cancelWo.data?.id);
    check("archive: visible with archived=1", archivedList.status === 200 && !!archivedRow?.archived_at, `at=${archivedRow?.archived_at}`);

    const restoreWo = await api(`/work-orders/${cancelWo.data?.id}`, { method: "PATCH", token, body: { archive: false } });
    check("archive: restore → archived_at null", restoreWo.status === 200 && restoreWo.data?.archived_at === null, `at=${restoreWo.data?.archived_at}`);

    const afterRestore = await api("/work-orders?status=cancelled", { token });
    check("archive: restored appears again", afterRestore.status === 200 && afterRestore.data.data.some((w) => w.id === cancelWo.data?.id), "missing");

    const delNotArchived = await api(`/work-orders/${cancelWo.data?.id}`, { method: "DELETE", token });
    check("archive: delete requires archived first → 400", delNotArchived.status === 400, `status ${delNotArchived.status}`);

    const techDelete = await api(`/work-orders/${cancelWo.data?.id}`, { method: "DELETE", token: cancelTechToken });
    check("archive: technician cannot delete → 403", techDelete.status === 403, `status ${techDelete.status}`);

    const reArchive = await api(`/work-orders/${cancelWo.data?.id}`, { method: "PATCH", token, body: { archive: true } });
    check("archive: re-archive → 200", reArchive.status === 200 && !!reArchive.data?.archived_at, `status ${reArchive.status}`);

    const purge = await api(`/work-orders/${cancelWo.data?.id}`, { method: "DELETE", token });
    check("archive: permanent delete archived → 204", purge.status === 204, `status ${purge.status}`);

    const gone = await api("/work-orders?status=cancelled&archived=1", { token });
    check("archive: deleted gone everywhere", gone.status === 200 && !gone.data.data.some((w) => w.id === cancelWo.data?.id), "still present");

    await api(`/users/${cancelTech.data?.id}`, { method: "DELETE", token });

    // ============================================================
    // Phase 5 — GIS: portable lat/lng on properties + spatial aggregates
    // ============================================================
    const gisProp = await api("/properties", { method: "POST", token, body: { name: `E2E GIS ${run}`, address: "2 Map St", lat: -1.3, lng: 36.8 } });
    check("POST /properties with coords → 201 + persisted", gisProp.status === 201 && gisProp.data?.latitude === "-1.3" && gisProp.data?.longitude === "36.8", `status ${gisProp.status} lat=${gisProp.data?.latitude}`);
    const gisPropId = gisProp.data?.id;

    const badLat = await api("/properties", { method: "POST", token, body: { name: "E2E Bad", lat: 95, lng: 0 } });
    check("invalid latitude rejected → 400", badLat.status === 400, `status ${badLat.status}`);

    const gisList = await api("/properties", { token });
    const gisRow = gisList.data?.data?.find((p) => p.id === gisPropId);
    check(
      "GET /properties → lat/lng + aggregates",
      gisList.status === 200 && gisRow && typeof gisRow.buildings_count === "number" && typeof gisRow.open_work_orders === "number" && gisRow.latitude === "-1.3",
      `status ${gisList.status} lat=${gisRow?.latitude} b=${gisRow?.buildings_count}`
    );

    const gisAsset = await api("/assets", { method: "POST", token, body: { name: `E2E GIS asset ${run}`, type: "electrical", property_id: gisPropId } });
    check("GIS asset linked to property → 201", gisAsset.status === 201, `status ${gisAsset.status}`);

    const gisWo = await api("/work-orders", { method: "POST", token, body: { asset_id: gisAsset.data?.id, trade: "electrical", title: "GIS linked job", source: "breakdown", priority: "normal" } });
    check("GIS work order on asset → 201", gisWo.status === 201, `status ${gisWo.status}`);

    const gisList2 = await api("/properties", { token });
    const gisRow2 = gisList2.data?.data?.find((p) => p.id === gisPropId);
    check("open_work_orders counts linked jobs", gisList2.status === 200 && Number(gisRow2?.open_work_orders) >= 1, `open=${gisRow2?.open_work_orders}`);

    const patchLoc = await api(`/properties/${gisPropId}`, { method: "PATCH", token, body: { lat: -1.4, lng: 36.9 } });
    check("PATCH /properties/:id coords → 200 updated", patchLoc.status === 200 && patchLoc.data?.latitude === "-1.4" && patchLoc.data?.longitude === "36.9", `status ${patchLoc.status} lat=${patchLoc.data?.latitude}`);

    const techPatchLoc = await api(`/properties/${gisPropId}`, { method: "PATCH", token: techLogin.data?.token, body: { lat: 0 } });
    check("technician cannot edit property → 403", techPatchLoc.status === 403, `status ${techPatchLoc.status}`);

    const geoNoQ = await api("/properties/geocode", { token });
    check("geocode requires q → 400", geoNoQ.status === 400, `status ${geoNoQ.status}`);

    const delOpen = await api(`/properties/${gisPropId}`, { method: "DELETE", token });
    check("DELETE property with open WO → 400", delOpen.status === 400, `status ${delOpen.status}`);

    const techDelProp = await api(`/properties/${gisPropId}`, { method: "DELETE", token: techLogin.data?.token });
    check("technician cannot delete property → 403", techDelProp.status === 403, `status ${techDelProp.status}`);

    const cleanProp = await api("/properties", { method: "POST", token, body: { name: `E2E Del ${run}` } });
    const delClean = await api(`/properties/${cleanProp.data?.id}`, { method: "DELETE", token });
    check("DELETE empty property → 204", delClean.status === 204, `status ${delClean.status}`);

    // ============================================================
    // Phase 12 — integrations: data dictionary, connectors, CSV, webhooks.
    // ============================================================
    const dict = await api("/integrations/data-dictionary");
    check("public data dictionary → 200 + events", dict.status === 200 && Array.isArray(dict.data?.events?.catalog) && dict.data.events.catalog.length >= 1, `status ${dict.status}`);

    const conns = await api("/integrations/connectors", { token });
    check("connectors listed → 4", conns.status === 200 && conns.data?.data?.length === 4, `n=${conns.data?.data?.length}`);

    const csvExport = await fetch(`${BASE}/integrations/export/work_orders?format=csv`, { headers: { Authorization: `Bearer ${token}` } });
    check("export CSV → text/csv", csvExport.status === 200 && (csvExport.headers.get("content-type") || "").includes("text/csv"), `ct=${csvExport.headers.get("content-type")}`);

    const importCsv = "name,type,status\nImported Pump,electrical,active\nBad Asset,not_a_type,active";
    const imp = await api("/integrations/import/assets", { method: "POST", token, body: { csv: importCsv } });
    check("import assets → 201 + 1 imported / 1 skipped", imp.status === 201 && imp.data?.imported === 1 && imp.data?.skipped === 1, JSON.stringify(imp.data));
    const assetsAfter = await query(`SELECT count(*)::int AS n FROM assets WHERE organization_id = $1 AND name = $2`, [orgId, "Imported Pump"]);
    check("imported asset persisted", assetsAfter.rows[0].n === 1, `n=${assetsAfter.rows[0].n}`);

    // Webhook lifecycle + HMAC verification against a local sink.
    const sink = await startWebhookSink();
    const secret = `webhook-secret-${run}`;
    const wh = await api("/webhooks", {
      method: "POST",
      token,
      body: { name: "Test hook", url: `http://127.0.0.1:${sink.port}/hook`, secret, events: ["work_order.created"] },
    });
    check("create webhook → 201", wh.status === 201 && wh.data?.id, `status ${wh.status}`);

    const evWo = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "plumbing", title: "Webhook trigger", source: "breakdown", priority: "normal" },
    });
    check("webhook trigger WO → 201", evWo.status === 201, `status ${evWo.status}`);

    const flush = await api("/webhooks/flush", { method: "POST", token });
    check("flush → queue drained", flush.status === 200 && Number(flush.data?.remaining ?? 0) === 0, JSON.stringify(flush.data));

    await new Promise((r) => setTimeout(r, 200));
    check("webhook sink received a POST", sink.received.length >= 1, `received=${sink.received.length}`);
    if (sink.received.length) {
      const req0 = sink.received[0];
      const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req0.body).digest("hex");
      check("webhook signature valid (HMAC-SHA256)", req0.headers["x-facilix-signature"] === expected, `sig=${String(req0.headers["x-facilix-signature"]).slice(0, 16)}…`);
      const payload = JSON.parse(req0.body);
      check("webhook payload event + event_id", payload.event === "work_order.created" && !!payload.event_id, `event=${payload.event}`);
      check("webhook payload carries work_order_id", payload.data?.work_order_id === evWo.data?.id, `wo=${payload.data?.work_order_id}`);
    }

    const delivs = await api("/webhooks/deliveries", { token });
    check("deliveries listed → 1+", delivs.status === 200 && Array.isArray(delivs.data?.data) && delivs.data.data.length >= 1, `n=${delivs.data?.data?.length}`);

    const deactWh = await api(`/webhooks/${wh.data?.id}`, { method: "PATCH", token, body: { active: false } });
    check("deactivate webhook → 200", deactWh.status === 200 && deactWh.data?.active === false, `status ${deactWh.status}`);
    const before = sink.received.length;
    await api("/work-orders", { method: "POST", token, body: { trade: "plumbing", title: "Second", source: "breakdown", priority: "normal" } });
    await api("/webhooks/flush", { method: "POST", token });
    await new Promise((r) => setTimeout(r, 150));
    check("deactivated webhook receives nothing new", sink.received.length === before, `received=${sink.received.length}`);
    sink.server.close();

    // ============================================================
    // Phase 13 — offline-first field mode. The sync_changes outbox records
    // every mutation as an insert/update/delete change row; /sync/ops replays
    // offline mutations with last-write-wins conflict resolution. Role gates:
    // /sync is staff-only (admin/manager/technician), so tenants and suppliers
    // get 403.
    // ============================================================
    async function collectChanges(token, limit = 500) {
      const all = [];
      let since = 0;
      for (let i = 0; i < 20; i++) {
        const page = await api(`/sync/changes?since=${since}&limit=${limit}`, { token });
        const c = page.data?.changes ?? [];
        all.push(...c);
        if (!page.data?.has_more || !c.length) break;
        since = page.data.cursor;
      }
      return all;
    }

    // The org's mutations so far must already be in the stream (the whole
    // e2e run happened online, so every table the outbox tracks produced rows).
    const changes1 = await api("/sync/changes?limit=5", { token });
    check(
      "sync/changes returns the change stream",
      changes1.status === 200 &&
        changes1.data?.changes?.length >= 1 &&
        changes1.data.changes.every((c) => c.id > 0 && c.entity && c.op && c.payload) &&
        changes1.data.cursor === changes1.data.changes[changes1.data.changes.length - 1].id &&
        typeof changes1.data.has_more === "boolean",
      `rows=${changes1.data?.changes?.length} cursor=${changes1.data?.cursor}`
    );

    const p1 = await api("/sync/changes?since=0&limit=3", { token });
    const p2 = await api(`/sync/changes?since=${p1.data?.cursor}&limit=3`, { token });
    const ids1 = (p1.data?.changes ?? []).map((c) => Number(c.id));
    const ids2 = (p2.data?.changes ?? []).map((c) => Number(c.id));
    check(
      "sync cursor pagination: no overlap, strictly increasing",
      p1.status === 200 &&
        p2.status === 200 &&
        ids1.length === 3 &&
        ids2.length >= 1 &&
        Math.max(...ids1) < Math.min(...ids2) &&
        ids1[1] > ids1[0] &&
        Number(p2.data.cursor) > Number(p1.data.cursor),
      `p1=[${ids1}] p2=[${ids2}]`
    );

    // A delete becomes a tombstone change row carrying the removed row.
    const tombProp = await api("/properties", { method: "POST", token, body: { name: `E2E sync del ${run}` } });
    const tombDel = await api(`/properties/${tombProp.data?.id}`, { method: "DELETE", token });
    check("sync: delete property online → 204", tombDel.status === 204, `status ${tombDel.status}`);
    const tombRow = (await collectChanges(token)).find((c) => c.entity === "properties" && c.entity_id === tombProp.data?.id && c.op === "delete");
    check(
      "sync: tombstone recorded with payload",
      !!tombRow && tombRow.op === "delete" && tombRow.payload?.name === `E2E sync del ${run}`,
      `op=${tombRow?.op} name=${tombRow?.payload?.name}`
    );

    // No user change row may ever leak password_hash into the stream.
    const userChanges = (await collectChanges(token)).filter((c) => c.entity === "users");
    check(
      "sync: user changes scrub password_hash",
      userChanges.length >= 1 && userChanges.every((c) => !("password_hash" in (c.payload ?? {}))),
      `users=${userChanges.length}`
    );

    // Offline closeout: /sync/ops advances the WO, captures the meter value,
    // and consumes parts the same way the online route does.
    const syncAsset = await api("/assets", { method: "POST", token, body: { name: `E2E sync asset ${run}`, type: "hvac", meter_value: 100, meter_unit: "hours" } });
    const syncItem = await api("/inventory", { method: "POST", token, body: { name: `E2E sync part ${run}`, trade: "hvac", unit: "pcs", quantity_on_hand: 10, reorder_threshold: 3 } });
    const syncItemId = syncItem.data?.id;

    const syncWo = await api("/work-orders", {
      method: "POST",
      token,
      body: { trade: "hvac", title: `E2E offline closeout ${run}`, source: "breakdown", priority: "normal", asset_id: syncAsset.data?.id },
    });
    check("sync: online WO to close offline → 201", syncWo.status === 201, `status ${syncWo.status}`);

    const nowIso = laterTs();
    const close = await api("/sync/ops", {
      method: "POST",
      token,
      body: {
        device_id: "e2e-field-phone",
        ops: [
          {
            op: "work_order.update",
            entity_id: syncWo.data?.id,
            client_updated_at: nowIso,
            data: {
              status: "done",
              failure_code: "leak",
              root_cause: "Seal worn through at the union",
              remedy: "Replaced the washer and retightened the union",
              meter_value_at_closeout: 150,
              parts: [{ item_id: syncItemId, quantity: 2 }],
            },
          },
        ],
      },
    });
    const closeRes = close.data?.results?.[0];
    check(
      "sync op: offline closeout applies",
      close.status === 200 && closeRes?.ok === true && closeRes.row?.status === "done" && !!closeRes.row?.completed_at,
      `status ${close.status} ok=${closeRes?.ok} wo=${closeRes?.row?.status} err=${closeRes?.error} skip=${closeRes?.skipped}`
    );

    const invQty = await query(`SELECT quantity_on_hand FROM inventory_items WHERE id = $1`, [syncItemId]);
    const partsMov = await query(
      `SELECT quantity_change FROM inventory_movements WHERE inventory_item_id = $1 AND work_order_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [syncItemId, syncWo.data?.id]
    );
    check(
      "sync op: parts decremented stock + movement written",
      Number(invQty.rows[0]?.quantity_on_hand) === 8 && Number(partsMov.rows[0]?.quantity_change) === -2,
      `qty=${invQty.rows[0]?.quantity_on_hand} mov=${partsMov.rows[0]?.quantity_change}`
    );

    const closeChange = (await collectChanges(token)).find((c) => c.entity === "work_orders" && c.entity_id === syncWo.data?.id && c.op === "update");
    check(
      "sync: closeout change in stream with final state",
      !!closeChange && closeChange.payload?.status === "done" && closeChange.payload?.failure_code === "leak",
      `status=${closeChange?.payload?.status} code=${closeChange?.payload?.failure_code}`
    );

    // A stale offline edit (older than the server row) is skipped, not applied.
    const staleClose = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "work_order.update", entity_id: syncWo.data?.id, client_updated_at: "2000-01-01T00:00:00.000Z", data: { status: "open" } }] },
    });
    const staleRes = staleClose.data?.results?.[0];
    check(
      "sync op: stale LWW edit skipped",
      staleClose.status === 200 && staleRes?.ok === false && staleRes?.skipped === true && /stale/.test(staleRes?.reason || "") && staleRes?.row?.status === "done",
      `ok=${staleRes?.ok} skipped=${staleRes?.skipped}`
    );

    // A device's own ordered session (take → start work → close out) replays as
    // one batch; the pre-batch LWW gate must not skip the later ops just because
    // op 1 bumped the row's updated_at to now() mid-batch.
    const sessionWo = await api("/work-orders", { method: "POST", token, body: { trade: "hvac", title: `E2E offline session ${run}`, source: "breakdown" } });
    const t3 = Date.now() + 5000;
    const session = await api("/sync/ops", {
      method: "POST",
      token,
      body: {
        device_id: "e2e-field-phone",
        ops: [
          { op: "work_order.update", entity_id: sessionWo.data?.id, client_updated_at: new Date(t3 - 2000).toISOString(), data: { status: "assigned" } },
          { op: "work_order.update", entity_id: sessionWo.data?.id, client_updated_at: new Date(t3 - 1000).toISOString(), data: { status: "in_progress" } },
          { op: "work_order.update", entity_id: sessionWo.data?.id, client_updated_at: new Date(t3).toISOString(), data: { status: "done", failure_code: "wear_and_tear", root_cause: "Worn seals", remedy: "Replaced seals" } },
        ],
      },
    });
    const sessionResArr = session.data?.results ?? [];
    const sessionList = await api("/work-orders", { token });
    const sessionRow = sessionList.data?.data?.find((w) => w.id === sessionWo.data?.id);
    check(
      "sync op: multi-op offline session applies end-to-end",
      session.status === 200 && sessionResArr.length === 3 && sessionResArr.every((r) => r?.ok === true) &&
        sessionRow?.status === "done" && sessionRow?.failure_code === "wear_and_tear",
      `ops=${sessionResArr.length} ok=${sessionResArr.map((r) => r.ok).join("/")} status=${sessionRow?.status}`
    );

    // A closeout missing its discipline (no failure code) is rejected per-op.
    const badWo = await api("/work-orders", { method: "POST", token, body: { trade: "hvac", title: `E2E bad close ${run}`, source: "breakdown" } });
    const badClose = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "work_order.update", entity_id: badWo.data?.id, client_updated_at: laterTs(), data: { status: "done" } }] },
    });
    const badRes = badClose.data?.results?.[0];
    check(
      "sync op: undisciplined closeout rejected",
      badClose.status === 200 && badRes?.ok === false && /failure code/.test(badRes?.error || ""),
      `error=${badRes?.error}`
    );

    // Offline work-order creation replays with the client's id echoed back.
    const offCreate = await api("/sync/ops", {
      method: "POST",
      token,
      body: { device_id: "e2e-field-phone", ops: [{ op: "work_order.create", client_id: "e2e-client-1", data: { trade: "hvac", title: `E2E offline created ${run}`, priority: "normal" } }] },
    });
    const crRes = offCreate.data?.results?.[0];
    const createdList = await api("/work-orders", { token });
    check(
      "sync op: offline WO create echoed with server id",
      offCreate.status === 200 && crRes?.ok === true && crRes?.client_id === "e2e-client-1" && !!crRes?.server_entity_id &&
        createdList.data?.data?.some((w) => w.id === crRes.server_entity_id && w.title === `E2E offline created ${run}`),
      `status ${offCreate.status} server=${crRes?.server_entity_id}`
    );

    const syncBadTrade = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "work_order.create", data: { trade: "not_a_trade", title: "should fail" } }] },
    });
    const btRes = syncBadTrade.data?.results?.[0];
    check("sync op: unknown trade rejected by org vocabulary", syncBadTrade.status === 200 && btRes?.ok === false && /trade/.test(btRes?.error || ""), `error=${btRes?.error}`);

    // Same-session evidence: a document.create whose entity_id is the temp id of
    // a work order created earlier in the same batch is remapped server-side to
    // the real row — the offline photo lands on the job instead of 404-ing.
    const remapB64 = Buffer.from(`facilix-e2e-remap-${run}`).toString("base64");
    const remap = await api("/sync/ops", {
      method: "POST",
      token,
      body: {
        device_id: "e2e-field-phone",
        ops: [
          { op: "work_order.create", client_id: "e2e-temp-wo-1", data: { trade: "hvac", title: `E2E offline remap ${run}`, priority: "normal" } },
          { op: "document.create", client_id: "e2e-ev-1", data: { entity_type: "work_order", entity_id: "e2e-temp-wo-1", file_name: "offline-evidence.jpg", content_type: "image/jpeg", data_base64: remapB64 } },
        ],
      },
    });
    const remapRes = remap.data?.results ?? [];
    const remapWoRes = remapRes[0];
    const remapDocRes = remapRes[1];
    const remapDocs = await api(`/documents?entity_type=work_order&entity_id=${remapWoRes?.server_entity_id}`, { token });
    check(
      "sync: evidence on same-session offline WO (temp id remapped)",
      remap.status === 200 && remapWoRes?.ok === true && remapDocRes?.ok === true && remapDocRes.entity === "document" &&
        remapDocs.data?.data?.length === 1 && remapDocs.data.data[0].entity_id === remapWoRes?.server_entity_id,
      `wo=${remapWoRes?.ok} doc=${remapDocRes?.ok} listed=${remapDocs.data?.data?.length}`
    );

    // Idempotency: replaying the same create (same client_id) returns the same
    // server row instead of creating a duplicate — retries and a background-sync
    // flush racing the app are safe.
    const replay = await api("/sync/ops", {
      method: "POST",
      token,
      body: { device_id: "e2e-field-phone", ops: [{ op: "work_order.create", client_id: "e2e-client-1", data: { trade: "hvac", title: `E2E offline created ${run}`, priority: "normal" } }] },
    });
    const replayRes = replay.data?.results?.[0];
    const replayList = await api("/work-orders", { token });
    const replayMatches = replayList.data?.data?.filter((w) => w.title === `E2E offline created ${run}`) ?? [];
    check(
      "sync: replayed create with same client_id is idempotent (no duplicate)",
      replay.status === 200 && replayRes?.ok === true && replayRes?.server_entity_id === crRes?.server_entity_id &&
        replayMatches.length === 1,
      `sameId=${replayRes?.server_entity_id === crRes?.server_entity_id} rows=${replayMatches.length}`
    );

    // Meter readings via ops reuse the same monotonic engine as the online route.
    const syncReading = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "meter_reading.create", client_id: "e2e-meter-1", data: { asset_id: syncAsset.data?.id, reading_value: 150, reading_unit: "hours" } }] },
    });
    const rRes = syncReading.data?.results?.[0];
    check(
      "sync op: meter reading applies",
      syncReading.status === 200 && rRes?.ok === true && Number(rRes.row?.reading_value) === 150,
      `ok=${rRes?.ok} val=${rRes?.row?.reading_value}`
    );

    const lowReading = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "meter_reading.create", data: { asset_id: syncAsset.data?.id, reading_value: 120 } }] },
    });
    const lowRes = lowReading.data?.results?.[0];
    check("sync op: non-monotonic reading rejected", lowReading.status === 200 && lowRes?.ok === false && /monotonic/.test(lowRes?.error || ""), `error=${lowRes?.error}`);

    // Inventory movements via ops respect stock bounds.
    const syncMove = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "inventory_movement.create", data: { inventory_item_id: syncItemId, quantity_change: -1, reason: "E2E field usage" } }] },
    });
    const mRes = syncMove.data?.results?.[0];
    check("sync op: inventory movement applies", syncMove.status === 200 && mRes?.ok === true && Number(mRes.quantity_on_hand) === 7, `ok=${mRes?.ok} qty=${mRes?.quantity_on_hand}`);

    const syncOverdraw = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "inventory_movement.create", data: { inventory_item_id: syncItemId, quantity_change: -999 } }] },
    });
    const odRes = syncOverdraw.data?.results?.[0];
    check("sync op: overdraw rejected per-op", syncOverdraw.status === 200 && odRes?.ok === false && /stock/i.test(odRes?.error || ""), `error=${odRes?.error}`);

    // Asset field edits offline — merge attributes, skip when stale.
    const attrUpdate = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "asset.update", entity_id: syncAsset.data?.id, client_updated_at: laterTs(), data: { attributes: { pressure: "2.4 bar" } } }] },
    });
    const aRes = attrUpdate.data?.results?.[0];
    check("sync op: asset attribute merge applies", attrUpdate.status === 200 && aRes?.ok === true && aRes?.row?.attributes?.pressure === "2.4 bar", `ok=${aRes?.ok} attrs=${JSON.stringify(aRes?.row?.attributes)}`);

    const staleAttr = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "asset.update", entity_id: syncAsset.data?.id, client_updated_at: "2000-01-01T00:00:00.000Z", data: { attributes: { pressure: "1.0 bar" } } }] },
    });
    const saRes = staleAttr.data?.results?.[0];
    check("sync op: stale asset edit skipped", staleAttr.status === 200 && saRes?.ok === false && saRes?.skipped === true, `skipped=${saRes?.skipped}`);

    // /sync is staff-only — tenants and suppliers are rejected at the router gate.
    const syncTenant = await api("/users", { method: "POST", token, body: { full_name: "E2E Sync Tenant", email: `synctenant-${run}@test.co`, password: "facilix-demo", role: "tenant" } });
    const syncTenantToken = (await api("/auth/login", { method: "POST", body: { email: `synctenant-${run}@test.co`, password: "facilix-demo" } })).data?.token;
    const tenantChanges = await api("/sync/changes", { token: syncTenantToken });
    const tenantOps = await api("/sync/ops", { method: "POST", token: syncTenantToken, body: { ops: [{ op: "work_order.create", data: { trade: "hvac", title: "nope" } }] } });
    const supplierChanges = await api("/sync/changes", { token: supplierToken });
    check(
      "sync: tenant + supplier blocked (403)",
      tenantChanges.status === 403 && tenantOps.status === 403 && supplierChanges.status === 403,
      `tenant=${tenantChanges.status}/${tenantOps.status} supplier=${supplierChanges.status}`
    );
    await api(`/users/${syncTenant.data?.id}`, { method: "DELETE", token });

    // --- Document attachments (object-storage layer) ---
    const docWo = await api("/work-orders", { method: "POST", token, body: { trade: "hvac", title: `E2E attachments ${run}`, source: "breakdown" } });
    check("docs: work order for attachments → 201", docWo.status === 201, `status ${docWo.status}`);

    const docBytes = Buffer.from(`facilix-e2e-photo-${run}`);
    const upForm = new FormData();
    upForm.append("entity_type", "work_order");
    upForm.append("entity_id", docWo.data?.id);
    upForm.append("file", new Blob([docBytes], { type: "image/png" }), "leak-photo.png");
    const upRes = await fetch(`${BASE}/documents`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: upForm });
    const upData = await upRes.json();
    check(
      "docs: upload → 201 + /files/ url + content_type",
      upRes.status === 201 && upData?.data?.file_url?.startsWith("/files/") && upData?.data?.content_type === "image/png",
      `status ${upRes.status} url=${upData?.data?.file_url}`
    );

    const docsList = await api(`/documents?entity_type=work_order&entity_id=${docWo.data?.id}`, { token });
    check(
      "docs: list for entity",
      docsList.status === 200 && docsList.data?.data?.length === 1 && docsList.data.data[0].file_name === "leak-photo.png",
      `n=${docsList.data?.data?.length}`
    );

    const fileKey = upData?.data?.file_url?.replace("/files/", "");
    const streamRes = await fetch(`${BASE}/files/${fileKey}`, { headers: { Authorization: `Bearer ${token}` } });
    const streamBuf = Buffer.from(await streamRes.arrayBuffer());
    check(
      "docs: authenticated stream returns bytes + type",
      streamRes.status === 200 && streamBuf.equals(docBytes) && streamRes.headers.get("content-type") === "image/png",
      `status ${streamRes.status} len=${streamBuf.length}`
    );

    const anonStream = await fetch(`${BASE}/files/${fileKey}`);
    check("docs: stream without auth → 401", anonStream.status === 401, `status ${anonStream.status}`);

    // Cross-org reads are impossible — a second org's admin gets 404 on the key.
    const docsCross = await api("/auth/signup", {
      method: "POST",
      body: { orgName: `E2E Docs Org ${run}`, fullName: "Docs Tester", email: `docs-${run}@test.local`, password: "password-123" },
    });
    extraOrgId = docsCross.data?.user?.organization_id;
    const crossStream = await fetch(`${BASE}/files/${fileKey}`, { headers: { Authorization: `Bearer ${docsCross.data?.token}` } });
    check("docs: cross-org file read → 404", crossStream.status === 404, `status ${crossStream.status}`);

    const badEntityForm = new FormData();
    badEntityForm.append("entity_type", "work_order");
    badEntityForm.append("entity_id", "00000000-0000-0000-0000-000000000000");
    badEntityForm.append("file", new Blob(["x"]), "x.txt");
    const badEntity = await fetch(`${BASE}/documents`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: badEntityForm });
    check("docs: upload to unknown entity → 404", badEntity.status === 404, `status ${badEntity.status}`);

    // --- Offline evidence: /sync/ops document.create ---
    const evidenceBytes = Buffer.from(`facilix-e2e-evidence-${run}`);
    const evidenceB64 = evidenceBytes.toString("base64");
    const docSync = await api("/sync/ops", {
      method: "POST",
      token,
      body: {
        device_id: "field-phone-7",
        ops: [{ op: "document.create", client_id: `ev-${run}`, data: { entity_type: "work_order", entity_id: docWo.data?.id, file_name: "field-evidence.jpg", content_type: "image/jpeg", data_base64: evidenceB64 } }],
      },
    });
    const syncRow = docSync.data?.results?.[0];
    check(
      "sync: document.create applies → document row + storage key",
      docSync.status === 200 && syncRow?.ok === true && syncRow.entity === "document" && typeof syncRow.row?.file_url === "string",
      `status ${docSync.status} ok=${syncRow?.ok}`
    );

    const syncKey = syncRow?.row?.file_url;
    const docsList2 = await api(`/documents?entity_type=work_order&entity_id=${docWo.data?.id}`, { token });
    check(
      "sync: offline evidence listed alongside the upload",
      docsList2.status === 200 && docsList2.data?.data?.length === 2,
      `n=${docsList2.data?.data?.length}`
    );

    const syncStream = await fetch(`${BASE}/files/${syncKey}`, { headers: { Authorization: `Bearer ${token}` } });
    const syncBuf = Buffer.from(await syncStream.arrayBuffer());
    check(
      "sync: evidence stream returns original bytes + type",
      syncStream.status === 200 && syncBuf.equals(evidenceBytes) && syncStream.headers.get("content-type") === "image/jpeg",
      `status ${syncStream.status} len=${syncBuf.length}`
    );

    const crossSync = await api("/sync/ops", {
      method: "POST",
      token: docsCross.data?.token,
      body: { ops: [{ op: "document.create", data: { entity_type: "work_order", entity_id: docWo.data?.id, file_name: "sneak.jpg", data_base64: evidenceB64 } }] },
    });
    check(
      "sync: cross-org evidence attach → rejected",
      crossSync.data?.results?.[0]?.ok === false && String(crossSync.data?.results?.[0]?.error).includes("not found"),
      `ok=${crossSync.data?.results?.[0]?.ok}`
    );

    const badSyncEntity = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "document.create", data: { entity_type: "work_order", entity_id: "00000000-0000-0000-0000-000000000000", file_name: "nope.jpg", data_base64: evidenceB64 } }] },
    });
    check(
      "sync: evidence to unknown entity → rejected",
      badSyncEntity.data?.results?.[0]?.ok === false && String(badSyncEntity.data?.results?.[0]?.error).includes("not found"),
      `ok=${badSyncEntity.data?.results?.[0]?.ok}`
    );

    const oversizeB64 = Buffer.alloc(21 * 1024 * 1024).toString("base64");
    const oversizeSync = await api("/sync/ops", {
      method: "POST",
      token,
      body: { ops: [{ op: "document.create", data: { entity_type: "work_order", entity_id: docWo.data?.id, file_name: "big.jpg", data_base64: oversizeB64 } }] },
    });
    const oversizeMsg = oversizeSync.data?.issues?.[0]?.message ?? oversizeSync.data?.error ?? "";
    check(
      "sync: oversized evidence → rejected (20MB cap)",
      oversizeSync.status === 400 && String(oversizeMsg).includes("20MB"),
      `status ${oversizeSync.status} msg=${String(oversizeMsg).slice(0, 60)}`
    );

    const delDoc = await api(`/documents/${upData?.data?.id}`, { method: "DELETE", token });
    check("docs: delete → 204", delDoc.status === 204, `status ${delDoc.status}`);
    const goneStream = await fetch(`${BASE}/files/${fileKey}`, { headers: { Authorization: `Bearer ${token}` } });
    check("docs: file removed after delete → 404", goneStream.status === 404, `status ${goneStream.status}`);

    // --- Phase 23: Budget Tracking ---
    const budgetCreate = await api("/budgets", {
      method: "POST",
      token,
      body: { name: "E2E Plumbing Budget", trade: "plumbing", fiscal_year: new Date().getFullYear(), planned_amount: 500000 },
    });
    check("budget: create → 201", budgetCreate.status === 201 && budgetCreate.data?.name === "E2E Plumbing Budget", `status=${budgetCreate.status} name=${budgetCreate.data?.name}`);
    const budgetId = budgetCreate.data?.id;

    const budgetList = await api("/budgets", { token });
    const foundBudget = budgetList.data?.find((b) => b.id === budgetId);
    check("budget: list returns created budget with actual_spend", budgetList.status === 200 && foundBudget && foundBudget.planned_amount === "500000.00" && foundBudget.actual_spend !== undefined, `count=${budgetList.data?.length} spend=${foundBudget?.actual_spend}`);

    const budgetPatch = await api(`/budgets/${budgetId}`, { method: "PATCH", token, body: { planned_amount: 600000, notes: "updated" } });
    check("budget: patch → 200", budgetPatch.status === 200 && Number(budgetPatch.data?.planned_amount) === 600000, `amount=${budgetPatch.data?.planned_amount}`);

    const budgetCsv = await fetch(`${BASE}/budgets?format=csv&fiscal_year=${new Date().getFullYear()}`, { headers: { Authorization: `Bearer ${token}` } });
    check("budget: CSV export → 200 + header", budgetCsv.status === 200 && (await budgetCsv.text()).startsWith("name,trade"), `status=${budgetCsv.status}`);

    const budgetDel = await api(`/budgets/${budgetId}`, { method: "DELETE", token });
    check("budget: delete → 204", budgetDel.status === 204, `status=${budgetDel.status}`);
    const budgetGone = await api("/budgets", { token });
    check("budget: deleted budget gone", !budgetGone.data?.some((b) => b.id === budgetId), `still=${budgetGone.data?.some((b) => b.id === budgetId)}`);

  } catch (err) {
    check("unexpected error", false, err.message);
  } finally {
    if (orgId) {
      await query(`DELETE FROM organizations WHERE id = $1`, [orgId]).catch(() => {});
      console.log(`  cleaned up org ${orgId}`);
    }
    if (extraOrgId) {
      await query(`DELETE FROM organizations WHERE id = $1`, [extraOrgId]).catch(() => {});
      console.log(`  cleaned up extra org ${extraOrgId}`);
    }
    await pool.end();
    server.kill();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main();
