import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { AlertTriangle, Plus, RefreshCw, Wifi, WifiOff } from "lucide-react";
import type { Asset, FailureCode, InventoryItem, SyncOp, WorkOrder, WorkOrderPriority, WorkOrderStatus } from "../lib/types";
import { BUILTIN_TRADE_OPTIONS, FAILURE_CODES, PRIORITIES, formatDate } from "../lib/format";
import { PriorityBadge, SourceBadge, TradeBadge } from "../components/Badges";
import { Button, Card, ErrorBanner, Field as FormField, Input, Modal, Select, Textarea } from "../components/ui";
import { useConfig } from "../context/ConfigContext";
import { useAuth } from "../context/AuthContext";
import type { Conflict } from "../lib/offline";
import type { SyncSummary } from "../lib/syncClient";
import {
  bootstrap,
  cachedAssets,
  cachedConflicts,
  cachedInventory,
  cachedWorkOrders,
  discardConflict,
  flushQueue,
  keepConflict,
  queueOp,
  queuedCount,
  queuedEvidenceByWorkOrder,
} from "../lib/syncClient";

// Phase 13 — the Field screen is the offline-first surface: jobs, meter
// reads, and stock adjustments all write to the IndexedDB queue first and
// replay through /sync/ops when connectivity returns. Nothing here blocks on
// the network — the server decides conflicts (LWW) at flush time.

const NEXT_STATUS: Partial<Record<WorkOrderStatus, WorkOrderStatus>> = {
  open: "assigned",
  assigned: "in_progress",
  in_progress: "done",
};

const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  open: "Open",
  assigned: "Assigned",
  in_progress: "In progress",
  done: "Done",
  verified: "Verified",
  cancelled: "Cancelled",
};

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

export default function Field() {
  const { user } = useAuth();
  const online = useOnline();
  const isTechnician = user?.role === "technician";
  const [jobs, setJobs] = useState<WorkOrder[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [pending, setPending] = useState(0);
  const [evidenceCounts, setEvidenceCounts] = useState<Map<string, number>>(new Map());
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [closeoutFor, setCloseoutFor] = useState<WorkOrder | null>(null);
  const [meterFor, setMeterFor] = useState<WorkOrder | null>(null);
  const [stockFor, setStockFor] = useState<InventoryItem | null>(null);
  const [evidenceFor, setEvidenceFor] = useState<WorkOrder | null>(null);

  const reload = useCallback(async () => {
    setJobs(await cachedWorkOrders());
    setAssets(await cachedAssets());
    setItems(await cachedInventory());
    setPending(await queuedCount());
    setEvidenceCounts(await queuedEvidenceByWorkOrder());
    setConflicts(await cachedConflicts());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await reload();
      const booted = await bootstrap();
      await reload();
      if (booted) {
        try {
          const s = await flushQueue();
          if (!cancelled) setSummary(s);
          await reload();
        } catch {
          await reload();
        }
      } else if (!cancelled) {
        setSummary({ synced: 0, dropped: 0, errored: 0, pulled: 0, pending: 0, conflicts: 0, error: "Offline — showing cached data. Changes are queued." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const openJobs = useMemo(() => {
    const base = jobs.filter((w) => ["open", "assigned", "in_progress"].includes(w.status));
    if (isTechnician) return base.filter((w) => w.assigned_user_id === user?.id);
    return base;
  }, [jobs, isTechnician, user?.id]);

  async function syncNow() {
    setBusy(true);
    const s = await flushQueue();
    setSummary(s);
    await reload();
    setBusy(false);
  }

  async function submitOp(op: SyncOp) {
    await queueOp(op);
    await reload();
    await syncNow();
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Field mode</h1>
          <p className="text-sm text-dim">
            Offline-first jobs board — actions are queued locally and replayed through /sync/ops.
          </p>
        </div>
        <Button onClick={syncNow} disabled={busy}>
          <RefreshCw size={16} className={busy ? "animate-spin" : ""} /> {busy ? "Syncing…" : "Sync now"}
          {pending > 0 ? ` (${pending})` : ""}
        </Button>
      </div>

      <div
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold ${
          online ? "border-gardening/40 bg-gardening/10 text-gardening" : "border-amber/40 bg-amber/10 text-amber"
        }`}
      >
        {online ? <Wifi size={15} /> : <WifiOff size={15} />}
        {online ? "Online — sync active" : "Offline — showing cached data, actions queued"}
        {pending > 0 ? <span className="rounded-full bg-panel px-2 py-0.5 text-xs">{pending} queued</span> : null}
      </div>

      {summary ? (
        <div className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-dim">
          {summary.error ? <p className="font-semibold text-amber">{summary.error}</p> : null}
          <p className="mt-0.5">
            Last sync: {summary.synced} applied, {summary.dropped} stale-skipped{summary.conflicts ? ` (${summary.conflicts} conflict${summary.conflicts === 1 ? "" : "s"})` : ""},{" "}
            {summary.errored} rejected, {summary.pulled} pulled from server, {summary.pending} still queued.
          </p>
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber">
            <AlertTriangle size={15} />
            {conflicts.length} change{conflicts.length === 1 ? "" : "s"} resolved to the server version while offline
          </div>
          <Button variant="secondary" onClick={() => setConflictOpen(true)}>
            Review conflicts
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide text-dim">
          Open jobs <span className="rounded-full bg-panel px-2 py-0.5 text-xs">{openJobs.length}</span>
        </h2>
        {!isTechnician && (
          <Button variant="secondary" onClick={() => setReportOpen(true)}>
            <Plus size={16} /> Report breakdown
          </Button>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {openJobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-dim/70 md:col-span-2 xl:col-span-3">
            No open jobs — everything is done or scheduled.
          </div>
        ) : (
          openJobs.map((wo) => {
            const asset = wo.asset_id ? assetById.get(wo.asset_id) : undefined;
            const next = NEXT_STATUS[wo.status];
            return (
              <Card key={wo.id} className="p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <TradeBadge trade={wo.trade} />
                  <PriorityBadge priority={wo.priority} />
                  <SourceBadge source={wo.source} />
                </div>
                <p className="mt-2 text-sm font-semibold leading-snug text-ink">{wo.title}</p>
                {asset ? <p className="mt-1 text-xs text-dim">Asset: {asset.name}</p> : null}
                <p className="mt-1 text-xs text-dim">
                  {STATUS_LABELS[wo.status]}
                  {wo.due_date ? ` · due ${formatDate(wo.due_date)}` : ""}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {next === "done" ? (
                    <Button variant="secondary" className="flex-1 !px-2 !py-1 text-xs" onClick={() => setCloseoutFor(wo)}>
                      Close out
                    </Button>
                  ) : next ? (
                    <Button
                      variant="secondary"
                      className="flex-1 !px-2 !py-1 text-xs"
                      onClick={() => void submitOp({ op: "work_order.update", entity_id: wo.id, client_updated_at: new Date().toISOString(), data: { status: next } })}
                    >
                      {next === "assigned" ? "Take job" : "Start work"}
                    </Button>
                  ) : null}
                  {asset?.meter_unit ? (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setMeterFor(wo)}>
                      Meter
                    </Button>
                  ) : null}
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setEvidenceFor(wo)}>
                    Evidence{evidenceCounts.get(wo.id) ? ` (${evidenceCounts.get(wo.id)})` : ""}
                  </Button>
                </div>
              </Card>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between pt-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-dim">Stock</h2>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-dim/70 md:col-span-2 xl:col-span-3">
            No inventory cached yet — sync once to load it.
          </div>
        ) : (
          items.map((item) => (
            <Card key={item.id} className="flex items-center justify-between p-3">
              <div>
                <p className="text-sm font-semibold text-ink">{item.name}</p>
                <p className="text-xs text-dim">
                  {item.quantity_on_hand} {item.unit ?? "pcs"} on hand
                </p>
              </div>
              <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setStockFor(item)}>
                Use stock
              </Button>
            </Card>
          ))
        )}
      </div>

      {reportOpen ? (
        <OfflineReportModal onClose={() => setReportOpen(false)} onSubmit={submitOp} />
      ) : null}
      {closeoutFor ? (
        <OfflineCloseoutModal
          workOrder={closeoutFor}
          items={items}
          onClose={() => setCloseoutFor(null)}
          onSubmit={submitOp}
        />
      ) : null}
      {meterFor ? (
        <OfflineMeterModal
          workOrder={meterFor}
          asset={meterFor.asset_id ? assetById.get(meterFor.asset_id) : undefined}
          onClose={() => setMeterFor(null)}
          onSubmit={submitOp}
        />
      ) : null}
      {stockFor ? (
        <OfflineStockModal item={stockFor} onClose={() => setStockFor(null)} onSubmit={submitOp} />
      ) : null}
      {evidenceFor ? (
        <OfflineEvidenceModal workOrder={evidenceFor} onClose={() => setEvidenceFor(null)} onSubmit={submitOp} />
      ) : null}
      {conflictOpen ? (
        <ConflictReviewModal
          conflicts={conflicts}
          onClose={() => setConflictOpen(false)}
          onResolved={async () => {
            setConflicts(await cachedConflicts());
          }}
        />
      ) : null}
    </div>
  );
}

// ---- offline report --------------------------------------------------------

function OfflineReportModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (op: SyncOp) => Promise<void> }) {
  const { config } = useConfig();
  const trades = config?.trades?.filter((t) => t.active) ?? BUILTIN_TRADE_OPTIONS;
  const [trade, setTrade] = useState("plumbing");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkOrderPriority>("normal");
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSubmit({
        op: "work_order.create",
        client_id: crypto.randomUUID(),
        client_updated_at: new Date().toISOString(),
        data: { trade, title, description: description || null, priority, source: "breakdown" },
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Report breakdown">
      <p className="-mt-2 mb-4 text-xs text-dim">
        This report is queued locally and syncs the next time the device is online.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <FormField label="Trade">
          <Select value={trade} onChange={(e) => setTrade(e.target.value)}>
            {trades.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Leak under sink in unit 4B" required />
        </FormField>
        <FormField label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What's happening, and where?" />
        </FormField>
        <FormField label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as WorkOrderPriority)}>
            {(Object.keys(PRIORITIES) as WorkOrderPriority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITIES[p].label}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Queueing…" : "Queue report"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---- offline closeout ------------------------------------------------------

function OfflineCloseoutModal({
  workOrder,
  items,
  onClose,
  onSubmit,
}: {
  workOrder: WorkOrder;
  items: InventoryItem[];
  onClose: () => void;
  onSubmit: (op: SyncOp) => Promise<void>;
}) {
  const [failureCode, setFailureCode] = useState<FailureCode>("wear_and_tear");
  const [rootCause, setRootCause] = useState("");
  const [remedy, setRemedy] = useState("");
  const [meterValue, setMeterValue] = useState("");
  const [partId, setPartId] = useState("");
  const [partQty, setPartQty] = useState("1");
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const data: Record<string, unknown> = {
        status: "done",
        failure_code: failureCode,
        root_cause: rootCause,
        remedy,
      };
      if (meterValue.trim()) data.meter_value_at_closeout = meterValue.trim();
      if (partId && Number(partQty) > 0) data.parts = [{ item_id: partId, quantity: Number(partQty) }];
      await onSubmit({
        op: "work_order.update",
        entity_id: workOrder.id,
        client_updated_at: new Date().toISOString(),
        data,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Close out work order">
      <p className="-mt-2 mb-4 text-xs text-dim">
        “{workOrder.title}” — record what failed and what you did. Queued if offline; “Fixed” alone is rejected.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <FormField label="Failure code">
          <Select value={failureCode} onChange={(e) => setFailureCode(e.target.value as FailureCode)}>
            {Object.keys(FAILURE_CODES).map((code) => (
              <option key={code} value={code}>
                {FAILURE_CODES[code]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Root cause">
          <Input value={rootCause} onChange={(e) => setRootCause(e.target.value)} placeholder="Seal worn through at the union joint" required />
        </FormField>
        <FormField label="Remedy">
          <Input value={remedy} onChange={(e) => setRemedy(e.target.value)} placeholder="Replaced the 20mm washer, retightened the union" required />
        </FormField>
        <FormField label="Meter reading (optional)">
          <Input type="number" min={0} value={meterValue} onChange={(e) => setMeterValue(e.target.value)} placeholder="e.g. 12850" />
        </FormField>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <FormField label="Part used (optional)">
              <Select value={partId} onChange={(e) => setPartId(e.target.value)}>
                <option value="">— none —</option>
                {items
                  .filter((i) => Number(i.quantity_on_hand) > 0)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.quantity_on_hand})
                    </option>
                  ))}
              </Select>
            </FormField>
          </div>
          <FormField label="Qty">
            <Input type="number" min={1} value={partQty} onChange={(e) => setPartQty(e.target.value)} disabled={!partId} />
          </FormField>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Queueing…" : "Close out"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---- offline meter reading -------------------------------------------------

function OfflineMeterModal({
  workOrder,
  asset,
  onClose,
  onSubmit,
}: {
  workOrder: WorkOrder;
  asset: Asset | undefined;
  onClose: () => void;
  onSubmit: (op: SyncOp) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState(asset?.meter_unit ?? "hours");
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!asset) return;
    setSaving(true);
    try {
      await onSubmit({
        op: "meter_reading.create",
        client_id: crypto.randomUUID(),
        client_updated_at: new Date().toISOString(),
        data: { asset_id: asset.id, reading_value: Number(value), reading_unit: unit },
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Record meter reading">
      <p className="-mt-2 mb-4 text-xs text-dim">
        “{workOrder.title}” — {asset?.name ?? "asset"} · current {asset?.meter_value ?? "?"} {asset?.meter_unit ?? ""}.
        Readings must be monotonic.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <FormField label="Reading">
          <Input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} required />
        </FormField>
        <FormField label="Unit">
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
        </FormField>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !asset}>
            {saving ? "Queueing…" : "Record reading"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---- offline stock usage ---------------------------------------------------

function OfflineStockModal({
  item,
  onClose,
  onSubmit,
}: {
  item: InventoryItem;
  onClose: () => void;
  onSubmit: (op: SyncOp) => Promise<void>;
}) {
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSubmit({
        op: "inventory_movement.create",
        client_id: crypto.randomUUID(),
        client_updated_at: new Date().toISOString(),
        data: { inventory_item_id: item.id, quantity_change: -Number(qty), reason: reason || "Field usage" },
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Use stock">
      <p className="-mt-2 mb-4 text-xs text-dim">
        {item.name} · {item.quantity_on_hand} {item.unit ?? "pcs"} on hand.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Quantity">
            <Input type="number" min={1} max={Number(item.quantity_on_hand)} value={qty} onChange={(e) => setQty(e.target.value)} required />
          </FormField>
          <FormField label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Field usage" />
          </FormField>
        </div>
        {Number(qty) > Number(item.quantity_on_hand) ? <ErrorBanner message="Quantity exceeds stock on hand." /> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || Number(qty) > Number(item.quantity_on_hand)}>
            {saving ? "Queueing…" : "Use stock"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---- offline evidence ------------------------------------------------------

const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

function OfflineEvidenceModal({
  workOrder,
  onClose,
  onSubmit,
}: {
  workOrder: WorkOrder;
  onClose: () => void;
  onSubmit: (op: SyncOp) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return setError("Pick a photo or video first.");
    if (file.size > MAX_EVIDENCE_BYTES) return setError("File exceeds the 20MB limit.");
    setBusy(true);
    setError("");
    try {
      const dataBase64 = await readFileAsBase64(file);
      await onSubmit({
        op: "document.create",
        client_id: crypto.randomUUID(),
        data: {
          entity_type: "work_order",
          entity_id: workOrder.id,
          file_name: file.name,
          content_type: file.type || undefined,
          data_base64: dataBase64,
        },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue the file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add evidence">
      <p className="-mt-2 mb-4 text-xs text-dim">
        “{workOrder.title}” — attach a photo or video of the job. Queued locally; it syncs (and shows up as a
        document on the work order) the next time the device is online.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <FormField label="Photo or video">
          <Input type="file" accept="image/*,video/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </FormField>
        {file ? (
          <p className="text-xs text-dim">
            {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
            {file.size > MAX_EVIDENCE_BYTES ? <span className="font-semibold text-amber"> — exceeds 20MB</span> : ""}
          </p>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !file || file.size > MAX_EVIDENCE_BYTES}>
            {busy ? "Queueing…" : "Queue evidence"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---- conflict review --------------------------------------------------------

const OP_LABELS: Record<string, string> = {
  "work_order.create": "Reported breakdown",
  "work_order.update": "Work order change",
  "meter_reading.create": "Meter reading",
  "inventory_movement.create": "Stock adjustment",
  "asset.update": "Asset update",
  "document.create": "Evidence upload",
};

function ConflictReviewModal({
  conflicts,
  onClose,
  onResolved,
}: {
  conflicts: Conflict[];
  onClose: () => void;
  onResolved: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (conflicts.length === 0) onClose();
  }, [conflicts.length, onClose]);

  async function act(c: Conflict, keep: boolean) {
    setBusyId(c.id ?? null);
    setError("");
    try {
      if (keep) await keepConflict(c);
      else await discardConflict(c);
      await onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resolve the conflict");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal open onClose={onClose} title="Sync conflicts">
      <p className="-mt-2 mb-4 text-xs text-dim">
        These changes were skipped because the server had a newer version. Keep mine re-applies your change as the
        latest; accept server keeps the server's version.
      </p>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="space-y-3">
        {conflicts.map((c) => (
          <div key={c.id} className="rounded-lg border border-line bg-panel p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-ink">{OP_LABELS[c.op] ?? c.op}</p>
              <span className="rounded-full bg-amber/10 px-2 py-0.5 text-xs font-semibold text-amber">
                {c.conflict_reason}
              </span>
            </div>
            {c.entity_id ? <p className="mt-1 text-xs text-dim">Work order: {c.entity_id}</p> : null}
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                className="!px-2 !py-1 text-xs"
                disabled={busyId !== null}
                onClick={() => void act(c, false)}
              >
                Accept server
              </Button>
              <Button className="!px-2 !py-1 text-xs" disabled={busyId !== null} onClick={() => void act(c, true)}>
                Keep mine
              </Button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="ghost" onClick={onClose} disabled={busyId !== null}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
