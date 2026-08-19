import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Archive, ArchiveRestore, Paperclip, Plus, Trash2 } from "lucide-react";
import type { FailureCode, Trade, WorkOrder, WorkOrderPriority, WorkOrderStatus } from "../lib/types";
import { BUILTIN_TRADE_OPTIONS, FAILURE_CODES, PRIORITIES, formatCost, formatDate } from "../lib/format";
import { PriorityBadge, SourceBadge, TradeBadge } from "../components/Badges";
import { Button, Card, ErrorBanner, Field, Input, Modal, Select, Spinner, Textarea } from "../components/ui";
import DocumentAttachments from "../components/DocumentAttachments";
import { useFetch } from "../lib/useFetch";
import { api, ApiError, download } from "../lib/api";
import { useConfig } from "../context/ConfigContext";
import { useAuth } from "../context/AuthContext";

interface WorkOrderPage {
  data: WorkOrder[];
  meta: { total: number; limit: number; offset: number };
}

const COLUMNS: { status: WorkOrderStatus; label: string }[] = [
  { status: "open", label: "Open" },
  { status: "assigned", label: "Assigned" },
  { status: "in_progress", label: "In progress" },
  { status: "done", label: "Done" },
];

const NEXT_STATUS: Partial<Record<WorkOrderStatus, WorkOrderStatus>> = {
  open: "assigned",
  assigned: "in_progress",
  in_progress: "done",
};

// Cancellation is a management decision — only admins/managers see the action,
// and only while a work order is still in flight (open/assigned/in_progress).
const CANCELABLE: WorkOrderStatus[] = ["open", "assigned", "in_progress"];

const FILTERS: { value: WorkOrderStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "assigned", label: "Assigned" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

export default function WorkOrders() {
  const { user } = useAuth();
  const canCancel = user?.role === "admin" || user?.role === "manager";
  const isAdmin = user?.role === "admin";
  const [filter, setFilter] = useState<WorkOrderStatus | "all">("all");
  const [showArchived, setShowArchived] = useState(false);
  const { data, loading, error, reload } = useFetch<WorkOrderPage>("/work-orders", {
    limit: 200,
    archived: showArchived ? 1 : undefined,
  });
  const [reporting, setReporting] = useState(false);
  const [closing, setClosing] = useState<WorkOrder | null>(null);
  const [cancelling, setCancelling] = useState<WorkOrder | null>(null);
  const [deleting, setDeleting] = useState<WorkOrder | null>(null);
  const [attachments, setAttachments] = useState<WorkOrder | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function exportCsv() {
    setExporting(true);
    try {
      await download("/reports/work-orders?format=csv", "work-orders.csv");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const grouped = useMemo(() => {
    // "All" shows the live board (open → in_progress → done); a specific
    // filter isolates one lane, including Cancelled (which the board hides).
    const statuses = filter === "all" ? COLUMNS.map((c) => c.status) : [filter];
    const map = new Map<WorkOrderStatus, WorkOrder[]>();
    for (const s of statuses) map.set(s, []);
    for (const wo of data?.data ?? []) {
      if (map.has(wo.status)) map.get(wo.status)!.push(wo);
    }
    return map;
  }, [data, filter]);

  async function advance(wo: WorkOrder) {
    const next = NEXT_STATUS[wo.status];
    if (!next) return;
    setActionError(null);
    // Phase 8: closing a work order requires structured closeout data — open
    // the modal instead of blindly flipping the status.
    if (next === "done") {
      setClosing(wo);
      return;
    }
    try {
      await api.patch(`/work-orders/${wo.id}`, { status: next });
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Update failed");
    }
  }

  function cancel(wo: WorkOrder) {
    setActionError(null);
    setCancelling(wo);
  }

  async function archiveAll(status: WorkOrderStatus) {
    setActionError(null);
    try {
      await api.post("/work-orders/archive", { status });
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Archive failed");
    }
  }

  async function restore(wo: WorkOrder) {
    setActionError(null);
    try {
      await api.patch(`/work-orders/${wo.id}`, { archive: false });
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Restore failed");
    }
  }

  async function deleteForever(wo: WorkOrder) {
    setActionError(null);
    try {
      await api.del(`/work-orders/${wo.id}`);
      setDeleting(null);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  if (loading) return <Spinner />;
  if (error) return <Card className="p-4 text-danger">{error}</Card>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">Work orders</h1>
          <p className="text-sm text-dim">Drag-free status board — click a card to advance it.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={exportCsv} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          <Button onClick={() => setReporting(true)}>
            <Plus size={16} /> Report breakdown
          </Button>
        </div>
      </div>

      {actionError ? <ErrorBanner message={actionError} /> : null}

      <div className="flex flex-wrap gap-1 rounded-lg bg-bg p-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => {
              setFilter(f.value);
              if (f.value === "all" || !["done", "verified", "cancelled"].includes(f.value)) setShowArchived(false);
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
              filter === f.value ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
            }`}
          >
            {f.label}
          </button>
        ))}
        {isAdmin && filter !== "all" && ["done", "verified", "cancelled"].includes(filter) ? (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
              showArchived ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
            }`}
          >
            <Archive size={14} /> {showArchived ? "Hide archived" : "Show archived"}
          </button>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[...grouped.keys()].map((status) => {
          const label = STATUS_LABELS[status];
          const items = grouped.get(status) ?? [];
          return (
            <div key={status} className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-bold uppercase tracking-wide text-dim">{label}</h2>
                <div className="flex items-center gap-2">
                  {isAdmin && !showArchived && ["done", "verified", "cancelled"].includes(status) ? (
                    <button
                      onClick={() => archiveAll(status)}
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold text-dim hover:text-ink"
                    >
                      <Archive size={12} /> Archive all
                    </button>
                  ) : null}
                  <span className="rounded-full bg-panel px-2 py-0.5 text-xs font-semibold text-dim">{items.length}</span>
                </div>
              </div>
              <div className="space-y-3">
                {items.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-line p-3 text-center text-xs text-dim/70">
                    Nothing here
                  </div>
                ) : (
                  items.map((wo) => (
                    <Card key={wo.id} className="p-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <TradeBadge trade={wo.trade} />
                        <PriorityBadge priority={wo.priority} />
                        {wo.auto_assigned ? (
                          <span className="inline-flex items-center rounded-full bg-amber/15 px-2 py-0.5 text-xs font-semibold text-amber">
                            Auto-assigned
                          </span>
                        ) : null}
                        <button
                          type="button"
                          title="Attachments"
                          className="ml-auto rounded p-1 text-dim transition-colors hover:bg-panel-2 hover:text-ink"
                          onClick={() => setAttachments(wo)}
                        >
                          <Paperclip size={14} />
                        </button>
                      </div>
                      <p className="mt-2 text-sm font-semibold leading-snug text-ink">{wo.title}</p>
                      {wo.description ? (
                        <p className="mt-1 line-clamp-2 text-xs text-dim">{wo.description}</p>
                      ) : null}
                      {wo.failure_code ? (
                        <p className="mt-1 text-xs text-dim">
                          Failure:{" "}
                          <span className="font-semibold text-amber">{FAILURE_CODES[wo.failure_code] ?? wo.failure_code}</span>
                        </p>
                      ) : null}
                      <div className="mt-2 flex items-center justify-between text-xs text-dim">
                        <span>
                          <SourceBadge source={wo.source} /> {wo.due_date ? ` · ${formatDate(wo.due_date)}` : ""}
                        </span>
                        <span>{wo.cost ? formatCost(wo.cost) : ""}</span>
                      </div>
                      {wo.status === "cancelled" ? (
                        <p className="mt-1 text-xs text-dim">
                          <span className="font-semibold text-danger">Cancelled</span>
                          {wo.cancelled_by_name ? ` by ${wo.cancelled_by_name}` : ""}
                          {wo.cancelled_at ? ` · ${formatDate(wo.cancelled_at)}` : ""}
                          {wo.cancellation_reason ? ` — ${wo.cancellation_reason}` : ""}
                        </p>
                      ) : null}
                      {showArchived && isAdmin ? (
                        <div className="mt-3 flex gap-2">
                          <Button variant="secondary" className="flex-1 !px-2 !py-1 text-xs" onClick={() => restore(wo)}>
                            <ArchiveRestore size={12} /> Restore
                          </Button>
                          <Button variant="ghost" className="!px-2 !py-1 text-xs text-danger" onClick={() => setDeleting(wo)}>
                            <Trash2 size={12} /> Delete permanently
                          </Button>
                        </div>
                      ) : (
                        <div className="mt-3 flex gap-2">
                          {NEXT_STATUS[wo.status] ? (
                            <Button variant="secondary" className="flex-1 !px-2 !py-1 text-xs" onClick={() => advance(wo)}>
                              Advance to {STATUS_LABELS[NEXT_STATUS[wo.status]!]}
                            </Button>
                          ) : null}
                          {canCancel && CANCELABLE.includes(wo.status) ? (
                            <Button variant="ghost" className="!px-2 !py-1 text-xs text-danger" onClick={() => cancel(wo)}>
                              Cancel
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </Card>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {reporting ? (
        <ReportBreakdown onClose={() => setReporting(false)} onDone={() => { setReporting(false); reload(); }} />
      ) : null}

      {closing ? (
        <CloseoutModal
          workOrder={closing}
          onClose={() => setClosing(null)}
          onDone={() => { setClosing(null); reload(); }}
        />
      ) : null}

      {cancelling ? (
        <CancelModal
          workOrder={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => { setCancelling(null); reload(); }}
        />
      ) : null}

      {deleting ? (
        <DeleteForeverModal
          workOrder={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => deleteForever(deleting)}
        />
      ) : null}

      {attachments ? (
        <Modal open onClose={() => setAttachments(null)} title="Attachments">
          <p className="-mt-2 mb-4 text-xs text-dim">
            “{attachments.title}” — before/after photos, permits and notes live here for the whole crew.
          </p>
          <DocumentAttachments entityType="work_order" entityId={attachments.id} />
        </Modal>
      ) : null}
    </div>
  );
}

const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  open: "Open",
  assigned: "Assigned",
  in_progress: "In progress",
  done: "Done",
  verified: "Verified",
  cancelled: "Cancelled",
};

function ReportBreakdown({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { config } = useConfig();
  const trades = config?.trades?.filter((t) => t.active) ?? BUILTIN_TRADE_OPTIONS;
  const [trade, setTrade] = useState<Trade>("general");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkOrderPriority>("normal");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post("/work-orders", {
        trade,
        title,
        description: description || null,
        priority,
        source: "breakdown",
      });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setError(err.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
      } else {
        setError(err instanceof Error ? err.message : "Could not create work order");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Report breakdown">
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Trade">
          <Select value={trade} onChange={(e) => setTrade(e.target.value as Trade)}>
            {trades.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Leak under sink in unit 4B" required />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What's happening, and where?" />
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as WorkOrderPriority)}>
            {(Object.keys(PRIORITIES) as WorkOrderPriority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITIES[p].label}
              </option>
            ))}
          </Select>
        </Field>

        {error ? <ErrorBanner message={error} /> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Creating…" : "Create work order"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// Phase 8 closeout: "mandatory-but-short" prompts that turn a completion into
// structured reliability data. The backend rejects throwaway answers.
function CloseoutModal({ workOrder, onClose, onDone }: { workOrder: WorkOrder; onClose: () => void; onDone: () => void }) {
  const [failureCode, setFailureCode] = useState<FailureCode>("wear_and_tear");
  const [rootCause, setRootCause] = useState("");
  const [remedy, setRemedy] = useState("");
  const [partsUsed, setPartsUsed] = useState("");
  const [meterValue, setMeterValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        status: "done",
        failure_code: failureCode,
        root_cause: rootCause,
        remedy,
      };
      if (partsUsed.trim()) body.parts_used = partsUsed.trim();
      if (meterValue.trim()) body.meter_value_at_closeout = meterValue.trim();
      await api.patch(`/work-orders/${workOrder.id}`, body);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setError(err.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
      } else {
        setError(err instanceof Error ? err.message : "Could not close work order");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Close work order">
      <p className="-mt-2 mb-4 text-xs text-dim">
        “{workOrder.title}” — record what failed and what you did so reliability reports
        aren't based on “fixed”. “Fixed”, “done”, and “other” alone get rejected.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Failure code">
          <Select value={failureCode} onChange={(e) => setFailureCode(e.target.value as FailureCode)}>
            {Object.keys(FAILURE_CODES).map((code) => (
              <option key={code} value={code}>
                {FAILURE_CODES[code]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Root cause">
          <Input
            value={rootCause}
            onChange={(e) => setRootCause(e.target.value)}
            placeholder="Seal worn through at the union joint"
            required
          />
        </Field>
        <Field label="Remedy">
          <Input
            value={remedy}
            onChange={(e) => setRemedy(e.target.value)}
            placeholder="Replaced the 20mm washer, retightened the union"
            required
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Parts used (optional)">
            <Input value={partsUsed} onChange={(e) => setPartsUsed(e.target.value)} placeholder="Washer 20mm ×2" />
          </Field>
          <Field label="Meter reading (optional)">
            <Input
              type="number"
              min={0}
              value={meterValue}
              onChange={(e) => setMeterValue(e.target.value)}
              placeholder="e.g. 12850"
            />
          </Field>
        </div>

        {error ? <ErrorBanner message={error} /> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Closing…" : "Close work order"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// Cancellation audit — admin/manager only (UI gates it, the API enforces it).
// The reason is mandatory so the record says *why*, and the cancelled_by / at
// stamps come from the server.
function CancelModal({ workOrder, onClose, onDone }: { workOrder: WorkOrder; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.patch(`/work-orders/${workOrder.id}`, { status: "cancelled", cancellation_reason: reason.trim() });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setError(err.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
      } else {
        setError(err instanceof Error ? err.message : "Could not cancel work order");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Cancel work order">
      <p className="-mt-2 mb-4 text-xs text-dim">
        “{workOrder.title}” will be marked cancelled and frozen. The reporter is notified, and the
        reason below is recorded for the audit trail.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Reason for cancellation">
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Tenant no longer wants the work — resolved between parties"
            required
          />
        </Field>

        {error ? <ErrorBanner message={error} /> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Cancelling…" : "Cancel work order"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// Permanent delete — only reachable from the archived view. The backend
// requires the order to be archived first, so this is the deliberate second
// step after "Archive all" (soft, undoable) is taken.
function DeleteForeverModal({ workOrder, onClose, onConfirm }: { workOrder: WorkOrder; onClose: () => void; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Modal open onClose={onClose} title="Delete permanently?">
      <p className="-mt-2 mb-4 text-xs text-dim">
        “{workOrder.title}” will be removed for good. Quotes for it cascade away, and permit / inventory
        links are unlinked. Reliability history for this order is lost — this cannot be undone.
      </p>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onClose}>
          Keep it
        </Button>
        <Button type="button" disabled={confirming} className="!bg-danger hover:!bg-danger/90" onClick={() => { setConfirming(true); onConfirm(); }}>
          <Trash2 size={14} /> {confirming ? "Deleting…" : "Delete permanently"}
        </Button>
      </div>
    </Modal>
  );
}
