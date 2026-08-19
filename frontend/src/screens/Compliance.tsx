import { useState } from "react";
import type { FormEvent } from "react";
import type {
  Competency,
  ComplianceSummary,
  Permit,
  PermitStatus,
  PermitType,
  StaffUser,
  StatutoryInspection,
  WorkOrder,
} from "../lib/types";
import { PERMIT_STATUSES, PERMIT_TYPES, formatDate, titleCase } from "../lib/format";
import { Button, Card, EmptyState, Field, Input, Modal, Select, Spinner, StatCard, Textarea } from "../components/ui";
import { CalendarPicker } from "../components/CalendarPicker";
import { api, getBlob, upload } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { useAuth } from "../context/AuthContext";

interface Paged<T> {
  data: T[];
}

function PermitBadge({ status }: { status: PermitStatus }) {
  const s = PERMIT_STATUSES[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

function StatusBadge({ ok, okLabel, failLabel }: { ok: boolean; okLabel: string; failLabel: string }) {
  return ok ? (
    <span className="inline-flex items-center rounded-full bg-gardening/15 px-2 py-0.5 text-xs font-semibold text-gardening">
      {okLabel}
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-danger/15 px-2 py-0.5 text-xs font-semibold text-danger">
      {failLabel}
    </span>
  );
}

const emptyPermitForm = { work_order_id: "", type: "" as PermitType | "", notes: "", expires_at: "" };
const emptyCompetencyForm = { user_id: "", name: "", trade: "", expires_at: "" };

export default function Compliance() {
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "manager";

  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showPermit, setShowPermit] = useState(false);
  const [permitForm, setPermitForm] = useState(emptyPermitForm);
  const [showCompetency, setShowCompetency] = useState(false);
  const [compForm, setCompForm] = useState(emptyCompetencyForm);
  const [evidenceFor, setEvidenceFor] = useState<Permit | null>(null);

  const summary = useFetch<ComplianceSummary>("/compliance/summary");
  const permits = useFetch<Paged<Permit>>("/compliance/permits");
  const competencies = useFetch<Paged<Competency>>("/compliance/competencies");
  const inspections = useFetch<Paged<StatutoryInspection>>("/compliance/inspections");
  const users = useFetch<Paged<StaffUser>>("/users");
  const wos = useFetch<Paged<WorkOrder>>("/work-orders", { limit: 200 });

  if (summary.loading || permits.loading || competencies.loading || inspections.loading) return <Spinner />;

  const openPermits = Number(summary.data?.open_permits ?? 0);
  const expiredCompetencies = Number(summary.data?.expired_competencies ?? 0);
  const overdueInspections = Number(summary.data?.overdue_inspections ?? 0);

  const permitsRows = permits.data?.data ?? [];
  const compRows = competencies.data?.data ?? [];
  const inspRows = inspections.data?.data ?? [];
  const userRows = (users.data?.data ?? []).filter(
    (u) => u.active !== false && u.role !== "supplier" && u.role !== "tenant"
  );

  // Work orders that could still need a permit: open/assigned/in_progress.
  const openWos = (wos.data?.data ?? []).filter((w) =>
    ["open", "assigned", "in_progress"].includes(w.status)
  );

  const run = async (fn: () => Promise<unknown>, after: () => void) => {
    setSaving(true);
    setActionError(null);
    try {
      await fn();
      after();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSaving(false);
    }
  };

  const closePermitForm = () => {
    setShowPermit(false);
    setPermitForm(emptyPermitForm);
    setActionError(null);
  };
  const closeCompForm = () => {
    setShowCompetency(false);
    setCompForm(emptyCompetencyForm);
    setActionError(null);
  };

  const submitPermit = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () =>
        api.post("/compliance/permits", {
          work_order_id: permitForm.work_order_id || null,
          type: permitForm.type,
          notes: permitForm.notes || null,
          expires_at: permitForm.expires_at ? new Date(permitForm.expires_at).toISOString() : null,
        }),
      () => {
        closePermitForm();
        permits.reload();
        summary.reload();
      }
    );
  };

  const submitCompetency = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () =>
        api.post("/compliance/competencies", {
          user_id: compForm.user_id,
          name: compForm.name,
          trade: compForm.trade || null,
          expires_at: compForm.expires_at ? new Date(compForm.expires_at).toISOString() : null,
        }),
      () => {
        closeCompForm();
        competencies.reload();
        summary.reload();
      }
    );
  };

  const decidePermit = (id: string, status: PermitStatus) => {
    setBusyId(id);
    setActionError(null);
    api
      .patch(`/compliance/permits/${id}`, { status })
      .then(() => {
        permits.reload();
        summary.reload();
      })
      .catch((err) => setActionError(err instanceof Error ? err.message : "Could not update permit"))
      .finally(() => setBusyId(null));
  };

  const markInspection = (id: string) => {
    setBusyId(id);
    setActionError(null);
    api
      .patch(`/compliance/inspections/${id}`, {})
      .then(() => {
        inspections.reload();
        summary.reload();
      })
      .catch((err) => setActionError(err instanceof Error ? err.message : "Could not record inspection"))
      .finally(() => setBusyId(null));
  };

  const viewEvidence = async (url: string, label: string) => {
    try {
      const { blob, type } = await getBlob(url);
      const objectUrl = URL.createObjectURL(new Blob([blob], { type }));
      window.open(objectUrl, "_blank");
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      setActionError(`Could not open the evidence for ${label}.`);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">Compliance & safety</h1>
          <p className="text-sm text-dim">Permit-to-work, staff competencies, and statutory inspection schedule.</p>
        </div>
        <div className="flex gap-2">
          {canEdit ? (
            <>
              <Button variant="secondary" onClick={() => setShowCompetency(true)}>
                Add competency
              </Button>
              <Button onClick={() => setShowPermit(true)}>New permit</Button>
            </>
          ) : null}
        </div>
      </div>

      {actionError ? <Card className="p-3 text-sm text-danger">{actionError}</Card> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Open permits" value={openPermits} accent />
        <StatCard label="Expired competencies" value={expiredCompetencies} />
        <StatCard label="Overdue inspections" value={overdueInspections} />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-bold text-ink">Permits</h2>
          <p className="text-xs text-dim">Work requiring a permit-to-work cannot be closed while one is not issued.</p>
        </div>
        {permitsRows.length === 0 ? (
          <EmptyState title="No permits yet" body="Create one for work flagged as requiring a permit." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                <th className="px-4 py-2 font-semibold">Type</th>
                <th className="hidden px-4 py-2 font-semibold md:table-cell">Work order</th>
                <th className="hidden px-4 py-2 font-semibold lg:table-cell">Expires</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {permitsRows.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-panel-2/60">
                  <td className="px-4 py-3">
                    <span className="font-medium text-ink">{PERMIT_TYPES[p.type] ?? titleCase(p.type)}</span>
                    {p.notes ? (
                      <span className="mt-0.5 block max-w-[240px] truncate text-xs text-dim">{p.notes}</span>
                    ) : null}
                  </td>
                  <td className="hidden px-4 py-3 text-dim md:table-cell">
                    {openWos.find((w) => w.id === p.work_order_id)?.title ?? "—"}
                  </td>
                  <td className="hidden px-4 py-3 text-dim lg:table-cell">{formatDate(p.expires_at)}</td>
                  <td className="px-4 py-3">
                    <PermitBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {p.evidence_url ? (
                        <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => viewEvidence(p.evidence_url as string, PERMIT_TYPES[p.type] ?? "permit")}>
                          View evidence
                        </Button>
                      ) : null}
                      {canEdit ? (
                        <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setEvidenceFor(p)}>
                          Evidence
                        </Button>
                      ) : null}
                      {canEdit && p.status === "draft" ? (
                        <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busyId === p.id} onClick={() => decidePermit(p.id, "issued")}>
                          Issue
                        </Button>
                      ) : null}
                      {canEdit && p.status === "issued" ? (
                        <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busyId === p.id} onClick={() => decidePermit(p.id, "closed")}>
                          Close
                        </Button>
                      ) : null}
                      {canEdit && (p.status === "draft" || p.status === "issued") ? (
                        <Button variant="ghost" className="!px-2 !py-1 text-xs text-danger" disabled={busyId === p.id} onClick={() => decidePermit(p.id, "cancelled")}>
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-bold text-ink">Competencies</h2>
          <p className="text-xs text-dim">Qualification and certification expiry for staff trades.</p>
        </div>
        {compRows.length === 0 ? (
          <EmptyState title="No competencies recorded" body="Add qualifications to track certification expiry." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                <th className="px-4 py-2 font-semibold">Staff member</th>
                <th className="hidden px-4 py-2 font-semibold sm:table-cell">Qualification</th>
                <th className="hidden px-4 py-2 font-semibold lg:table-cell">Trade</th>
                <th className="px-4 py-2 font-semibold">Expires</th>
                <th className="px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {compRows.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0 hover:bg-panel-2/60">
                  <td className="px-4 py-3 font-medium text-ink">{c.user_name}</td>
                  <td className="hidden px-4 py-3 text-dim sm:table-cell">{c.name}</td>
                  <td className="hidden px-4 py-3 text-dim lg:table-cell">{c.trade ? titleCase(c.trade) : "—"}</td>
                  <td className="hidden px-4 py-3 text-dim md:table-cell">{formatDate(c.expires_at)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge ok={!c.expired} okLabel="Valid" failLabel="Expired" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-bold text-ink">Statutory inspections</h2>
          <p className="text-xs text-dim">Recording an inspection rolls the next due date forward by its frequency.</p>
        </div>
        {inspRows.length === 0 ? (
          <EmptyState title="No inspections scheduled" body="Add statutory requirements like fire extinguisher or genset checks." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                <th className="px-4 py-2 font-semibold">Requirement</th>
                <th className="hidden px-4 py-2 font-semibold md:table-cell">Frequency</th>
                <th className="hidden px-4 py-2 font-semibold lg:table-cell">Last done</th>
                <th className="px-4 py-2 font-semibold">Due</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                {canEdit ? <th className="px-4 py-2 font-semibold text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {inspRows.map((i) => (
                <tr key={i.id} className="border-b border-line last:border-0 hover:bg-panel-2/60">
                  <td className="px-4 py-3">
                    <span className="font-medium text-ink">{i.requirement}</span>
                    {i.notes ? (
                      <span className="mt-0.5 block max-w-[280px] truncate text-xs text-dim">{i.notes}</span>
                    ) : null}
                  </td>
                  <td className="hidden px-4 py-3 text-dim md:table-cell">{Number(i.frequency_days)} days</td>
                  <td className="hidden px-4 py-3 text-dim lg:table-cell">{formatDate(i.last_done_at)}</td>
                  <td className="px-4 py-3 text-dim">{formatDate(i.due_date)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge ok={!i.overdue} okLabel="Upcoming" failLabel="Overdue" />
                  </td>
                  {canEdit ? (
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busyId === i.id} onClick={() => markInspection(i.id)}>
                        Mark done
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={evidenceFor != null} onClose={() => setEvidenceFor(null)} title={evidenceFor ? `Evidence — ${PERMIT_TYPES[evidenceFor.type] ?? "Permit"}` : ""}>
        {evidenceFor ? (
          <PermitEvidenceModal
            permit={evidenceFor}
            onClose={() => setEvidenceFor(null)}
            onSaved={() => {
              permits.reload();
              summary.reload();
            }}
          />
        ) : null}
      </Modal>

      <Modal open={showPermit} onClose={closePermitForm} title="New permit-to-work">
        <form onSubmit={submitPermit} className="space-y-4">
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          <Field label="Type">
            <Select value={permitForm.type} onChange={(e) => setPermitForm({ ...permitForm, type: e.target.value as PermitType | "" })} required>
              <option value="">—</option>
              {Object.entries(PERMIT_TYPES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Work order">
            <Select value={permitForm.work_order_id} onChange={(e) => setPermitForm({ ...permitForm, work_order_id: e.target.value })}>
              <option value="">— (general / standby)</option>
              {openWos.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Valid until">
            <CalendarPicker value={permitForm.expires_at} onChange={(v) => setPermitForm({ ...permitForm, expires_at: v })} />
          </Field>
          <Field label="Notes">
            <Textarea rows={3} value={permitForm.notes} onChange={(e) => setPermitForm({ ...permitForm, notes: e.target.value })} placeholder="e.g. Safety harness + guardrail required" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={closePermitForm}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Creating…" : "Create draft"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={showCompetency} onClose={closeCompForm} title="Add competency">
        <form onSubmit={submitCompetency} className="space-y-4">
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          <Field label="Staff member">
            <Select value={compForm.user_id} onChange={(e) => setCompForm({ ...compForm, user_id: e.target.value })} required>
              <option value="">—</option>
              {userRows.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Qualification">
            <Input value={compForm.name} onChange={(e) => setCompForm({ ...compForm, name: e.target.value })} required placeholder="e.g. Electrical LV (authorised)" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Trade">
              <Input value={compForm.trade} onChange={(e) => setCompForm({ ...compForm, trade: e.target.value })} placeholder="optional" />
            </Field>
            <Field label="Expires">
              <CalendarPicker value={compForm.expires_at} onChange={(v) => setCompForm({ ...compForm, expires_at: v })} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={closeCompForm}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add competency"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function PermitEvidenceModal({
  permit,
  onClose,
  onSaved,
}: {
  permit: Permit;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return setError("Pick a file first.");
    setUploading(true);
    setError(null);
    try {
      await upload(`/compliance/permits/${permit.id}/evidence`, file, {});
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="-mt-2 text-xs text-dim">
        Attach the signed permit or photos of the work area. The file is stored immutably and linked to this permit for
        the audit trail.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Evidence file">
          <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        {file ? <p className="text-xs text-dim">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
          <Button type="submit" disabled={uploading || !file}>
            {uploading ? "Uploading…" : "Upload evidence"}
          </Button>
        </div>
      </form>
    </div>
  );
}
