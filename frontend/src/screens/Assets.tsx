import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Asset, AssetType, MeterTrend } from "../lib/types";
import { BUILTIN_ASSET_TYPE_OPTIONS, formatDate } from "../lib/format";
import { Button, Card, EmptyState, Field, Input, Modal, Select, Spinner } from "../components/ui";
import { CalendarPicker } from "../components/CalendarPicker";
import { useFetch } from "../lib/useFetch";
import { api } from "../lib/api";
import { useConfig } from "../context/ConfigContext";
import { useAuth } from "../context/AuthContext";

interface AssetPage {
  data: Asset[];
  meta: { total: number; limit: number; offset: number };
}

const WARRANTY_ALERT_DAYS = 90;

function AssetStatusBadge({ status }: { status: Asset["status"] }) {
  const map = {
    active: { label: "Active", cls: "bg-gardening/15 text-gardening" },
    under_repair: { label: "Under repair", cls: "bg-amber/15 text-amber" },
    retired: { label: "Retired", cls: "bg-dim/10 text-dim" },
  } as const;
  const m = map[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${m.cls}`}>
      {m.label}
    </span>
  );
}

function MeterBadge({ asset }: { asset: Asset }) {
  if (asset.meter_value == null) return <span className="text-dim">—</span>;
  return (
    <span className="inline-flex items-center gap-1 text-ink">
      <span className="font-semibold">{asset.meter_value}</span>
      {asset.meter_unit ? <span className="text-dim">{asset.meter_unit}</span> : null}
    </span>
  );
}

export default function Assets() {
  const { user } = useAuth();
  const { config, assetTypeLabel } = useConfig();
  const canEdit = user?.role === "admin" || user?.role === "manager";
  const assetTypes = config?.asset_types?.filter((t) => t.active) ?? BUILTIN_ASSET_TYPE_OPTIONS;
  const [type, setType] = useState<AssetType | "">("");
  const [meterAsset, setMeterAsset] = useState<Asset | null>(null);
  const [readingForm, setReadingForm] = useState({ reading_value: "", reading_unit: "", recorded_at: "", cost: "" });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [search, setSearch] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editAsset, setEditAsset] = useState<Asset | null>(null);

  const { data, loading, error, reload } = useFetch<AssetPage>("/assets", {
    limit: 200,
    type: type || undefined,
    name: search || undefined,
  });
  const trend = useFetch<MeterTrend>(meterAsset ? `/meter-readings/assets/${meterAsset.id}/trend` : null);

  const rows = useMemo(() => {
    const base = data?.data ?? [];
    if (!search) return base;
    const term = search.toLowerCase();
    return base.filter((a) => a.name.toLowerCase().includes(term));
  }, [data, search]);

  const health = useMemo(() => {
    const now = new Date();
    const alertAt = new Date(now.getTime() + WARRANTY_ALERT_DAYS * 24 * 60 * 60 * 1000);
    let active = 0;
    let repair = 0;
    let retired = 0;
    let expiring = 0;
    for (const a of rows) {
      if (a.status === "active") active++;
      else if (a.status === "under_repair") repair++;
      else if (a.status === "retired") retired++;
      if (a.warranty_end && !a.status) {
        const end = new Date(a.warranty_end);
        if (end >= now && end <= alertAt) expiring++;
      }
    }
    return { active, repair, retired, expiring };
  }, [rows]);

  if (loading) return <Spinner />;
  if (error) return <Card className="p-4 text-danger">{error}</Card>;

  const closeMeter = () => {
    setMeterAsset(null);
    setReadingForm({ reading_value: "", reading_unit: "", recorded_at: "", cost: "" });
    setActionError(null);
    setActionInfo(null);
  };

  const openMeter = (a: Asset) => {
    setMeterAsset(a);
    setActionError(null);
    setActionInfo(null);
    setReadingForm({ reading_value: "", reading_unit: a.meter_unit ?? "", recorded_at: "", cost: "" });
  };

  const submitReading = async (e: FormEvent) => {
    e.preventDefault();
    if (!meterAsset) return;
    setSaving(true);
    setActionError(null);
    setActionInfo(null);
    try {
      const res = await api.post<{ work_orders: { id: string; title: string }[] }>(
        `/assets/${meterAsset.id}/readings`,
        {
          reading_value: Number(readingForm.reading_value),
          reading_unit: readingForm.reading_unit || null,
          recorded_at: readingForm.recorded_at ? new Date(readingForm.recorded_at).toISOString() : undefined,
          cost: readingForm.cost === "" ? null : Number(readingForm.cost),
        }
      );
      setReadingForm({ reading_value: "", reading_unit: readingForm.reading_unit, recorded_at: "", cost: "" });
      if (res.work_orders?.length) {
        setActionInfo(`Recommended work order created: ${res.work_orders.map((w) => w.title).join(", ")}`);
      } else {
        setActionInfo("Reading recorded.");
      }
      trend.reload();
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not record reading");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Assets ({data?.meta?.total ?? 0})</h1>
          <p className="text-sm text-dim">
            Equipment and fixtures tracked against maintenance plans.
            {rows.filter((a) => a.meter_value != null).length > 0
              ? ` ${rows.filter((a) => a.meter_value != null).length} asset(s) with meter monitoring.`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search assets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="!w-56"
          />
          <Select value={type} onChange={(e) => setType(e.target.value as AssetType | "")} className="!w-44">
            <option value="">All types</option>
            {assetTypes.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          {canEdit && (
            <Button onClick={() => setCreateOpen(true)}>
              Add asset
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-3">
          <p className="text-xs uppercase tracking-wide text-dim">Active</p>
          <p className="mt-1 text-xl font-bold text-gardening">{health.active}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs uppercase tracking-wide text-dim">Under repair</p>
          <p className="mt-1 text-xl font-bold text-amber">{health.repair}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs uppercase tracking-wide text-dim">Retired</p>
          <p className="mt-1 text-xl font-bold text-dim">{health.retired}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs uppercase tracking-wide text-dim">Warranty expiring ≤{WARRANTY_ALERT_DAYS}d</p>
          <p className={`mt-1 text-xl font-bold ${health.expiring > 0 ? "text-danger" : "text-ink"}`}>{health.expiring}</p>
        </Card>
      </div>

      <Card className="hidden overflow-hidden md:block">
        {rows.length === 0 ? (
          <EmptyState title="No assets found" body="Assets appear once they're added to your workspace." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 font-semibold">Type</th>
                <th className="hidden px-4 py-2 font-semibold md:table-cell">Installed</th>
                <th className="hidden px-4 py-2 font-semibold md:table-cell">Warranty ends</th>
                <th className="hidden px-4 py-2 font-semibold lg:table-cell">Meter</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-0 hover:bg-panel-2/60">
                  <td className="px-4 py-3 font-medium text-ink">{a.name}</td>
                  <td className="px-4 py-3 text-dim">{assetTypeLabel(a.type)}</td>
                  <td className="hidden px-4 py-3 text-dim md:table-cell">
                    {a.install_date ? formatDate(a.install_date) : "—"}
                  </td>
                  <td className="hidden px-4 py-3 text-dim md:table-cell">
                    {a.warranty_end ? (
                      <span className={new Date(a.warranty_end) <= new Date(Date.now() + WARRANTY_ALERT_DAYS * 24 * 60 * 60 * 1000) ? "font-semibold text-danger" : ""}>
                        {formatDate(a.warranty_end)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="hidden px-4 py-3 lg:table-cell">
                    <MeterBadge asset={a} />
                  </td>
                  <td className="px-4 py-3">
                    <AssetStatusBadge status={a.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => openMeter(a)}>
                        Meter
                      </Button>
                      {canEdit && (
                        <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setEditAsset(a)}>
                          Edit
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid gap-3 md:hidden">
        {rows.length === 0 ? (
          <EmptyState title="No assets found" body="Assets appear once they're added to your workspace." />
        ) : (
          rows.map((a) => (
            <Card key={a.id} className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-ink">{a.name}</p>
                <AssetStatusBadge status={a.status} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-dim">
                <span>{assetTypeLabel(a.type)}</span>
                {a.warranty_end ? <span>· warranty {formatDate(a.warranty_end)}</span> : null}
              </div>
              <div className="mt-2 flex items-center justify-between">
                <MeterBadge asset={a} />
                <div className="flex gap-1">
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => openMeter(a)}>
                    Meter
                  </Button>
                  {canEdit && (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setEditAsset(a)}>
                      Edit
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>

      {createOpen ? (
        <AssetFormModal
          asset={null}
          assetTypes={assetTypes}
          onClose={() => setCreateOpen(false)}
          onSaved={reload}
        />
      ) : null}
      {editAsset ? (
        <AssetFormModal
          asset={editAsset}
          assetTypes={assetTypes}
          onClose={() => setEditAsset(null)}
          onSaved={reload}
        />
      ) : null}

      <Modal open={meterAsset != null} onClose={closeMeter} title={meterAsset ? `Meter — ${meterAsset.name}` : ""}>
        {meterAsset ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm text-dim">Live value</p>
                <p className="text-2xl font-bold text-ink">
                  {meterAsset.meter_value ?? "—"}
                  {meterAsset.meter_unit ? <span className="ml-1 text-sm font-normal text-dim">{meterAsset.meter_unit}</span> : null}
                </p>
              </div>
              {actionInfo ? <p className="max-w-[260px] text-sm text-gardening">{actionInfo}</p> : null}
              {actionError ? <p className="max-w-[260px] text-sm text-danger">{actionError}</p> : null}
            </div>

            {trend.data && trend.data.thresholds.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-dim">Threshold alerts</p>
                {trend.data.thresholds.map((t) => (
                  <div
                    key={t.plan_id}
                    className={`rounded-lg border px-3 py-2 text-sm ${
                      t.reached ? "border-danger/40 bg-danger/5 text-danger" : "border-line bg-panel-2/40 text-ink"
                    }`}
                  >
                    <span className="font-semibold">{t.plan_name}</span> — threshold {t.threshold}{" "}
                    {t.reached
                      ? "reached (recommended work order issued)"
                      : t.predicted_days != null
                        ? `· ≈ ${t.predicted_days} day(s) at current usage`
                        : ""}
                  </div>
                ))}
              </div>
            ) : null}

            <form onSubmit={submitReading} className="space-y-3 rounded-xl border border-line bg-panel-2/30 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-dim">Record reading</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Reading">
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={readingForm.reading_value}
                    onChange={(e) => setReadingForm({ ...readingForm, reading_value: e.target.value })}
                    required
                  />
                </Field>
                <Field label="Unit">
                  <Input value={readingForm.reading_unit} onChange={(e) => setReadingForm({ ...readingForm, reading_unit: e.target.value })} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Recorded at">
                  <CalendarPicker
                    withTime
                    value={readingForm.recorded_at}
                    onChange={(v) => setReadingForm({ ...readingForm, recorded_at: v })}
                  />
                </Field>
                <Field label="Cost (KES)">
                  <Input type="number" min="0" step="any" value={readingForm.cost} onChange={(e) => setReadingForm({ ...readingForm, cost: e.target.value })} placeholder="optional" />
                </Field>
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={saving}>
                  {saving ? "Recording…" : "Record reading"}
                </Button>
              </div>
            </form>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-dim">Recent readings</p>
              {trend.loading ? (
                <p className="py-4 text-center text-sm text-dim">Loading…</p>
              ) : trend.data && trend.data.readings.length > 0 ? (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {trend.data.readings
                    .slice()
                    .reverse()
                    .map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <div>
                          <span className={`font-medium ${r.anomaly ? "text-danger" : "text-ink"}`}>
                            {r.reading_value} {r.reading_unit}
                          </span>
                          {r.anomaly ? (
                            <span className="ml-2 rounded-full bg-danger/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-danger">
                              Spike
                            </span>
                          ) : null}
                        </div>
                        <div className="text-right text-xs text-dim">
                          {r.delta != null ? (
                            <span className={r.delta > 0 ? "text-ink" : ""}>+{r.delta} · </span>
                          ) : null}
                          {r.rate_per_day != null ? `${r.rate_per_day}/day · ` : null}
                          {formatDate(r.recorded_at)}
                        </div>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="py-4 text-center text-sm text-dim">No readings yet.</p>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function AssetFormModal({
  asset,
  assetTypes,
  onClose,
  onSaved,
}: {
  asset: Asset | null;
  assetTypes: { value: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = asset != null;
  const [name, setName] = useState(asset?.name ?? "");
  const [type, setType] = useState<AssetType>(asset?.type ?? "plumbing");
  const [status, setStatus] = useState<Asset["status"]>(asset?.status ?? "active");
  const [installDate, setInstallDate] = useState(asset?.install_date ?? "");
  const [warrantyEnd, setWarrantyEnd] = useState(asset?.warranty_end ?? "");
  const [meterValue, setMeterValue] = useState(asset?.meter_value ?? "");
  const [meterUnit, setMeterUnit] = useState(asset?.meter_unit ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        meter_value: meterValue === "" ? null : Number(meterValue),
        meter_unit: meterUnit.trim() || null,
      };
      if (editing) {
        body.status = status;
        body.warranty_end = warrantyEnd || null;
        await api.patch(`/assets/${asset.id}`, body);
      } else {
        body.type = type;
        body.install_date = installDate || null;
        body.warranty_end = warrantyEnd || null;
        await api.post("/assets", body);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the asset");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={editing ? `Edit asset — ${asset.name}` : "Add asset"}>
      <p className="-mt-2 mb-4 text-xs text-dim">
        {editing
          ? "Update the asset's details. Changes are applied to the asset register immediately."
          : "New assets appear in the register and can be tracked by maintenance plans and meters."}
      </p>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Main water pump" required maxLength={200} />
        </Field>
        {editing ? (
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as Asset["status"])}>
              <option value="active">Active</option>
              <option value="under_repair">Under repair</option>
              <option value="retired">Retired</option>
            </Select>
          </Field>
        ) : (
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as AssetType)}>
              {assetTypes.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={editing ? "Warranty ends" : "Installed"}>
            <CalendarPicker
              value={editing ? warrantyEnd : installDate}
              onChange={(v) => (editing ? setWarrantyEnd(v) : setInstallDate(v))}
            />
          </Field>
          {!editing ? (
            <Field label="Warranty ends">
              <CalendarPicker value={warrantyEnd} onChange={setWarrantyEnd} />
            </Field>
          ) : null}
          <Field label="Meter value">
            <Input type="number" min="0" step="any" value={meterValue} onChange={(e) => setMeterValue(e.target.value)} placeholder="e.g. 12850" />
          </Field>
          <Field label="Meter unit">
            <Input value={meterUnit} onChange={(e) => setMeterUnit(e.target.value)} placeholder="hours, kWh…" maxLength={20} />
          </Field>
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add asset"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
