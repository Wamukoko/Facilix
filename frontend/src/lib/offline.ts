// Phase 13 — offline-first field mode. An IndexedDB-backed store for the
// three things the Field screen needs while disconnected:
//   cache — server rows (work orders, assets, inventory items) keyed by
//           "entityPrefix:id" so the screen converges with /sync/changes.
//   queue — outbound offline ops awaiting POST /sync/ops after reconnecting.
//   meta  — the sync cursor (last applied sync_changes.id) and device id.
// Kept deliberately dependency-free: the service worker caches static assets;
// this stores data.

const DB_NAME = "facilix-offline";
const DB_VERSION = 2;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache");
      if (!db.objectStoreNames.contains("queue")) {
        db.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("conflicts")) {
        db.createObjectStore("conflicts", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= openDB();
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

// ---- cache store -----------------------------------------------------------

export async function cacheSet(key: string, value: unknown): Promise<void> {
  const d = await db();
  await request(d.transaction("cache", "readwrite").objectStore("cache").put(value, key));
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return (await request<T | undefined>(d.transaction("cache", "readonly").objectStore("cache").get(key))) ?? undefined;
}

export async function cacheDelete(key: string): Promise<void> {
  const d = await db();
  await request(d.transaction("cache", "readwrite").objectStore("cache").delete(key));
}

// Every cached row matching a key prefix, e.g. cacheAll<WorkOrder>("wo:").
export async function cacheAll<T>(prefix: string): Promise<T[]> {
  const d = await db();
  const store = d.transaction("cache", "readonly").objectStore("cache");
  return new Promise((resolve, reject) => {
    const out: T[] = [];
    const cur = store.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve(out);
      const key = String(c.key);
      if (key.startsWith(prefix)) out.push(c.value as T);
      c.continue();
    };
    cur.onerror = () => reject(cur.error ?? new Error("IndexedDB cursor failed"));
  });
}

// ---- queue store -----------------------------------------------------------

export interface QueuedOp {
  id?: number;
  created: string;
  op: string;
  client_id?: string;
  client_updated_at?: string;
  entity_id?: string | null;
  data: Record<string, unknown>;
}

export async function queueAdd(op: QueuedOp): Promise<number> {
  const d = await db();
  return (await request<IDBValidKey>(d.transaction("queue", "readwrite").objectStore("queue").add(op))) as number;
}

export async function queueAll(): Promise<QueuedOp[]> {
  const d = await db();
  const req = d.transaction("queue", "readonly").objectStore("queue").getAll();
  return await request(req);
}

export async function queueRemove(id: number): Promise<void> {
  const d = await db();
  await request(d.transaction("queue", "readwrite").objectStore("queue").delete(id));
}

// ---- meta store -----------------------------------------------------------

export async function metaGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return (await request<T | undefined>(d.transaction("meta", "readonly").objectStore("meta").get(key))) ?? undefined;
}

export async function metaSet(key: string, value: unknown): Promise<void> {
  const d = await db();
  await request(d.transaction("meta", "readwrite").objectStore("meta").put(value, key));
}

export async function metaRemove(key: string): Promise<void> {
  const d = await db();
  await request(d.transaction("meta", "readwrite").objectStore("meta").delete(key));
}

// ---- conflict store ---------------------------------------------------------
// Ops the server skipped as stale (a newer server state exists) are parked here
// so the Field screen can surface them and the user decides keep-mine or
// accept-server. The queue is intentionally empty once a conflict is parked.

export interface Conflict {
  id?: number;
  created: string;
  op: string;
  client_id?: string;
  client_updated_at?: string;
  entity_id?: string | null;
  data: Record<string, unknown>;
  conflict_reason: string;
}

export async function conflictAdd(conflict: Conflict): Promise<number> {
  const d = await db();
  return (await request<IDBValidKey>(d.transaction("conflicts", "readwrite").objectStore("conflicts").add(conflict))) as number;
}

export async function conflictAll(): Promise<Conflict[]> {
  const d = await db();
  const req = d.transaction("conflicts", "readonly").objectStore("conflicts").getAll();
  return await request(req);
}

export async function conflictRemove(id: number): Promise<void> {
  const d = await db();
  await request(d.transaction("conflicts", "readwrite").objectStore("conflicts").delete(id));
}
