import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Pause, Play, Plus, Trash2 } from "lucide-react";
import type { MaintenancePlan, TriggerType } from "../lib/types";
import { formatDate } from "../lib/format";
import { TriggerBadge } from "../components/Badges";
import { Button, Card, EmptyState, ErrorBanner, Field, Input, Modal, Select, Spinner } from "../components/ui";
import { useFetch } from "../lib/useFetch";
import { useConfig } from "../context/ConfigContext";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";

interface PlanPage {
  data: MaintenancePlan[];
  meta: { total: number; limit: number; offset: number };
}

function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center rounded-full bg-gardening/15 px-2 py-0.5 text-xs font-semibold text-gardening">
      Active
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-dim/10 px-2 py-0.5 text-xs font-semibold text-dim">
      Paused
    </span>
  );
}

export default function MaintenancePlans() {
  const { user } = useAuth();
  const { assetTypeLabel } = useConfig();
  const canEdit = user?.role === "admin" || user?.role === "manager";
  const { data, loading, error, reload } = useFetch<PlanPage>("/maintenance-plans", { limit: 200 });

  const rows = useMemo(() => data?.data ?? [], [data]);

  const [editing, setEditing] = useState<MaintenancePlan | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState<MaintenancePlan | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function runNow(plan: MaintenancePlan) {
    setBusyId(plan.id);
    try {
      await api.post(`/maintenance-plans/${plan.id}/run`);
      reload();
    } catch {
      // surface via a reload-triggered error? keep the table stable instead
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(plan: MaintenancePlan) {
    setBusyId(plan.id);
    try {
      await api.patch(`/maintenance-plans/${plan.id}`, { active: !plan.active });
      reload();
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api.del(`/maintenance-plans/${deleting.id}`);
      setDeleting(null);
      reload();
    } catch {
      setDeleting(null);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <Card className="p-4 text-danger">{error}</Card>;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-ink">Maintenance plans</h1>
          <p className="text-sm text-dim">
            The scheduler turns these into work orders when due — daily at 02:00, or via "Run now".
          </p>
        </div>
        {canEdit ? (
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={14} /> New plan
          </Button>
        ) : null}
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState title="No maintenance plans yet" body="Create a plan so the scheduler can generate work orders automatically." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                  <th className="px-4 py-2 font-semibold">Plan</th>
                  <th className="hidden px-4 py-2 font-semibold md:table-cell">Asset type</th>
                  <th className="px-4 py-2 font-semibold">Trigger</th>
                  <th className="px-4 py-2 font-semibold">Cadence</th>
                  <th className="hidden px-4 py-2 font-semibold sm:table-cell">Next run</th>
                  <th className="hidden px-4 py-2 font-semibold lg:table-cell">Open jobs</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  {canEdit ? <th className="px-4 py-2 text-right font-semibold">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-panel-2/60">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{p.name}</p>
                      {p.checklist.length ? (
                        <p className="mt-0.5 text-xs text-dim">{p.checklist.length} checklist {p.checklist.length === 1 ? "step" : "steps"}</p>
                      ) : null}
                    </td>
                    <td className="hidden px-4 py-3 text-dim md:table-cell">
                      {p.asset_type ? assetTypeLabel(p.asset_type) : "Any"}
                    </td>
                    <td className="px-4 py-3">
                      <TriggerBadge trigger={p.trigger} />
                    </td>
                    <td className="px-4 py-3 text-dim">
                      {p.trigger === "scheduled" && p.frequency_days
                        ? `Every ${p.frequency_days}d`
                        : p.trigger === "meter_based"
                          ? p.meter_threshold != null
                            ? `At ${p.meter_threshold} units`
                            : "—"
                          : "Manual"}
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      {p.trigger === "scheduled" ? (
                        p.due ? (
                          <span className="font-semibold text-danger">Due now</span>
                        ) : p.next_run_at ? (
                          <span className="text-dim">{formatDate(p.next_run_at)}</span>
                        ) : (
                          <span className="text-dim">—</span>
                        )
                      ) : (
                        <span className="text-dim">—</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell">
                      {p.open_work_orders > 0 ? (
                        <span className="text-dim">{p.open_work_orders} in flight</span>
                      ) : (
                        <span className="text-dim/50">None</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <ActiveBadge active={p.active} />
                    </td>
                    {canEdit ? (
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            className="px-2 text-xs"
                            disabled={busyId === p.id || !p.active}
                            title={p.active ? "Generate due work now" : "Paused — resume to run"}
                            onClick={() => runNow(p)}
                          >
                            <Play size={13} /> Run
                          </Button>
                          <Button variant="ghost" className="px-2 text-xs" onClick={() => setEditing(p)}>
                            Edit
                          </Button>
                          <Button variant="ghost" className="px-2 text-xs" onClick={() => toggleActive(p)} disabled={busyId === p.id}>
                            {p.active ? <><Pause size={13} /> Pause</> : <><Play size={13} /> Resume</>}
                          </Button>
                          <Button variant="ghost" className="px-2 text-xs text-danger hover:bg-danger/10" onClick={() => setDeleting(p)}>
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showCreate ? (
        <PlanModal
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); reload(); }}
        />
      ) : null}
      {editing ? (
        <PlanModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      ) : null}
      {deleting ? (
        <Modal open onClose={() => setDeleting(null)} title="Delete this plan?">
          <p className="-mt-2 mb-4 text-xs text-dim">
            “{deleting.name}” will be removed. Generated work orders keep their history (they just
            stop linking back to the plan).
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>Keep it</Button>
            <Button className="bg-danger text-bg hover:bg-danger/90" onClick={confirmDelete}>
              <Trash2 size={14} /> Delete plan
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// Create / edit form — the "maintenance manual" entry. Cadence depends on the
// trigger: scheduled plans need frequency_days, meter_based plans a threshold.
function PlanModal({ initial, onClose, onSaved }: { initial?: MaintenancePlan | null; onClose: () => void; onSaved: () => void }) {
  const { config } = useConfig();
  const assetTypes = config?.asset_types?.filter((t) => t.active) ?? [];

  const [name, setName] = useState(initial?.name ?? "");
  const [assetType, setAssetType] = useState(initial?.asset_type ?? "");
  const [trigger, setTrigger] = useState<TriggerType>(initial?.trigger ?? "scheduled");
  const [frequencyDays, setFrequencyDays] = useState(initial?.frequency_days ? String(initial.frequency_days) : "");
  const [meterThreshold, setMeterThreshold] = useState(initial?.meter_threshold ? String(initial.meter_threshold) : "");
  const [steps, setSteps] = useState<string[]>(initial?.checklist.map((c) => c.step) ?? [""]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const checklist = steps.map((s) => ({ step: s.trim() })).filter((c) => c.step);
    const body: Record<string, unknown> = {
      name: name.trim(),
      asset_type: assetType || null,
      trigger,
      checklist,
    };
    if (trigger === "scheduled") {
      body.frequency_days = Number(frequencyDays);
    } else if (trigger === "meter_based") {
      body.meter_threshold = Number(meterThreshold);
    }
    try {
      if (initial) {
        await api.patch(`/maintenance-plans/${initial.id}`, body);
      } else {
        await api.post("/maintenance-plans", body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the plan");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={initial ? "Edit plan" : "New maintenance plan"}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Plan name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Generator monthly inspection" required maxLength={200} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Asset type">
            <Select value={assetType} onChange={(e) => setAssetType(e.target.value)}>
              <option value="">Any asset</option>
              {assetTypes.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Trigger">
            <Select value={trigger} onChange={(e) => setTrigger(e.target.value as TriggerType)}>
              <option value="scheduled">Scheduled — every N days</option>
              <option value="meter_based">Meter threshold</option>
              <option value="on_demand">On demand (manual)</option>
            </Select>
          </Field>
        </div>

        {trigger === "scheduled" ? (
          <Field label="Frequency (days)">
            <Input
              type="number"
              min={1}
              value={frequencyDays}
              onChange={(e) => setFrequencyDays(e.target.value)}
              placeholder="e.g. 30"
              required
            />
          </Field>
        ) : trigger === "meter_based" ? (
          <Field label="Meter threshold (units)">
            <Input
              type="number"
              min={0}
              step="any"
              value={meterThreshold}
              onChange={(e) => setMeterThreshold(e.target.value)}
              placeholder="e.g. 200"
              required
            />
          </Field>
        ) : null}

        <Field label="Checklist steps">
          <div className="space-y-2">
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={step}
                  onChange={(e) => setSteps(steps.map((s, j) => (j === i ? e.target.value : s)))}
                  placeholder={`Step ${i + 1}`}
                />
                <Button type="button" variant="ghost" className="px-2 text-danger hover:bg-danger/10" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
            <Button type="button" variant="secondary" className="w-full" onClick={() => setSteps([...steps, ""])}>
              <Plus size={14} /> Add step
            </Button>
          </div>
        </Field>

        {error ? <ErrorBanner message={error} /> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : initial ? "Save changes" : "Create plan"}</Button>
        </div>
      </form>
    </Modal>
  );
}
