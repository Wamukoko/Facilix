import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Bell,
  ChevronRight,
  ClipboardCheck,
  DollarSign,
  FileText,
  LogOut,
  MapPin,
  Send,
} from "lucide-react";
import type { Document, Invoice, Notification, WorkOrder } from "../lib/types";
import { formatDate, titleCase } from "../lib/format";
import { PriorityBadge, StatusBadge, TradeBadge } from "../components/Badges";
import { Button, Card, EmptyState, ErrorBanner, Field, Input, Modal, Select, Spinner, Textarea } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { useFetch } from "../lib/useFetch";
import { api, upload } from "../lib/api";

// Phase 19 — contractor self-service portal. Tabbed layout with four views:
// Jobs (available + assigned), Bids (my quotes + status), Invoices, Updates.
// Suppliers can update status on assigned jobs and submit structured closeouts.

type PortalTab = "jobs" | "bids" | "invoices" | "notifications";

interface WorkOrderPage {
  data: WorkOrder[];
  meta: { total: number; limit: number; offset: number };
}

interface Scorecard {
  total_quotes: number;
  accepted_quotes: number;
  avg_accepted_amount: number | string;
  open_jobs: number;
  completed_jobs: number;
  sla_breached_jobs: number;
}

interface Quote {
  id: string;
  supplier_id: string;
  supplier_name: string;
  work_order_id: string;
  work_order_title: string;
  work_order_status: string;
  amount: string;
  currency: string;
  note: string | null;
  status: string;
  created_at: string;
}

const FAILURE_CODES = [
  { value: "wear_and_tear", label: "Wear and tear" },
  { value: "lubrication", label: "Lubrication needed" },
  { value: "misalignment", label: "Misalignment" },
  { value: "electrical_fault", label: "Electrical fault" },
  { value: "plumbing_leak", label: "Plumbing leak" },
  { value: "structural", label: "Structural issue" },
  { value: "pest_control", label: "Pest control" },
  { value: "landscaping", label: "Landscaping / gardening" },
  { value: "cleaning", label: "Cleaning / janitorial" },
  { value: "other", label: "Other" },
];

export default function SupplierPortal() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const supplierId = user?.supplier_id;

  const wos = useFetch<WorkOrderPage>("/work-orders", { limit: 200 });
  const scorecard = useFetch<Scorecard>(supplierId ? `/suppliers/${supplierId}/scorecard` : null);
  const quoteData = useFetch<{ data: Quote[] }>(supplierId ? `/suppliers/${supplierId}/quotes` : null);
  const notifData = useFetch<{ data: Notification[]; meta: { total: number; unread: number } }>("/notifications", { limit: 50 });
  const invoiceData = useFetch<{ data: Invoice[] }>("/invoices", { limit: 50 });

  const [tab, setTab] = useState<PortalTab>("jobs");
  const [bidding, setBidding] = useState<WorkOrder | null>(null);
  const [amount, setAmount] = useState("");
  const [quoteFile, setQuoteFile] = useState<File | null>(null);
  const [bidError, setBidError] = useState<string | null>(null);
  const [bidSaving, setBidSaving] = useState(false);

  const [detailWO, setDetailWO] = useState<WorkOrder | null>(null);
  const [closeoutWO, setCloseoutWO] = useState<WorkOrder | null>(null);

  if (!user || !supplierId) {
    return <div className="p-6 text-sm text-dim">{t("supplier.noSupplier")}</div>;
  }

  const all = wos.data?.data ?? [];
  const available = all.filter((w) => w.status === "open");
  const assigned = all.filter((w) => w.assigned_supplier_id === supplierId);
  const activeAssigned = assigned.filter((w) => !["done", "verified", "cancelled"].includes(w.status));
  const sc = scorecard.data;
  const unread = notifData.data?.meta?.unread ?? 0;

  async function submitBid(e: FormEvent) {
    e.preventDefault();
    if (!bidding) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { setBidError("Enter a positive amount"); return; }
    setBidSaving(true);
    setBidError(null);
    try {
      if (quoteFile) {
        await upload("/documents", quoteFile, { entity_type: "work_order", entity_id: bidding.id });
      }
      await api.post(`/work-orders/${bidding.id}/quotes`, { amount: value, note: null });
      setBidding(null);
      setAmount("");
      setQuoteFile(null);
      wos.reload();
    } catch (err) {
      setBidError(err instanceof Error ? err.message : "Failed to submit quote");
    } finally {
      setBidSaving(false);
    }
  }

  const tabs: { id: PortalTab; label: string; badge?: number; icon: React.ReactNode }[] = [
    { id: "jobs", label: t("nav.workOrders"), badge: activeAssigned.length || undefined, icon: <ClipboardCheck size={13} /> },
    { id: "bids", label: t("supplier.myBids"), icon: <DollarSign size={13} /> },
    { id: "invoices", label: t("portal.invoices"), icon: <FileText size={13} /> },
    { id: "notifications", label: t("portal.updates"), badge: unread || undefined, icon: <Bell size={13} /> },
  ];

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="text-lg font-black tracking-tight text-ink">
              Facilix<span className="text-amber">.</span>
            </span>
            <span className="rounded-full bg-amber/15 px-2 py-0.5 text-xs font-semibold text-amber">
              {t("supplier.portal")}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-dim">{user.full_name}</span>
            <button onClick={logout} className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-dim hover:text-ink">
              <LogOut size={14} /> {t("action.signOut")}
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 px-4 pb-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-sm font-semibold transition-colors ${
                tab === t.id ? "bg-bg text-ink" : "text-dim hover:text-ink"
              }`}
            >
              {t.icon} {t.label}
              {t.badge ? (
                <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 py-6">
        {tab === "jobs" ? (
          <JobsTab
            available={available} assigned={assigned} loading={wos.loading} sc={sc ?? undefined}
            onBid={setBidding} onView={setDetailWO} onCloseout={setCloseoutWO}
            onReload={() => wos.reload()}
          />
        ) : tab === "bids" ? (
          <BidsTab data={quoteData} loading={quoteData.loading} />
        ) : tab === "invoices" ? (
          <InvoicesTab data={invoiceData} loading={invoiceData.loading} />
        ) : (
          <NotificationsTab data={notifData} />
        )}
      </main>

      <Modal open={!!bidding} title={`Quote: ${bidding?.title ?? ""}`} onClose={() => { setBidding(null); setAmount(""); setQuoteFile(null); }}>
        {bidError ? <ErrorBanner message={bidError} /> : null}
        <form onSubmit={submitBid} className="space-y-4">
          <Field label={t("supplier.yourPrice")}>
            <Input type="number" min="0" step="100" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Field>
          <Field label={t("supplier.quoteDoc")}>
            <Input type="file" onChange={(e) => setQuoteFile(e.target.files?.[0] ?? null)} />
          </Field>
          {quoteFile ? (
            <p className="text-xs text-dim">{quoteFile.name} · {(quoteFile.size / 1024 / 1024).toFixed(1)} MB</p>
          ) : (
            <p className="text-xs text-dim">Attach breakdowns, site photos, or quote letters.</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setBidding(null); setAmount(""); setQuoteFile(null); }} disabled={bidSaving}>Cancel</Button>
            <Button type="submit" disabled={bidSaving}>{bidSaving ? t("supplier.submitting") : t("supplier.submitQuote")}</Button>
          </div>
        </form>
      </Modal>

      {detailWO ? <WODetailModal workOrder={detailWO} onClose={() => setDetailWO(null)} /> : null}
      {closeoutWO ? <CloseoutModal workOrder={closeoutWO} onClose={() => setCloseoutWO(null)} onDone={() => { setCloseoutWO(null); wos.reload(); }} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jobs tab — available to bid + assigned jobs with actions
// ---------------------------------------------------------------------------

function JobsTab({ available, assigned, loading, sc, onBid, onView, onCloseout }: {
  available: WorkOrder[]; assigned: WorkOrder[]; loading: boolean; sc?: Scorecard;
  onBid: (w: WorkOrder) => void; onView: (w: WorkOrder) => void; onCloseout: (w: WorkOrder) => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("supplier.activeJobs")} value={assigned.filter((w) => !["done", "verified", "cancelled"].includes(w.status)).length} />
        <Stat label={t("supplier.quotesSubmitted")} value={sc?.total_quotes ?? "—"} />
        <Stat label={t("supplier.quotesAccepted")} value={sc?.accepted_quotes ?? "—"} />
        <Stat label={t("supplier.completed")} value={sc?.completed_jobs ?? "—"} />
      </div>

      {available.length > 0 ? (
        <Card className="overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-bold text-ink">{t("supplier.availableToBid")}</h2>
            <p className="text-xs text-dim">{t("supplier.availableDesc")}</p>
          </div>
          <ul className="divide-y divide-line">
            {available.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <button onClick={() => onView(w)} className="min-w-0 text-left">
                  <p className="truncate text-sm font-medium text-ink">{w.title}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-dim">
                    <TradeBadge trade={w.trade} /> <PriorityBadge priority={w.priority} />
                    {w.sla_breached ? <span className="font-semibold text-danger">{t("supplier.slaBreach")}</span> : null}
                    <span>{formatDate(w.created_at)}</span>
                  </p>
                </button>
                <Button onClick={() => onBid(w)} className="shrink-0"><Send size={14} /> {t("supplier.quote")}</Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-bold text-ink">{t("supplier.assignedJobs")}</h2>
          <p className="text-xs text-dim">{assigned.length ? `${assigned.length} total` : t("supplier.noJobsYet")}</p>
        </div>
        {loading ? (
          <div className="p-4"><Spinner /></div>
        ) : assigned.length === 0 ? (
          <EmptyState title={t("supplier.noJobsYet")} body={t("supplier.noJobsAssignedBody")} />
        ) : (
          <ul className="divide-y divide-line">
            {assigned.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <button onClick={() => onView(w)} className="min-w-0 text-left">
                  <p className="truncate text-sm font-medium text-ink">{w.title}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-dim">
                    <TradeBadge trade={w.trade} /> <PriorityBadge priority={w.priority} /> <StatusBadge status={w.status} />
                    {w.sla_breached ? <span className="font-semibold text-danger">{t("supplier.slaBreach")}</span> : null}
                  </p>
                  {w.description ? <p className="mt-1 line-clamp-2 text-xs text-dim">{w.description}</p> : null}
                  {w.sla_due_at && !["done", "verified", "cancelled"].includes(w.status) ? (
                    <p className="mt-1 text-xs text-dim">{t("supplier.due")} {formatDate(w.sla_due_at)}</p>
                  ) : null}
                </button>
                <div className="shrink-0 space-y-2 text-right">
                  <ChevronRight size={16} className="inline text-dim" />
                  {w.status === "assigned" ? (
                    <button onClick={() => onCloseout({ ...w, status: "in_progress" })} className="block text-xs font-semibold text-amber hover:underline">
                      {t("supplier.startJob")}
                    </button>
                  ) : w.status === "in_progress" ? (
                    <button onClick={() => onCloseout(w)} className="block text-xs font-semibold text-gardening hover:underline">
                      {t("supplier.complete")}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Work order detail modal — full info + documents
// ---------------------------------------------------------------------------

function WODetailModal({ workOrder: w, onClose }: { workOrder: WorkOrder; onClose: () => void }) {
  const { t } = useI18n();
  const [docs, setDocs] = useState<Document[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<Document[]>("/documents", { entity_type: "work_order", entity_id: w.id });
        if (!cancelled) setDocs(Array.isArray(res) ? res : []);
      } catch { /* swallow */ }
      if (!cancelled) setDocsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [w.id]);

  const isImage = (ct: string | null) => ct?.startsWith("image/");
  const isVideo = (ct: string | null) => ct?.startsWith("video/");

  return (
    <Modal open onClose={onClose} title={t("supplier.workOrderDetails")}>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-bold text-ink">{w.title}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <TradeBadge trade={w.trade} />
            <PriorityBadge priority={w.priority} />
            <StatusBadge status={w.status} />
          </p>
        </div>
        {w.description ? <p className="text-sm text-ink">{w.description}</p> : null}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div><span className="text-dim">{t("supplier.filed")}</span> <span className="text-ink">{formatDate(w.created_at)}</span></div>
          {w.completed_at ? <div><span className="text-dim">{t("supplier.completedLabel")}</span> <span className="text-ink">{formatDate(w.completed_at)}</span></div> : null}
          {w.sla_due_at ? <div><span className="text-dim">{t("supplier.slaDue")}</span> <span className="text-ink">{formatDate(w.sla_due_at)}</span></div> : null}
          {w.sla_breached ? <div className="text-danger font-semibold">{t("supplier.slaBreach")}</div> : null}
          {w.cost ? <div><span className="text-dim">{t("supplier.cost")}</span> <span className="text-ink">KES {Number(w.cost).toLocaleString()}</span></div> : null}
          {w.failure_code ? <div><span className="text-dim">{t("supplier.rootCauseLabel")}</span> <span className="text-ink">{titleCase(w.failure_code)}</span></div> : null}
          {w.root_cause ? <div className="col-span-2"><span className="text-dim">{t("supplier.rootCauseDetail")}</span> <span className="text-ink">{w.root_cause}</span></div> : null}
          {w.remedy ? <div className="col-span-2"><span className="text-dim">{t("supplier.remedyLabel")}</span> <span className="text-ink">{w.remedy}</span></div> : null}
        </div>
        {w.latitude != null && w.longitude != null ? (
          <p className="flex items-center gap-1.5 text-xs text-dim">
            <MapPin size={12} className="text-amber" />
            {Number(w.latitude).toFixed(4)}, {Number(w.longitude).toFixed(4)}
          </p>
        ) : null}
        <div>
          <h4 className="mb-2 text-xs font-bold text-ink">{t("supplier.attachments")}</h4>
          {docsLoading ? <Spinner /> : docs.length === 0 ? (
            <p className="text-xs text-dim">{t("supplier.noFiles")}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {docs.map((d) => (
                <div key={d.id} className="overflow-hidden rounded-lg border border-line bg-bg">
                  {isImage(d.content_type) ? (
                    <img src={`/api${d.file_url}`} alt={d.file_name} className="aspect-video w-full object-cover" loading="lazy" />
                  ) : isVideo(d.content_type) ? (
                    <video src={`/api${d.file_url}`} controls className="aspect-video w-full object-cover" preload="metadata" />
                  ) : (
                    <div className="flex aspect-video items-center justify-center"><FileText size={24} className="text-dim" /></div>
                  )}
                  <p className="truncate px-2 py-1 text-[10px] text-dim">{d.file_name}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Closeout modal — structured closeout or status advance
// ---------------------------------------------------------------------------

function CloseoutModal({ workOrder: w, onClose, onDone }: { workOrder: WorkOrder; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const isStart = w.status === "assigned";
  const [status, setStatus] = useState(isStart ? "in_progress" : "done");
  const [failureCode, setFailureCode] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [remedy, setRemedy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, string> = { status };
      if (status === "done" || status === "verified") {
        body.failure_code = failureCode;
        body.root_cause = rootCause.trim();
        body.remedy = remedy.trim();
      }
      await api.patch(`/work-orders/${w.id}`, body);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update work order");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isStart ? t("supplier.startJobTitle") : t("supplier.completeTitle")}>
      <p className="-mt-2 mb-3 text-xs text-dim">{w.title}</p>
      {error ? <ErrorBanner message={error} /> : null}
      <form onSubmit={onSubmit} className="space-y-4">
        {!isStart ? (
          <>
            <Field label={t("supplier.statusLabel")}>
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="done">{t("supplier.done")}</option>
                <option value="in_progress">{t("supplier.inProgress")}</option>
              </Select>
            </Field>
            {status === "done" ? (
              <>
                <Field label={t("supplier.failureCode")}>
                  <Select value={failureCode} onChange={(e) => setFailureCode(e.target.value)} required>
                    <option value="">{t("supplier.selectCode")}</option>
                    {FAILURE_CODES.map((fc) => <option key={fc.value} value={fc.value}>{fc.label}</option>)}
                  </Select>
                </Field>
                <Field label={t("supplier.rootCause")}>
                  <Textarea rows={3} value={rootCause} onChange={(e) => setRootCause(e.target.value)} placeholder="e.g. Worn washer allowing drip at isolation valve" required />
                </Field>
                <Field label={t("supplier.remedy")}>
                  <Textarea rows={3} value={remedy} onChange={(e) => setRemedy(e.target.value)} placeholder="e.g. Replaced 20mm washer, tightened union, tested for 10 min" required />
                </Field>
              </>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-ink">Confirm you're starting work on this job. Update status to "in progress".</p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : isStart ? t("supplier.startJob") : "Submit closeout"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bids tab — my quotes + their status
// ---------------------------------------------------------------------------

function BidsTab({ data, loading }: { data: any; loading: boolean }) {
  const { t } = useI18n();
  const quotes: Quote[] = data?.data?.data ?? [];

  return (
    <>
      <div>
        <h1 className="text-xl font-bold text-ink">{t("supplier.myBids")}</h1>
        <p className="text-sm text-dim">{t("supplier.myBidsDesc")}</p>
      </div>
      {loading ? (
        <Spinner />
      ) : quotes.length === 0 ? (
        <EmptyState title={t("supplier.noBids")} body={t("supplier.noBidsBody")} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
          {quotes.map((q) => (
            <li key={q.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-ink">{q.work_order_title}</p>
                  <p className="mt-0.5 text-xs text-dim">{q.supplier_name} · {formatDate(q.created_at)}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-ink">KES {Number(q.amount).toLocaleString()}</p>
                  <span className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                    q.status === "accepted" ? "bg-gardening/20 text-gardening" :
                    q.status === "rejected" ? "bg-danger/20 text-danger" :
                    "bg-amber/20 text-amber"
                  }`}>{q.status}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Invoices tab
// ---------------------------------------------------------------------------

function InvoicesTab({ data, loading }: { data: any; loading: boolean }) {
  const { t } = useI18n();
  const items: Invoice[] = data?.data?.data ?? [];

  return (
    <>
      <div>
        <h1 className="text-xl font-bold text-ink">{t("portal.invoices")}</h1>
        <p className="text-sm text-dim">{t("supplier.invoicesDesc")}</p>
      </div>
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title={t("supplier.noInvoices")} body={t("supplier.noInvoicesBody")} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
          {items.map((inv) => (
            <li key={inv.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-ink">{inv.invoice_number}</p>
                  {inv.work_order_title ? <p className="mt-0.5 text-xs text-dim">{inv.work_order_title}</p> : null}
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-ink">KES {Number(inv.amount).toLocaleString()}</p>
                  <span className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                    inv.status === "paid" ? "bg-gardening/20 text-gardening" :
                    inv.status === "void" ? "bg-dim/20 text-dim" :
                    "bg-amber/20 text-amber"
                  }`}>{inv.status}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Notifications tab
// ---------------------------------------------------------------------------

function NotificationsTab({ data }: { data: any }) {
  const { t } = useI18n();
  const items: Notification[] = data?.data?.data ?? [];

  async function markRead(id: string) {
    try { await api.patch(`/notifications/${id}/read`); data.reload(); } catch { /* swallow */ }
  }

  return (
    <>
      <div>
        <h1 className="text-xl font-bold text-ink">{t("portal.updates")}</h1>
        <p className="text-sm text-dim">{t("supplier.updatesDesc")}</p>
      </div>
      {data?.loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title={t("supplier.noUpdates")} body={t("supplier.noUpdatesBody")} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
          {items.map((n) => (
            <li key={n.id} className={`flex items-start gap-3 px-4 py-3 ${!n.read ? "bg-amber/5" : ""}`}>
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${!n.read ? "font-semibold text-ink" : "text-ink"}`}>{n.title}</p>
                <p className="mt-0.5 text-xs text-dim">{n.body}</p>
                <p className="mt-1 text-[10px] text-dim">{formatDate(n.created_at)}</p>
              </div>
              {!n.read ? (
                <button onClick={() => markRead(n.id)} className="shrink-0 rounded-lg border border-line px-2 py-1 text-[10px] font-semibold text-dim hover:text-ink">
                  {t("action.markRead")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-3 py-2">
      <div className="text-xl font-bold text-ink">{value}</div>
      <div className="text-xs text-dim">{label}</div>
    </div>
  );
}
