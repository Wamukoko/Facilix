import crypto from "node:crypto";
import { query } from "./db.js";

// Phase 12 — event bus + webhook delivery.
//
// publishEvent() writes a durable row to event_outbox (the source of truth),
// then kicks off an async delivery pass for that org. A background worker
// (startWebhookWorker) retries anything that failed until it lands or gives
// up via exponential backoff. Consumers that don't subscribe just see the
// outbox row marked delivered with no webhook_deliveries row.
//
// Delivery format:
//   POST { url }  JSON { event, event_id, timestamp, org_id, data }
//   headers: Content-Type: application/json
//            X-Facilix-Signature: sha256=<hmac-sha256 hex of raw body>
//            X-Facilix-Event: <event>
// Receivers can verify the HMAC with their shared secret and dedupe on
// event_id (we retry failed deliveries, so idempotency is on them).

const RETRY_BACKOFF_SECONDS = [5, 15, 60, 300, 900];

const EVENT_NAMES = new Set([
  "work_order.created",
  "work_order.assigned",
  "work_order.closed",
  "work_order.cancelled",
  "inventory.low_stock",
  "asset.threshold_crossed",
  "asset.warranty_expiring",
  "asset.warranty_expired",
  "compliance.permit_issued",
  "compliance.inspection_overdue",
  "compliance.competency_expired",
  "contract.expiring",
  "contract.expired",
  "contract.terminated",
]);

export const knownEvents = () => [...EVENT_NAMES];

export function isKnownEvent(name) {
  return EVENT_NAMES.has(name);
}

// Emits an event: persists it to the outbox and triggers a delivery pass.
// Best-effort — an event-bus failure must never fail the business write that
// produced the event.
export async function publishEvent(orgId, event, data) {
  if (!isKnownEvent(event)) {
    console.warn(`[events] dropping unknown event "${event}"`);
    return;
  }
  try {
    const { rows } = await query(
      `INSERT INTO event_outbox (organization_id, event, payload) VALUES ($1,$2,$3) RETURNING id`,
      [orgId, event, JSON.stringify({ data })]
    );
    flushOrgOutbox(orgId).catch((err) => {
      console.error("[events] background delivery pass failed:", err);
    });
    return rows[0].id;
  } catch (err) {
    console.error("[events] failed to enqueue event:", err);
    return null;
  }
}

// Builds the canonical webhook body for an outbox row.
function webhookBody(row) {
  return {
    event: row.event,
    event_id: row.id,
    timestamp: row.created_at,
    org_id: row.organization_id,
    data: row.payload?.data ?? {},
  };
}

function sign(secret, rawBody) {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(rawBody, "utf8");
  return `sha256=${hmac.digest("hex")}`;
}

async function deliverToWebhook(webhook, row) {
  const body = webhookBody(row);
  const raw = JSON.stringify(body);
  const signature = sign(webhook.secret, raw);

  let response;
  try {
    response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Facilix-Signature": signature,
        "X-Facilix-Event": row.event,
      },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    await recordDelivery(webhook, row, null, null, err.message);
    return false;
  }

  const text = await response.text().catch(() => "");
  const ok = response.status >= 200 && response.status < 300;
  await recordDelivery(webhook, row, response.status, ok ? null : text.slice(0, 500), null);
  return ok;
}

async function recordDelivery(webhook, row, status, responseBody, error) {
  try {
    await query(
      `INSERT INTO webhook_deliveries (organization_id, webhook_id, event, payload, response_status, response_body, attempts, delivered_at, last_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.organization_id,
        webhook.id,
        row.event,
        JSON.stringify(row.payload),
        status,
        responseBody,
        row.attempts + 1,
        status != null && status >= 200 && status < 300 ? new Date() : null,
        error ?? null,
      ]
    );
  } catch (err) {
    console.error("[events] failed to record delivery:", err);
  }
}

// Delivers every pending outbox event for one org. An event is marked
// delivered when it has no active subscribers OR all subscribers accepted it.
export async function flushOrgOutbox(orgId) {
  const { rows: pending } = await query(
    `SELECT * FROM event_outbox
     WHERE organization_id = $1 AND delivered_at IS NULL AND next_attempt_at <= now()
     ORDER BY created_at ASC`,
    [orgId]
  );
  if (!pending.length) return { processed: 0, remaining: 0 };

  const { rows: hooks } = await query(
    `SELECT * FROM webhooks WHERE organization_id = $1 AND active = true`,
    [orgId]
  );

  let processed = 0;
  for (const row of pending) {
    const subscribers = hooks.filter((h) => h.events.includes(row.event));
    if (!subscribers.length) {
      await query(`UPDATE event_outbox SET delivered_at = now() WHERE id = $1`, [row.id]);
      processed += 1;
      continue;
    }

    let allOk = true;
    for (const hook of subscribers) {
      const ok = await deliverToWebhook(hook, row);
      if (!ok) allOk = false;
    }

    if (allOk) {
      await query(`UPDATE event_outbox SET delivered_at = now() WHERE id = $1`, [row.id]);
    } else {
      const attempts = row.attempts + 1;
      const backoff = RETRY_BACKOFF_SECONDS[Math.min(attempts - 1, RETRY_BACKOFF_SECONDS.length - 1)];
      await query(
        `UPDATE event_outbox SET attempts = $2, next_attempt_at = now() + ($3 || ' seconds')::interval, last_error = $4
         WHERE id = $1`,
        [row.id, attempts, backoff, `delivery failed after ${attempts} attempt(s)`]
      );
    }
    processed += 1;
  }

  const { rows: remainingRows } = await query(
    `SELECT count(*)::int AS n FROM event_outbox WHERE organization_id = $1 AND delivered_at IS NULL`,
    [orgId]
  );
  return { processed, remaining: remainingRows[0].n };
}

export async function flushAllOutbox() {
  const { rows: orgs } = await query(`SELECT DISTINCT organization_id FROM event_outbox WHERE delivered_at IS NULL`);
  let processed = 0;
  for (const { organization_id } of orgs) {
    const res = await flushOrgOutbox(organization_id);
    processed += res.processed;
  }
  return { processed };
}

let workerTimer = null;

export function startWebhookWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    flushAllOutbox().catch((err) => console.error("[events] worker pass failed:", err));
  }, 30_000);
  workerTimer.unref?.();
  console.log("[events] webhook delivery worker started (every 30s).");
}
