import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ConfigType } from "../lib/types";
import { Button, Card, Field, Input, Select, Spinner, Textarea } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { useConfig } from "../context/ConfigContext";
import { api, download } from "../lib/api";

// Vocabulary settings: trades and asset types are runtime-configurable per org
// (stored in lookup tables, validated by the API). Admins can add new options
// or deactivate ones no longer in use.
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function VocabCard({
  title,
  subtitle,
  items,
  canEdit,
  onAdd,
  onToggle,
}: {
  title: string;
  subtitle: string;
  items: ConfigType[];
  canEdit: boolean;
  onAdd: (value: string, label: string) => Promise<void>;
  onToggle: (value: string, active: boolean) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value || !label) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd(slugify(value), label.trim());
      setValue("");
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add option");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="text-base font-bold text-ink">{title}</h2>
      <p className="text-sm text-dim">{subtitle}</p>

      <div className="mt-4 divide-y divide-line">
        {items.length === 0 ? (
          <p className="py-3 text-sm text-dim">No options yet.</p>
        ) : (
          items.map((item) => (
            <div key={item.value} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="text-sm font-medium text-ink">{item.label}</p>
                <p className="text-xs text-dim">{item.value}</p>
              </div>
              {canEdit ? (
                <button
                  type="button"
                  disabled={busy === item.value}
                  onClick={async () => {
                    setBusy(item.value);
                    try {
                      await onToggle(item.value, !item.active);
                    } finally {
                      setBusy(null);
                    }
                  }}
                  className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${
                    item.active ? "bg-gardening/15 text-gardening hover:bg-gardening/25" : "bg-dim/10 text-dim hover:bg-dim/20"
                  }`}
                >
                  {item.active ? "Active" : "Inactive"}
                </button>
              ) : item.active ? (
                <span className="inline-flex items-center rounded-full bg-gardening/15 px-2.5 py-1 text-xs font-semibold text-gardening">
                  Active
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-dim/10 px-2.5 py-1 text-xs font-semibold text-dim">
                  Inactive
                </span>
              )}
            </div>
          ))
        )}
      </div>

      {canEdit ? (
        <form onSubmit={submit} className="mt-4 flex items-end gap-3 border-t border-line pt-4">
          <Field label="Value (slug)">
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. welding" required />
          </Field>
          <Field label="Display label">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Welding" required />
          </Field>
          <Button type="submit" disabled={saving}>
            {saving ? "Adding…" : "Add"}
          </Button>
        </form>
      ) : null}
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
    </Card>
  );
}

const KNOWN_EVENTS = [
  "work_order.created",
  "work_order.assigned",
  "work_order.closed",
  "inventory.low_stock",
  "asset.threshold_crossed",
  "compliance.permit_issued",
] as const;

const EXPORT_KINDS = [
  { kind: "work_orders", label: "Work orders" },
  { kind: "assets", label: "Assets" },
  { kind: "inventory_items", label: "Inventory" },
  { kind: "users", label: "Users" },
  { kind: "properties", label: "Properties" },
] as const;

const IMPORT_KINDS = [
  { kind: "assets", label: "Assets (name, type, status…)" },
  { kind: "inventory_items", label: "Inventory (name, unit, trade…)" },
  { kind: "properties", label: "Properties (name, address…)" },
] as const;

interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  last_status: number | null;
}

// Phase 12 — integrations panel: webhook subscriptions, connector registry,
// CSV export/import, and a link to the public data dictionary.
function IntegrationCards({ canEdit }: { canEdit: boolean }) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [connectors, setConnectors] = useState<{ id: string; name: string; kind: string; description: string }[]>([]);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", secret: "", events: [] as string[] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [importKind, setImportKind] = useState<string>("assets");
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const [wh, co] = await Promise.all([api.get<{ data: Webhook[] }>("/webhooks"), api.get<{ data: typeof connectors }>("/integrations/connectors")]);
      setWebhooks(wh.data ?? []);
      setConnectors(co.data ?? []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeForm = () => {
    setShowForm(false);
    setForm({ name: "", url: "", secret: "", events: [] });
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post("/webhooks", {
        name: form.name,
        url: form.url,
        secret: form.secret || undefined,
        events: form.events,
      });
      closeForm();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add webhook");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (w: Webhook) => {
    setBusyId(w.id);
    try {
      await api.patch(`/webhooks/${w.id}`, { active: !w.active });
      reload();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (w: Webhook) => {
    if (!window.confirm(`Remove webhook "${w.name}"?`)) return;
    setBusyId(w.id);
    try {
      await api.del(`/webhooks/${w.id}`);
      reload();
    } finally {
      setBusyId(null);
    }
  };

  const runImport = async () => {
    setImportMsg(null);
    if (!importText.trim()) {
      setImportMsg("Paste CSV rows first.");
      return;
    }
    try {
      const res = await api.post<{ imported: number; skipped: number; errors: { row: Record<string, string>; message: string }[] }>(
        `/integrations/import/${importKind}`,
        { csv: importText }
      );
      setImportMsg(`Imported ${res.imported}${res.skipped ? `, skipped ${res.skipped}` : ""}.`);
      setImportText("");
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : "Import failed");
    }
  };

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-ink">Integrations</h2>
            <p className="text-sm text-dim">
              Outbound webhooks and connectors. Webhooks POST JSON with an <code className="text-ink">X-Facilix-Signature</code> HMAC-SHA256 header.
            </p>
          </div>
          {canEdit ? (
            <Button type="button" onClick={() => setShowForm((v) => !v)}>
              {showForm ? "Cancel" : "Add webhook"}
            </Button>
          ) : null}
        </div>

        {showForm ? (
          <form onSubmit={submit} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Power BI pipeline" required />
            </Field>
            <Field label="Endpoint URL">
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://hooks.example.com/facilix" required />
            </Field>
            <Field label="Signing secret (≥16 chars, optional — one is generated)">
              <Input value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="leave blank to auto-generate" />
            </Field>
            <div className="sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-dim">Events</span>
              <div className="flex flex-wrap gap-2">
                {KNOWN_EVENTS.map((ev) => {
                  const checked = form.events.includes(ev);
                  return (
                    <label key={ev} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs">
                      <input
                        type="checkbox"
                        className="accent-gardening"
                        checked={checked}
                        onChange={() =>
                          setForm({ ...form, events: checked ? form.events.filter((x) => x !== ev) : [...form.events, ev] })
                        }
                      />
                      {ev}
                    </label>
                  );
                })}
              </div>
            </div>
            {error ? <p className="sm:col-span-2 text-sm text-danger">{error}</p> : null}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={saving || form.events.length === 0}>
                {saving ? "Saving…" : "Save webhook"}
              </Button>
            </div>
          </form>
        ) : null}

        <div className="mt-4 divide-y divide-line">
          {loading ? (
            <p className="py-3 text-sm text-dim">Loading…</p>
          ) : webhooks.length === 0 ? (
            <p className="py-3 text-sm text-dim">No webhooks yet.</p>
          ) : (
            webhooks.map((w) => (
              <div key={w.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{w.name}</p>
                  <p className="truncate text-xs text-dim">{w.url}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {w.events.map((ev) => (
                      <span key={ev} className="rounded-full bg-panel-2 px-2 py-0.5 text-xs text-dim">{ev}</span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {w.last_status != null ? (
                    <span className="text-xs text-dim">last {w.last_status}</span>
                  ) : null}
                  {canEdit ? (
                    <>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busyId === w.id} onClick={() => toggleActive(w)}>
                        {w.active ? "Pause" : "Resume"}
                      </Button>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs !text-danger hover:!bg-danger/10" disabled={busyId === w.id} onClick={() => remove(w)}>
                        Remove
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="text-base font-bold text-ink">Connectors</h2>
          <p className="text-sm text-dim">External systems Facilix can sync with.</p>
          <div className="mt-4 space-y-3">
            {connectors.map((c) => (
              <div key={c.id} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-ink">{c.name}</p>
                  <span className="rounded-full bg-dim/10 px-2 py-0.5 text-xs text-dim">Available</span>
                </div>
                <p className="mt-1 text-xs text-dim">{c.description}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-base font-bold text-ink">Data export</h2>
          <p className="text-sm text-dim">Download CSV for spreadsheets or BI tools.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {EXPORT_KINDS.map((k) => (
              <Button key={k.kind} variant="secondary" className="!py-1.5 text-sm" onClick={() => download(`/integrations/export/${k.kind}?format=csv`, `${k.kind}.csv`)}>
                {k.label}
              </Button>
            ))}
          </div>

          <h2 className="mt-6 text-base font-bold text-ink">Data import</h2>
          <p className="text-sm text-dim">Paste CSV with a header row.</p>
          <div className="mt-3 space-y-2">
            <Select value={importKind} onChange={(e) => setImportKind(e.target.value)}>
              {IMPORT_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>{k.label}</option>
              ))}
            </Select>
            <Textarea rows={5} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={"name,type,status\nBackup generator,electrical,active"} />
            {canEdit ? (
              <Button onClick={runImport}>Import CSV</Button>
            ) : (
              <p className="text-xs text-dim">Only admins and managers can import data.</p>
            )}
            {importMsg ? <p className="text-sm text-gardening">{importMsg}</p> : null}
          </div>

          <p className="mt-4 text-xs text-dim">
            See the <a className="underline" href="/api/integrations/data-dictionary" target="_blank" rel="noreferrer">data dictionary</a> for the full API reference.
          </p>
        </Card>
      </div>
    </div>
  );
}

// Phase 22 — audit trail viewer.  Shows recent change events with entity,
// action, actor, and timestamp.  Filters by entity type and date range.
// Only visible to admins/managers.

interface AuditEntry {
  id: number;
  created_at: string;
  actor_name: string | null;
  action: string;
  entity: string;
  entity_id: string;
  summary: string;
  ip_address: string | null;
}

function AuditLogCard({ canEdit }: { canEdit: boolean }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [entities, setEntities] = useState<string[]>([]);
  const [entityFilter, setEntityFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (entityFilter) params.entity = entityFilter;
      if (actionFilter) params.action = actionFilter;
      const res = await api.get<{ data: AuditEntry[] }>("/audit-log", params);
      setEntries(res.data ?? []);
    } catch { /* admin-only */ }
    setLoading(false);
  };

  const loadEntities = async () => {
    try {
      const res = await api.get<string[]>("/audit-log/entities");
      setEntities(res ?? []);
    } catch { /* admin-only */ }
  };

  useEffect(() => { if (canEdit) { void loadEntities(); void load(); } }, []);

  if (!canEdit) return null;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-ink">Audit trail</h2>
          <p className="text-xs text-dim">Who changed what — exportable for compliance audits.</p>
        </div>
        <button
          onClick={() => download("/audit-log?format=csv", "audit-log.csv")}
          className="text-xs font-semibold text-amber hover:underline"
        >
          Export CSV
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Entity">
          <Select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}>
            <option value="">All</option>
            {entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </Select>
        </Field>
        <Field label="Action">
          <Select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
            <option value="">All</option>
            <option value="INSERT">Created</option>
            <option value="UPDATE">Updated</option>
            <option value="DELETE">Deleted</option>
          </Select>
        </Field>
        <Button onClick={load} disabled={loading} className="mb-0.5">Refresh</Button>
      </div>

      {loading ? <Spinner /> : !entries.length ? (
        <p className="py-3 text-center text-xs text-dim">No audit entries yet.</p>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line">
                <th className="px-2 py-1.5 text-left text-dim">Time</th>
                <th className="px-2 py-1.5 text-left text-dim">Actor</th>
                <th className="px-2 py-1.5 text-left text-dim">Action</th>
                <th className="px-2 py-1.5 text-left text-dim">Entity</th>
                <th className="px-2 py-1.5 text-left text-dim">Summary</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-line/50 hover:bg-panel-2/50">
                  <td className="whitespace-nowrap px-2 py-1 text-ink">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="px-2 py-1 text-ink">{e.actor_name ?? "system"}</td>
                  <td className="px-2 py-1">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                      e.action === "INSERT" ? "bg-gardening/20 text-gardening" :
                      e.action === "DELETE" ? "bg-danger/20 text-danger" :
                      "bg-amber/20 text-amber"
                    }`}>{e.action === "INSERT" ? "create" : e.action === "DELETE" ? "delete" : "update"}</span>
                  </td>
                  <td className="px-2 py-1 text-dim">{e.entity}</td>
                  <td className="px-2 py-1 text-ink">{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const { config, addTrade, addAssetType, toggleTrade, toggleAssetType, setAutoAssign } = useConfig();
  const canEdit = user?.role === "admin" || user?.role === "manager";
  const [savingAutoAssign, setSavingAutoAssign] = useState(false);

  if (!config) return <Spinner />;

  async function toggleAutoAssign() {
    const cfg = config;
    if (!cfg) return;
    setSavingAutoAssign(true);
    try {
      await setAutoAssign(!cfg.auto_assign_suppliers);
    } finally {
      setSavingAutoAssign(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink">Settings</h1>
        <p className="text-sm text-dim">
          Configurable vocabulary — add new trades and asset types that the whole workspace can use, plus
          integrations to connect Facilix to the rest of your stack.
        </p>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-ink">Auto-assign suppliers</h2>
            <p className="text-xs text-dim">
              Route urgent/high-priority breakdowns straight to the least-loaded supplier for the trade. Orders
              move to Assigned and notify the contractor automatically.
            </p>
          </div>
          {canEdit ? (
            <Button variant={config.auto_assign_suppliers ? "primary" : "ghost"} onClick={toggleAutoAssign} disabled={savingAutoAssign}>
              {savingAutoAssign ? "Saving…" : config.auto_assign_suppliers ? "On — disable" : "Off — enable"}
            </Button>
          ) : (
            <span className="text-xs text-dim">{config.auto_assign_suppliers ? "Enabled" : "Disabled"}</span>
          )}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <VocabCard
          title="Trades"
          subtitle="Used on work orders, suppliers, inventory, and staff."
          items={[...config.trades].sort((a, b) => a.label.localeCompare(b.label))}
          canEdit={canEdit}
          onAdd={addTrade}
          onToggle={toggleTrade}
        />
        <VocabCard
          title="Asset types"
          subtitle="Used when classifying equipment and maintenance plans."
          items={[...config.asset_types].sort((a, b) => a.label.localeCompare(b.label))}
          canEdit={canEdit}
          onAdd={addAssetType}
          onToggle={toggleAssetType}
        />
      </div>

      <AuditLogCard canEdit={canEdit} />

      <IntegrationCards canEdit={canEdit} />
    </div>
  );
}
