import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  AudioLines,
  Bell,
  Camera,
  ChevronRight,
  Crosshair,
  FileText,
  Loader2,
  LogOut,
  MapPin,
  Paperclip,
  QrCode,
  Send,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import type { Document, Invoice, Notification, Paged, Trade, WorkOrder, WorkOrderPriority, TriageSuggestion } from "../lib/types";
import { formatDate, titleCase, BUILTIN_TRADE_OPTIONS } from "../lib/format";
import { PriorityBadge, StatusBadge, TradeBadge } from "../components/Badges";
import { Button, Card, EmptyState, ErrorBanner, Field, Input, Modal, Select, Spinner, Textarea } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { useConfig } from "../context/ConfigContext";
import { useFetch } from "../lib/useFetch";
import { api, upload } from "../lib/api";
import { parseTagPayload } from "../lib/scan";
import ScanTagModal from "../components/ScanTagModal";
import VoiceRecorder from "../components/VoiceRecorder";

// Phase 17 — Resident mobile self-service portal. Tabbed layout with four
// sections: Report, My Requests, Notifications, and Invoices. Request detail
// modal shows attached documents, status timeline, and technician info.

type PortalTab = "report" | "requests" | "notifications" | "invoices";

interface StagedMedia {
  id: string;
  file: File;
  kind: "photo" | "video" | "voice";
  durationMs?: number;
  url?: string;
}

function mediaLabel(m: StagedMedia) {
  if (m.kind === "voice") return m.durationMs ? `Voice note · ${(m.durationMs / 1000).toFixed(0)}s` : "Voice note";
  return m.kind === "video" ? "Video" : "Photo";
}

export default function TenantPortal() {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const { config } = useConfig();
  const trades = config?.trades?.filter((t) => t.active) ?? BUILTIN_TRADE_OPTIONS;

  const requests = useFetch<Paged<WorkOrder>>("/work-orders", { limit: 100 });
  const notifData = useFetch<{ data: Notification[]; meta: { total: number; unread: number } }>("/notifications", { limit: 50 });
  const invoiceData = useFetch<Paged<Invoice>>("/invoices", { limit: 50 });

  const [tab, setTab] = useState<PortalTab>("report");
  const [title, setTitle] = useState("");
  const [trade, setTrade] = useState<string>("general");
  const [priority, setPriority] = useState<WorkOrderPriority>("normal");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const [withdrawing, setWithdrawing] = useState<WorkOrder | null>(null);
  const [detailWO, setDetailWO] = useState<WorkOrder | null>(null);

  const [triage, setTriage] = useState<TriageSuggestion | null>(null);
  const [triageApplied, setTriageApplied] = useState(false);
  const triageTimer = useRef<number | null>(null);

  const [location, setLocation] = useState<{ latitude: number; longitude: number; accuracy: number | null } | null>(null);
  const [locating, setLocating] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [tagApplied, setTagApplied] = useState<string | null>(null);

  const [media, setMedia] = useState<StagedMedia[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const rows = requests.data?.data ?? [];
  const open = rows.filter((w) => !["done", "verified", "cancelled"].includes(w.status));
  const unread = notifData.data?.meta?.unread ?? 0;

  useEffect(() => {
    return () => media.forEach((m) => m.url && URL.revokeObjectURL(m.url));
  }, []);

  useEffect(() => {
    if (triageTimer.current) window.clearTimeout(triageTimer.current);
    setTriageApplied(false);
    const text = `${title} ${description}`.trim();
    if (text.length < 3) { setTriage(null); return; }
    triageTimer.current = window.setTimeout(async () => {
      try {
        const res = await api.post<{ suggestion: TriageSuggestion }>("/triage", { title, description });
        setTriage(res.suggestion?.trade ? res.suggestion : null);
      } catch { setTriage(null); }
    }, 450);
    return () => { if (triageTimer.current) window.clearTimeout(triageTimer.current); };
  }, [title, description]);

  function applyTriage() {
    if (!triage?.trade || !triage.priority) return;
    setTrade(triage.trade);
    setPriority(triage.priority);
    setTriageApplied(true);
  }

  function locate() {
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
          accuracy: pos.coords.accuracy,
        });
        setLocating(false);
      },
      () => { setError("Couldn't get your location — check the browser/device location permission."); setLocating(false); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  function onTag(text: string) {
    const parsed = parseTagPayload(text, trades.map((t) => t.value));
    if (parsed.trade) setTrade(parsed.trade);
    if (parsed.location) {
      setDescription((prev) => {
        const line = `📍 Tag: ${parsed.location}`;
        return prev ? `${prev.trimEnd()}\n${line}` : line;
      });
    }
    setTagApplied(parsed.raw);
    setScanOpen(false);
  }

  function addMedia(file: File, kind: StagedMedia["kind"], durationMs?: number) {
    setMedia((prev) => [
      ...prev,
      { id: crypto.randomUUID(), file, kind, durationMs, url: kind === "photo" ? URL.createObjectURL(file) : undefined },
    ]);
  }

  function removeMedia(id: string) {
    setMedia((prev) => {
      const gone = prev.find((m) => m.id === id);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return prev.filter((m) => m.id !== id);
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    setMediaError(null);
    setSent(false);
    const stagedCount = media.length;
    try {
      const created = await api.post<{ id: string }>("/work-orders", {
        title: title.trim(),
        trade,
        priority,
        description: description.trim() || null,
        source: "tenant_request",
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
      });
      setSent(true);
      setSentCount(stagedCount);
      if (media.length) {
        for (let i = 0; i < media.length; i++) {
          const m = media[i];
          try {
            await upload("/documents", m.file, { entity_type: "work_order", entity_id: created.id });
            setMedia((prev) => prev.filter((x) => x.id !== m.id));
          } catch (err) {
            setMediaError(`Request filed — but "${m.file.name}" failed to upload (${err instanceof Error ? err.message : "network error"}). It's still staged to retry.`);
            break;
          }
        }
      }
      setTitle(""); setDescription(""); setTrade("general"); setPriority("normal");
      setLocation(null); setTagApplied(null); setTriage(null); setTriageApplied(false);
      requests.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not file the request");
    } finally {
      setSaving(false);
    }
  }

  const tabs: { id: PortalTab; label: string; badge?: number }[] = [
    { id: "report", label: t("portal.report") },
    { id: "requests", label: t("portal.myRequests"), badge: open.length || undefined },
    { id: "notifications", label: t("portal.updates"), badge: unread || undefined },
    { id: "invoices", label: t("portal.invoices") },
  ];

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="text-lg font-black tracking-tight text-ink">
              Facilix<span className="text-amber">.</span>
            </span>
            <span className="rounded-full bg-gardening/15 px-2 py-0.5 text-xs font-semibold text-gardening">
              {t("portal.residentPortal")}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-dim">{user?.full_name}</span>
            <button onClick={logout} className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-dim hover:text-ink">
              <LogOut size={14} /> {t("action.signOut")}
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-3xl gap-1 px-4 pb-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-sm font-semibold transition-colors ${
                tab === t.id ? "bg-bg text-ink" : "text-dim hover:text-ink"
              }`}
            >
              {t.id === "notifications" ? <Bell size={13} /> : null}
              {t.id === "invoices" ? <FileText size={13} /> : null}
              {t.label}
              {t.badge ? (
                <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-6">
        {tab === "report" ? (
          <ReportTab
            trades={trades}
            title={title} setTitle={setTitle}
            trade={trade} setTrade={setTrade}
            priority={priority} setPriority={setPriority}
            description={description} setDescription={setDescription}
            error={error} sent={sent} sentCount={sentCount} saving={saving}
            media={media} mediaError={mediaError}
            triage={triage} triageApplied={triageApplied}
            location={location} locating={locating}
            tagApplied={tagApplied}
            setScanOpen={setScanOpen}
            applyTriage={applyTriage} locate={locate}
            addMedia={addMedia} removeMedia={removeMedia}
            setTriage={setTriage} setLocation={setLocation}
            setTagApplied={setTagApplied}
            submit={submit}
          />
        ) : tab === "requests" ? (
          <RequestsTab
            rows={rows} open={open} loading={requests.loading}
            onDetail={setDetailWO} onWithdraw={setWithdrawing}
            onReload={() => requests.reload()}
          />
        ) : tab === "notifications" ? (
          <NotificationsTab data={notifData} />
        ) : (
          <InvoicesTab data={invoiceData} />
        )}
      </main>

      {withdrawing ? (
        <WithdrawModal workOrder={withdrawing} onClose={() => setWithdrawing(null)} onDone={() => { setWithdrawing(null); requests.reload(); }} />
      ) : null}
      {detailWO ? (
        <RequestDetailModal workOrder={detailWO} onClose={() => setDetailWO(null)} />
      ) : null}
      <ScanTagModal open={scanOpen} onClose={() => setScanOpen(false)} onTag={onTag} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report tab — the original one-minute request form
// ---------------------------------------------------------------------------

function ReportTab({
  trades, title, setTitle, trade, setTrade, priority, setPriority,
  description, setDescription, error, sent, sentCount, saving,
  media, mediaError, triage, triageApplied, location, locating,
  tagApplied, setScanOpen, applyTriage, locate,
  addMedia, removeMedia, setTriage, setLocation, setTagApplied, submit,
}: any) {
  const { t } = useI18n();
  return (
    <>
      <div>
        <h1 className="text-xl font-bold text-ink">{t("portal.report")}</h1>
        <p className="text-sm text-dim">{t("portal.reportDesc")}</p>
      </div>
      <Card className="p-5">
        {sent ? (
          <div className="mb-3 rounded-lg bg-gardening/15 px-4 py-3 text-sm font-semibold text-gardening">
            {t("portal.requestFiled")}{sentCount > 0 ? ` — ${sentCount} photo/video/voice note${sentCount === 1 ? "" : "s"} attached` : ""}. We'll update its status here.
          </div>
        ) : null}
        {mediaError ? <div className="mb-3"><ErrorBanner message={mediaError} /></div> : null}
        {error ? <ErrorBanner message={error} /> : null}
        <form onSubmit={submit} className="space-y-4">
          <Field label={t("portal.whatsWrong")}>
            <Input value={title} onChange={(e: any) => setTitle(e.target.value)} placeholder="e.g. Bathroom tap in unit 7B won't stop dripping" required maxLength={300} />
          </Field>
          {triage && triage.trade && triage.priority && !triageApplied ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-ink">
              <Sparkles size={14} className="text-amber" />
              <span>AI suggests <strong>{titleCase(triage.trade)}</strong> · <strong>{titleCase(triage.priority)}</strong>{triage.matched.length ? <span className="text-dim"> — matched {triage.matched.slice(0, 3).join(", ")}</span> : null}</span>
              <div className="ml-auto flex items-center gap-1">
                <Button type="button" variant="primary" className="!px-2 !py-1 text-xs" onClick={applyTriage}>Use it</Button>
                <Button type="button" variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setTriage(null)}>Dismiss</Button>
              </div>
            </div>
          ) : null}
          <div className="rounded-xl border border-line bg-panel p-3">
            <p className="text-xs font-bold text-ink">{t("portal.showUs")}</p>
            <p className="text-xs text-dim">{t("portal.showUsDesc")}</p>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {media.filter((m: any) => m.kind === "photo").map((m: any) => (
                <div key={m.id} className="relative aspect-video overflow-hidden rounded-lg border border-line">
                  {m.url ? <img src={m.url} alt="preview" className="h-full w-full object-cover" /> : null}
                  <button type="button" aria-label="Remove photo" className="absolute right-1 top-1 rounded-full bg-bg/90 p-1 text-dim hover:text-danger" onClick={() => removeMedia(m.id)}><X size={12} /></button>
                </div>
              ))}
              <label className="flex aspect-video cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line bg-bg text-center text-xs font-semibold text-dim transition-colors hover:border-amber/50 hover:text-ink">
                <Camera size={20} className="text-amber" /><span>{t("portal.addPhoto")}</span>
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e: any) => { const f = e.target.files?.[0]; if (f) addMedia(f, "photo"); e.target.value = ""; }} />
              </label>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {media.filter((m: any) => m.kind !== "photo").map((m: any) => (
                <span key={m.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-bg px-2 py-1 text-xs text-ink">
                  {m.kind === "voice" ? <AudioLines size={12} /> : <Video size={12} />}
                  {mediaLabel(m)}
                  <button type="button" aria-label="Remove" className="text-dim hover:text-danger" onClick={() => removeMedia(m.id)}><X size={12} /></button>
                </span>
              ))}
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-bg px-2 py-1 text-xs font-semibold text-ink transition-colors hover:bg-panel-2">
                <Video size={12} /> Video
                <input type="file" accept="video/*" capture="environment" className="hidden" onChange={(e: any) => { const f = e.target.files?.[0]; if (f) addMedia(f, "video"); e.target.value = ""; }} />
              </label>
              <VoiceRecorder onRecorded={(file: File, ms: number) => addMedia(file, "voice", ms)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("portal.category")}>
              <Select value={trade} onChange={(e: any) => setTrade(e.target.value)}>
                {trades.map((t: any) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </Field>
            <Field label={t("portal.urgency")}>
              <Select value={priority} onChange={(e: any) => setPriority(e.target.value as WorkOrderPriority)}>
                <option value="low">{t("portal.urgency.low")}</option>
                <option value="normal">{t("portal.urgency.normal")}</option>
                <option value="high">{t("portal.urgency.high")}</option>
                <option value="urgent">{t("portal.urgency.urgent")}</option>
              </Select>
            </Field>
          </div>
          <Field label={t("portal.details")}>
            <Textarea rows={4} value={description} onChange={(e: any) => setDescription(e.target.value)} placeholder="e.g. Third floor, unit 7B, ensuite bathroom — dripping since yesterday" />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={() => setScanOpen(true)}>
              <QrCode size={13} /> Scan a tag
            </Button>
            {location ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-bg px-3 py-1.5 text-xs text-ink">
                <MapPin size={13} className="text-amber" />
                {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}
                {location.accuracy ? <span className="text-dim">±{Math.round(location.accuracy)}m</span> : null}
                <button type="button" aria-label="Remove location" className="text-dim hover:text-danger" onClick={() => setLocation(null)}><X size={12} /></button>
              </span>
            ) : (
              <Button type="button" variant="secondary" className="!px-3 !py-1.5 text-xs" disabled={locating} onClick={locate}>
                {locating ? <Loader2 size={13} className="animate-spin" /> : <Crosshair size={13} />}
                {locating ? "Locating…" : "Add my location"}
              </Button>
            )}
            {tagApplied ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-bg px-3 py-1.5 text-xs text-ink">
                <QrCode size={13} className="text-gardening" /> Tag read
                <button type="button" aria-label="Clear tag" className="text-dim hover:text-danger" onClick={() => setTagApplied(null)}><X size={12} /></button>
              </span>
            ) : null}
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={saving}><Send size={14} /> {saving ? t("portal.filing") : t("portal.fileRequest")}</Button>
          </div>
        </form>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Requests tab — list + tap to open detail modal
// ---------------------------------------------------------------------------

function RequestsTab({ rows, open, loading, onDetail, onWithdraw }: {
  rows: WorkOrder[]; open: WorkOrder[]; loading: boolean;
  onDetail: (w: WorkOrder) => void; onWithdraw: (w: WorkOrder) => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div>
        <h1 className="text-xl font-bold text-ink">{t("portal.myRequests")}</h1>
        <p className="text-sm text-dim">
          {open.length ? `${open.length} open · ${rows.length - open.length} resolved` : rows.length ? t("portal.noRequestsBody") : t("portal.noRequestsBody")}
        </p>
      </div>
      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title={t("portal.noRequests")} body={t("portal.noRequestsBody")} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
          {rows.map((w) => (
            <li key={w.id}>
              <button onClick={() => onDetail(w)} className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-panel-2/50">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{w.title}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-dim">
                    <TradeBadge trade={w.trade as Trade} />
                    <PriorityBadge priority={w.priority} />
                    <StatusBadge status={w.status} />
                    <span>{formatDate(w.created_at)}</span>
                    {w.sla_breached ? <span className="font-semibold text-danger">{t("portal.slaBreach")}</span> : null}
                  </p>
                  {w.description ? <p className="mt-1 line-clamp-2 text-xs text-dim">{w.description}</p> : null}
                  {Number(w.document_count) > 0 ? (
                    <p className="mt-1 flex items-center gap-1 text-xs text-dim">
                      <Paperclip size={11} className="text-gardening" />
                      {Number(w.document_count)} file{Number(w.document_count) === 1 ? "" : "s"}
                    </p>
                  ) : null}
                </div>
                <div className="shrink-0 text-right">
                  <ChevronRight size={16} className="text-dim" />
                  {w.status === "open" ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); onWithdraw(w); }}
                      className="mt-2 block text-xs font-semibold text-danger hover:underline"
                    >{t("portal.withdraw")}</button>
                  ) : null}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Request detail modal — shows full WO info + attached documents
// ---------------------------------------------------------------------------

function RequestDetailModal({ workOrder: w, onClose }: { workOrder: WorkOrder; onClose: () => void }) {
  const { t } = useI18n();
  const [docs, setDocs] = useState<Document[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<Document[]>("/documents", { entity_type: "work_order", entity_id: w.id });
        if (!cancelled) setDocs(Array.isArray(res) ? res : []);
      } catch { /* tenant may not have access */ }
      if (!cancelled) setDocsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [w.id]);

  const isImage = (ct: string | null) => ct?.startsWith("image/");
  const isVideo = (ct: string | null) => ct?.startsWith("video/");

  return (
    <Modal open onClose={onClose} title={t("portal.requestDetails")}>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-bold text-ink">{w.title}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <TradeBadge trade={w.trade as Trade} />
            <PriorityBadge priority={w.priority} />
            <StatusBadge status={w.status} />
          </p>
        </div>
        {w.description ? <p className="text-sm text-ink">{w.description}</p> : null}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div><span className="text-dim">{t("portal.filed")}</span> <span className="text-ink">{formatDate(w.created_at)}</span></div>
          {w.completed_at ? <div><span className="text-dim">{t("portal.completed")}</span> <span className="text-ink">{formatDate(w.completed_at)}</span></div> : null}
          {w.sla_due_at ? <div><span className="text-dim">{t("portal.slaDue")}</span> <span className="text-ink">{formatDate(w.sla_due_at)}</span></div> : null}
          {w.sla_breached ? <div className="text-danger font-semibold">{t("portal.slaBreach")}</div> : null}
          {w.cost ? <div><span className="text-dim">{t("portal.cost")}</span> <span className="text-ink">KES {Number(w.cost).toLocaleString()}</span></div> : null}
          {w.failure_code ? <div><span className="text-dim">{t("portal.rootCause")}</span> <span className="text-ink">{titleCase(w.failure_code)}</span></div> : null}
        </div>
        {w.latitude != null && w.longitude != null ? (
          <p className="flex items-center gap-1.5 text-xs text-dim">
            <MapPin size={12} className="text-amber" />
            {Number(w.latitude).toFixed(4)}, {Number(w.longitude).toFixed(4)}
          </p>
        ) : null}
        {w.cancellation_reason ? (
          <div className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            <span className="font-semibold">{t("portal.cancellationReason")}</span> {w.cancellation_reason}
          </div>
        ) : null}
        <div>
          <h4 className="mb-2 text-xs font-bold text-ink">{t("portal.attachments")}</h4>
          {docsLoading ? <Spinner /> : docs.length === 0 ? (
            <p className="text-xs text-dim">{t("portal.noFiles")}</p>
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
// Notifications tab — in-app feed with unread badge + mark-as-read
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
        <p className="text-sm text-dim">{t("portal.updatesDesc")}</p>
      </div>
      {data?.loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title={t("portal.noUpdates")} body={t("portal.noUpdatesBody")} />
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
// Invoices tab — invoices related to the tenant's work orders
// ---------------------------------------------------------------------------

function InvoicesTab({ data }: { data: any }) {
  const { t } = useI18n();
  const items: Invoice[] = data?.data?.data ?? [];

  return (
    <>
      <div>
        <h1 className="text-xl font-bold text-ink">{t("portal.invoices")}</h1>
        <p className="text-sm text-dim">{t("portal.invoicesDesc")}</p>
      </div>
      {data?.loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title={t("portal.noInvoices")} body={t("portal.noInvoicesBody")} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
          {items.map((inv) => (
            <li key={inv.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-ink">{inv.invoice_number}</p>
                  {inv.work_order_title ? <p className="mt-0.5 text-xs text-dim">{inv.work_order_title}</p> : null}
                  {inv.supplier_name ? <p className="mt-0.5 text-xs text-dim">by {inv.supplier_name}</p> : null}
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
// Withdraw modal
// ---------------------------------------------------------------------------

function WithdrawModal({ workOrder, onClose, onDone }: { workOrder: WorkOrder; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
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
      setError(err instanceof Error ? err.message : "Could not withdraw the request");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t("portal.withdrawTitle")}>
      <p className="-mt-2 mb-4 text-xs text-dim">
        "{workOrder.title}" will be marked cancelled and removed from the work board. You can only
        withdraw requests that haven't been assigned yet.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label={t("portal.withdrawWhy")}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Fixed it myself — wasn't a real fault" required />
        </Field>
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Keep it</Button>
          <Button type="submit" disabled={saving}>{saving ? t("portal.withdrawing") : t("portal.withdrawRequest")}</Button>
        </div>
      </form>
    </Modal>
  );
}
