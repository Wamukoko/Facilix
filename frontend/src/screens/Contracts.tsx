import { useState } from "react";
import type { FormEvent } from "react";
import type { Contract, ContractStatus, Paged, Property, PurchaseOrderStatus, Supplier } from "../lib/types";
import { Button, Card, EmptyState, Field, Input, Modal, Select, Spinner } from "../components/ui";
import { CalendarPicker } from "../components/CalendarPicker";
import { CONTRACT_STATUSES, CONTRACT_TYPES, PO_STATUSES, formatCost, formatDate } from "../lib/format";
import { api } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { useAuth } from "../context/AuthContext";
import DocumentAttachments from "../components/DocumentAttachments";

const FILTERS: { id: ContractStatus | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "expiring", label: "Expiring soon" },
  { id: "expired", label: "Expired" },
  { id: "terminated", label: "Terminated" },
];

function ContractStatusBadge({ status }: { status: ContractStatus }) {
  const s = CONTRACT_STATUSES[status] ?? CONTRACT_STATUSES.active;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${s.text} ${s.bg}`}>
      {s.label}
    </span>
  );
}

function PoStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const s = PO_STATUSES[status] ?? { label: status, text: "text-dim", bg: "bg-dim/15" };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${s.text} ${s.bg}`}>
      {s.label}
    </span>
  );
}

interface FormState {
  contract_type: string;
  supplier_id: string;
  property_id: string;
  start_date: string;
  end_date: string;
  annual_value: string;
  renewal_notice_days: string;
  notes: string;
}

function emptyForm(): FormState {
  return {
    contract_type: "service",
    supplier_id: "",
    property_id: "",
    start_date: "",
    end_date: "",
    annual_value: "",
    renewal_notice_days: "30",
    notes: "",
  };
}

function spendPercent(c: Contract): number | null {
  if (!c.annual_value) return null;
  const annual = Number(c.annual_value);
  if (annual <= 0) return null;
  return Math.min(100, Math.round((c.po_spend / annual) * 100));
}

export default function Contracts() {
  const { user } = useAuth();
  const canManage = user?.role === "admin" || user?.role === "manager";

  const [filter, setFilter] = useState<ContractStatus | "all">("all");
  const [detail, setDetail] = useState<Contract | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Contract | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const { data, loading, error, reload } = useFetch<Paged<Contract>>("/contracts", { limit: 200 });
  const { data: suppliersData } = useFetch<Paged<Supplier>>("/suppliers", { limit: 200 });
  const { data: propertiesData } = useFetch<Paged<Property>>("/properties", { limit: 200 });

  if (loading) return <Spinner />;
  if (error) return <Card className="p-4 text-danger">{error}</Card>;

  const rows = data?.data ?? [];
  const filtered = filter === "all" ? rows : rows.filter((c) => c.effective_status === filter);
  const suppliers = suppliersData?.data ?? [];
  const properties = propertiesData?.data ?? [];

  const openDetail = async (c: Contract) => {
    setDetail(c);
    setDetailLoading(true);
    setActionError(null);
    try {
      const fresh = await api.get<Contract>(`/contracts/${c.id}`);
      setDetail(fresh);
    } catch {
      // keep the card as the detail view
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setDetail(null);
    setActionError(null);
  };

  const openEdit = (c: Contract) => {
    setEditing(c);
    setForm({
      contract_type: c.contract_type,
      supplier_id: c.supplier_id ?? "",
      property_id: c.property_id ?? "",
      start_date: c.start_date ?? "",
      end_date: c.end_date ?? "",
      annual_value: c.annual_value ? String(Number(c.annual_value)) : "",
      renewal_notice_days: String(c.renewal_notice_days),
      notes: c.notes ?? "",
    });
  };

  const submitForm = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setActionError(null);
    const payload = {
      contract_type: form.contract_type,
      supplier_id: form.supplier_id || null,
      property_id: form.property_id || null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      annual_value: form.annual_value ? Number(form.annual_value) : null,
      renewal_notice_days: Number(form.renewal_notice_days) || 30,
      notes: form.notes || null,
    };
    try {
      if (editing) {
        await api.patch(`/contracts/${editing.id}`, payload);
      } else {
        await api.post("/contracts", payload);
      }
      setShowCreate(false);
      setEditing(null);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not save contract");
    } finally {
      setSaving(false);
    }
  };

  const runExpiryCheck = async () => {
    setChecking(true);
    setActionError(null);
    try {
      await api.post("/contracts/check-expiry");
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Expiry check failed");
    } finally {
      setChecking(false);
    }
  };

  const terminate = async (c: Contract) => {
    setActionError(null);
    try {
      await api.post(`/contracts/${c.id}/terminate`);
      reload();
      if (detail?.id === c.id) openDetail({ ...c, status: "terminated" });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not terminate contract");
    }
  };

  const pct = (c: Contract) => spendPercent(c);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Supplier contracts</h1>
          <p className="text-sm text-dim">Track agreements, spend vs annual value, and renewal windows.</p>
        </div>
        <div className="flex gap-2">
          {canManage ? (
            <>
              <Button variant="secondary" onClick={runExpiryCheck} disabled={checking}>
                {checking ? "Checking…" : "Re-check expiries"}
              </Button>
              <Button onClick={() => { setEditing(null); setForm(emptyForm()); setShowCreate(true); }}>
                New contract
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
              filter === f.id ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <Card className="p-6">
          <EmptyState title="No contracts" body="Create a contract to track a supplier agreement and its spend." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((c) => (
            <Card key={c.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <button onClick={() => openDetail(c)} className="text-base font-bold text-ink hover:text-amber">
                    {c.contract_number}
                  </button>
                  <p className="truncate text-xs text-dim">
                    {CONTRACT_TYPES[c.contract_type] ?? c.contract_type} · {c.supplier_name ?? "—"}
                    {c.property_name ? ` · ${c.property_name}` : ""}
                  </p>
                </div>
                <ContractStatusBadge status={c.effective_status} />
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-dim">
                <span>
                  {formatDate(c.start_date)} → {formatDate(c.end_date)}
                </span>
                {c.effective_status === "expiring" ? (
                  <span className="font-semibold text-amber">{c.days_to_expiry}d to expiry</span>
                ) : c.effective_status === "expired" ? (
                  <span className="font-semibold text-danger">Term ended</span>
                ) : null}
              </div>

              <div className="mt-auto space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-dim">Spend</span>
                  <span className="font-semibold text-ink">
                    {formatCost(c.po_spend)}
                    {c.annual_value ? ` / ${formatCost(c.annual_value)}` : " / —"}
                  </span>
                </div>
                {pct(c) !== null ? (
                  <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
                    <div
                      className={`h-full rounded-full ${c.over_budget ? "bg-danger" : "bg-gardening"}`}
                      style={{ width: `${pct(c)}%` }}
                    />
                  </div>
                ) : null}
                {c.over_budget ? (
                  <p className="text-xs font-semibold text-danger">Spend is over the annual value — review.</p>
                ) : null}
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
                <span className="text-xs text-dim">
                  {c.po_count} purchase order{c.po_count === 1 ? "" : "s"}
                </span>
                <div className="flex gap-1">
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => openDetail(c)}>
                    View
                  </Button>
                  {canManage && c.effective_status !== "terminated" ? (
                    <>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => openEdit(c)}>
                        Edit
                      </Button>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs text-danger" onClick={() => terminate(c)}>
                        Terminate
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={showCreate || editing != null}
        onClose={() => { setShowCreate(false); setEditing(null); }}
        title={editing ? `Edit ${editing.contract_number}` : "New contract"}
      >
        <form onSubmit={submitForm} className="space-y-4">
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <Select value={form.contract_type} onChange={(e) => setForm({ ...form, contract_type: e.target.value })}>
                {Object.entries(CONTRACT_TYPES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Renewal notice (days)">
              <Input
                type="number"
                min="1"
                max="365"
                value={form.renewal_notice_days}
                onChange={(e) => setForm({ ...form, renewal_notice_days: e.target.value })}
                required
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Supplier">
              <Select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
                <option value="">—</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Property">
              <Select value={form.property_id} onChange={(e) => setForm({ ...form, property_id: e.target.value })}>
                <option value="">—</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date">
              <CalendarPicker
                value={form.start_date}
                onChange={(v) => setForm({ ...form, start_date: v })}
                placeholder="Pick a date"
              />
            </Field>
            <Field label="End date">
              <CalendarPicker
                value={form.end_date}
                onChange={(v) => setForm({ ...form, end_date: v })}
                placeholder="Pick a date"
              />
            </Field>
          </div>
          <Field label="Annual value (KES)">
            <Input
              type="number"
              min="0"
              step="any"
              value={form.annual_value}
              onChange={(e) => setForm({ ...form, annual_value: e.target.value })}
              placeholder="e.g. 1200000"
            />
          </Field>
          <Field label="Notes">
            <Input
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="optional"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => { setShowCreate(false); setEditing(null); }}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : editing ? "Save changes" : "Create contract"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={detail != null} onClose={closeDetail} title={detail ? `Contract ${detail.contract_number}` : ""}>
        {detailLoading ? (
          <Spinner />
        ) : detail ? (
          <div className="space-y-4">
            {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <ContractStatusBadge status={detail.effective_status} />
              <span className="text-dim">
                {CONTRACT_TYPES[detail.contract_type] ?? detail.contract_type} · {detail.supplier_name ?? "—"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-dim">Property</p>
                <p className="font-medium text-ink">{detail.property_name ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-dim">Term</p>
                <p className="font-medium text-ink">
                  {formatDate(detail.start_date)} → {formatDate(detail.end_date)}
                </p>
              </div>
              <div>
                <p className="text-xs text-dim">Annual value</p>
                <p className="font-medium text-ink">{formatCost(detail.annual_value)}</p>
              </div>
              <div>
                <p className="text-xs text-dim">Spend committed</p>
                <p className={`font-medium ${detail.over_budget ? "text-danger" : "text-ink"}`}>
                  {formatCost(detail.po_spend)}
                  {detail.over_budget ? " — over budget" : ""}
                </p>
              </div>
              <div>
                <p className="text-xs text-dim">Renewal notice</p>
                <p className="font-medium text-ink">{detail.renewal_notice_days} days</p>
              </div>
              <div>
                <p className="text-xs text-dim">Days to expiry</p>
                <p className="font-medium text-ink">
                  {detail.days_to_expiry == null ? "—" : detail.days_to_expiry < 0 ? "Expired" : `${detail.days_to_expiry} days`}
                </p>
              </div>
            </div>
            {detail.notes ? <p className="text-sm text-dim">{detail.notes}</p> : null}

            <div>
              <p className="mb-2 text-sm font-semibold text-ink">Linked purchase orders</p>
              {!detail.purchase_orders || detail.purchase_orders.length === 0 ? (
                <p className="text-sm text-dim">No purchase orders committed against this contract.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                      <th className="py-2 font-semibold">PO</th>
                      <th className="py-2 font-semibold">Status</th>
                      <th className="py-2 font-semibold">Expected</th>
                      <th className="py-2 font-semibold text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.purchase_orders.map((po) => (
                      <tr key={po.id} className="border-b border-line last:border-0">
                        <td className="py-2 font-medium text-ink">{po.po_number}</td>
                        <td className="py-2">
                          <PoStatusBadge status={po.status} />
                        </td>
                        <td className="py-2 text-dim">{formatDate(po.expected_date)}</td>
                        <td className="py-2 text-right text-ink">{formatCost(po.po_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <p className="mb-2 text-sm font-semibold text-ink">Documents</p>
              <DocumentAttachments entityType="contract" entityId={detail.id} />
            </div>

            {canManage && detail.effective_status !== "terminated" ? (
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={() => openEdit(detail)}>
                  Edit
                </Button>
                <Button className="bg-danger text-white hover:bg-danger/90" onClick={() => terminate(detail)}>
                  Terminate contract
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
