// Phase 13 — offline-first field mode. The client side of the sync contract:
// bootstraps the local cache from list endpoints, folds /sync/changes rows
// (including tombstones) into IndexedDB, and replays queued offline ops via
// POST /sync/ops with last-write-wins resolution. The Field screen never talks
// to these endpoints directly — it reads the cache and calls queueOp/flush.

import { api } from "./api";
import * as conflict from "./offline";
import * as offline from "./offline";
import type { Asset, InventoryItem, SyncChange, SyncOp, SyncOpResult, WorkOrder } from "./types";

// Entity table → local cache prefix (mirrors the cacheKey used on writes).
const ENTITY_PREFIX: Record<string, string> = {
  work_orders: "wo",
  assets: "asset",
  inventory_items: "item",
  properties: "prop",
  users: "user",
  notifications: "notif",
  trades: "trade",
  asset_types: "asset_type",
};

const CURSOR_KEY = "sync_cursor";
const DEVICE_KEY = "device_id";

export function cacheKey(entity: string, id: string): string {
  return `${ENTITY_PREFIX[entity] ?? entity}:${id}`;
}

export async function deviceId(): Promise<string> {
  let id = await offline.metaGet<string>(DEVICE_KEY);
  if (!id) {
    id = `field-${crypto.randomUUID()}`;
    await offline.metaSet(DEVICE_KEY, id);
  }
  return id;
}

export interface SyncSummary {
  synced: number;
  dropped: number;
  errored: number;
  pending: number;
  pulled: number;
  conflicts: number;
  error: string | null;
}

// Fetch the reference lists once (when online) so the Field screen has data
// to show before the incremental stream catches up. Best-effort: any failure
// means offline — the screen falls back to whatever is already cached.
export async function bootstrap(): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    const [wos, assets, items] = await Promise.all([
      api.get<{ data: WorkOrder[] }>("/work-orders", { limit: 500 }),
      api.get<{ data: Asset[] }>("/assets", { limit: 500 }),
      api.get<{ data: InventoryItem[] }>("/inventory", { limit: 500 }),
    ]);
    for (const w of wos.data ?? []) await offline.cacheSet(cacheKey("work_orders", w.id), w);
    for (const a of assets.data ?? []) await offline.cacheSet(cacheKey("assets", a.id), a);
    for (const i of items.data ?? []) await offline.cacheSet(cacheKey("inventory_items", i.id), i);
    return true;
  } catch {
    return false;
  }
}

// Fold change rows into the cache: deletes are tombstones that remove the row.
async function applyChanges(changes: SyncChange[]): Promise<void> {
  for (const c of changes) {
    const key = cacheKey(c.entity, c.entity_id);
    if (c.op === "delete") await offline.cacheDelete(key);
    else if (c.payload) await offline.cacheSet(key, c.payload);
  }
}

// Pull incremental changes since the stored cursor and advance it.
export async function pullChanges(): Promise<number> {
  if (!navigator.onLine) return 0;
  const since = (await offline.metaGet<number>(CURSOR_KEY)) ?? 0;
  let cursor = since;
  let pulled = 0;
  for (let i = 0; i < 50; i++) {
    const page = await api.get<{ changes: SyncChange[]; cursor: number; has_more: boolean }>("/sync/changes", {
      since: cursor,
      limit: 500,
    });
    const changes = page.changes ?? [];
    await applyChanges(changes);
    pulled += changes.length;
    cursor = page.cursor;
    if (!page.has_more || !changes.length) break;
  }
  await offline.metaSet(CURSOR_KEY, cursor);
  return pulled;
}

// Write-ahead: every offline mutation lands in the queue before anything else,
// so nothing is lost if the flush fails. Retries are safe because the ops are
// idempotent at the server (client_id/client_updated_at). The cache is also
// updated optimistically so the Field screen reflects local intent instantly —
// the server still wins on conflicts when the flush converges.
export async function queueOp(op: SyncOp): Promise<void> {
  await offline.queueAdd({
    created: new Date().toISOString(),
    ...op,
  });
  await applyOptimistically(op);
  void registerBackgroundSync();
}

// Ask the service worker to flush the queue when connectivity returns (Item 3).
// Best-effort: unsupported browsers, and the usual on-line flush path, still
// cover the sync — this only adds a nudge for backgrounded/closed tabs.
async function registerBackgroundSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg || !("sync" in reg)) return;
    await (reg as ServiceWorkerRegistration & { sync: { register(tag: string): Promise<void> } }).sync.register("flush-queue");
  } catch {
    // Ignore — the on-line path still syncs.
  }
}

// Mirror the op onto the cached rows the Field screen renders. Creates use a
// temp id (the client_id) that flushQueue removes once the server id exists.
async function applyOptimistically(op: SyncOp): Promise<void> {
  switch (op.op) {
    case "work_order.create": {
      const d = op.data;
      const now = new Date().toISOString();
      const wo: WorkOrder = {
        id: op.client_id ?? `temp-${crypto.randomUUID()}`,
        organization_id: "",
        asset_id: null,
        room_id: null,
        maintenance_plan_id: null,
        source: (d.source as WorkOrder["source"]) ?? "breakdown",
        trade: (d.trade as string) ?? "",
        title: (d.title as string) ?? "",
        description: (d.description as string | null) ?? null,
        status: "open",
        priority: (d.priority as WorkOrder["priority"]) ?? "normal",
        assigned_supplier_id: null,
        assigned_user_id: null,
        reported_by_user_id: null,
        cost: null,
        due_date: null,
        failure_code: null,
        root_cause: null,
        remedy: null,
        parts_used: null,
        meter_value_at_closeout: null,
        completed_at: null,
        cancelled_at: null,
        cancelled_by_user_id: null,
        cancelled_by_name: null,
        cancellation_reason: null,
        archived_at: null,
        sla_due_at: null,
        sla_breached: null,
        latitude: null,
        longitude: null,
        document_count: null,
        created_at: now,
        updated_at: now,
      };
      await offline.cacheSet(cacheKey("work_orders", wo.id), wo);
      break;
    }
    case "work_order.update": {
      const wo = await offline.cacheGet<WorkOrder>(cacheKey("work_orders", op.entity_id));
      if (wo && typeof op.data.status === "string") {
        wo.status = op.data.status as WorkOrder["status"];
        await offline.cacheSet(cacheKey("work_orders", wo.id), wo);
      }
      break;
    }
    case "inventory_movement.create": {
      const item = await offline.cacheGet<InventoryItem>(cacheKey("inventory_items", op.data.inventory_item_id as string));
      if (item) {
        const qty = Number(item.quantity_on_hand) + Number(op.data.quantity_change ?? 0);
        item.quantity_on_hand = String(Math.max(0, qty));
        await offline.cacheSet(cacheKey("inventory_items", item.id), item);
      }
      break;
    }
    default:
      break;
  }
}

export async function queuedCount(): Promise<number> {
  return (await offline.queueAll()).length;
}

// Pending offline evidence (document.create ops) per work order, so the Field
// screen can badge jobs whose photos/videos have not flushed yet.
export async function queuedEvidenceByWorkOrder(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const q of await offline.queueAll()) {
    if (q.op === "document.create" && q.data?.entity_type === "work_order" && typeof q.data.entity_id === "string") {
      out.set(q.data.entity_id, (out.get(q.data.entity_id) ?? 0) + 1);
    }
  }
  return out;
}

export async function cachedWorkOrders(): Promise<WorkOrder[]> {
  return (await offline.cacheAll<WorkOrder>("wo:")).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function cachedAssets(): Promise<Asset[]> {
  return offline.cacheAll<Asset>("asset:");
}

export async function cachedInventory(): Promise<InventoryItem[]> {
  return offline.cacheAll<InventoryItem>("item:");
}

// ---- conflict resolution ---------------------------------------------------

// Ops parked because the server skipped them as stale. The Field screen
// surfaces these and lets the user pick keep-mine or accept-server.
export async function cachedConflicts(): Promise<offline.Conflict[]> {
  return offline.conflictAll();
}

// Keep-mine: replay the op as a fresh write (new client_updated_at so the
// server treats it as the newest state) and drop the parked record. Creates
// get a brand-new client_id so they are re-issued rather than replayed.
export async function keepConflict(c: offline.Conflict): Promise<void> {
  const op = {
    op: c.op,
    entity_id: c.entity_id ?? undefined,
    client_updated_at: new Date().toISOString(),
    data: c.data,
    ...(c.op.endsWith(".create") ? { client_id: crypto.randomUUID() } : {}),
  } as SyncOp;
  await queueOp(op);
  await offline.conflictRemove(c.id!);
}

// Accept-server: the server's version already won (that's why the op was
// skipped) and was folded into the cache during flush — just drop the record.
export async function discardConflict(c: offline.Conflict): Promise<void> {
  await offline.conflictRemove(c.id!);
}

// When an op is skipped as stale at flush time, move it to the conflict store so
// the Field screen can surface it. Allows users to keep their local version
// (keep-mine) or accept the server version (discard local) once reconnected.
export async function onConflict(q: offline.QueuedOp, reason: string): Promise<void> {
  await conflict.conflictAdd({
    created: new Date().toISOString(),
    op: q.op,
    client_id: q.client_id ?? undefined,
    client_updated_at: q.client_updated_at ?? undefined,
    entity_id: q.entity_id ?? null,
    data: q.data,
    conflict_reason: reason,
  });
  await offline.queueRemove(q.id!);
}

// Replay queued ops, then pull server-side changes so the cache converges.
// An op is dropped from the queue when the server applied it (ok), skipped it
// as stale (a newer state exists — parked in the conflict store), or rejected
// it (validation/business error — retrying would never succeed). Only network
// failures keep ops queued.
export async function flushQueue(): Promise<SyncSummary> {
  const summary: SyncSummary = { synced: 0, dropped: 0, errored: 0, pending: 0, pulled: 0, conflicts: 0, error: null };

  const queued = await offline.queueAll();
  if (queued.length) {
    try {
      const ops = queued.map(({ id: _id, created: _created, ...op }) => op) as SyncOp[];
      const res = await api.post<{ results: SyncOpResult[] }>("/sync/ops", {
        device_id: await deviceId(),
        ops,
      });
      for (let i = 0; i < queued.length; i++) {
        const q = queued[i];
        const r = res.results?.[i];
        if (!r || r.ok) {
          // Applied, or no per-op result back — the op is consumed either way.
          summary.synced++;
          if (r?.row && r.entity === "work_order")
            await offline.cacheSet(cacheKey("work_orders", String(r.server_entity_id ?? q.entity_id ?? "")), r.row);
          if (q.op === "work_order.create" && q.client_id) await offline.cacheDelete(cacheKey("work_orders", q.client_id));
          await offline.queueRemove(q.id!);
        } else if (r.skipped) {
          summary.dropped++;
          summary.conflicts++;
          if (r.row && r.entity === "work_order")
            await offline.cacheSet(cacheKey("work_orders", String(q.entity_id ?? "")), r.row);
          if (q.op === "work_order.create" && q.client_id) await offline.cacheDelete(cacheKey("work_orders", q.client_id));
          await onConflict(q, r.reason || "stale");
        } else {
          summary.errored++;
          if (q.op === "work_order.create" && q.client_id) await offline.cacheDelete(cacheKey("work_orders", q.client_id));
          await offline.queueRemove(q.id!);
        }
      }
    } catch (err) {
      summary.error = err instanceof Error ? err.message : "Sync failed";
      summary.pending = (await offline.queueAll()).length;
      if (summary.pending > 0) void registerBackgroundSync();
      return summary;
    }
  }

  try {
    summary.pulled = await pullChanges();
  } catch {
    summary.error = summary.error ?? "Could not pull changes";
  }
  summary.pending = (await offline.queueAll()).length;
  if (summary.pending > 0) void registerBackgroundSync();
  return summary;
}
