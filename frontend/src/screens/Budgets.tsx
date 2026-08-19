import { useCallback, useEffect, useState } from "react";
import { api, download } from "../lib/api";
import { Button, Card, EmptyState, ErrorBanner, Field, Input, Modal, Select, Spinner, StatCard } from "../components/ui";
import { useI18n } from "../context/I18nContext";

// ---------------------------------------------------------------------------
// Budget Tracking — Phase 23.
//
// Annual budget lines per trade/category scoped to a property (or
// portfolio-wide). Actual spend is computed server-side from completed WOs,
// POs and paid invoices. The frontend shows a utilization bar and allows
// admin CRUD + CSV export.
// ---------------------------------------------------------------------------

interface Budget {
  id: string;
  name: string;
  trade: string;
  property_id: string | null;
  property_name: string | null;
  fiscal_year: number;
  planned_amount: string;
  actual_spend: string;
  spent_invoices: string;
  notes: string | null;
  created_at: string;
}

interface Property {
  id: string;
  name: string;
}

function fmt(n: string | number) {
  const v = typeof n === "string" ? parseFloat(n) : n;
  return v.toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(planned: string, actual: string) {
  const p = parseFloat(planned) || 0;
  const a = parseFloat(actual) || 0;
  return p > 0 ? Math.round((a / p) * 100) : 0;
}

function utilColor(p: number) {
  if (p >= 100) return "bg-danger";
  if (p >= 80) return "bg-amber";
  return "bg-gardening";
}

export default function Budgets() {
  const { t } = useI18n();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [yearFilter, setYearFilter] = useState<string>(String(new Date().getFullYear()));
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);
  const [form, setForm] = useState({ name: "", trade: "", property_id: "", fiscal_year: String(new Date().getFullYear()), planned_amount: "", notes: "" });
  const [saving, setSaving] = useState(false);

  const fetchBudgets = useCallback(async () => {
    try {
      setLoading(true);
      const params: Record<string, string | undefined> = {};
      if (yearFilter) params.fiscal_year = yearFilter;
      const data = await api.get<Budget[]>("/budgets", params);
      setBudgets(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [yearFilter]);

  useEffect(() => {
    void fetchBudgets();
  }, [fetchBudgets]);

  useEffect(() => {
    void api.get<{ data: Property[]; total: number }>("/properties").then((r) => setProperties(r.data ?? [])).catch(() => {});
  }, []);

  const totalPlanned = budgets.reduce((s, b) => s + parseFloat(b.planned_amount), 0);
  const totalActual = budgets.reduce((s, b) => s + parseFloat(b.actual_spend), 0);

  function openCreate() {
    setEditing(null);
    setForm({ name: "", trade: "", property_id: "", fiscal_year: yearFilter || String(new Date().getFullYear()), planned_amount: "", notes: "" });
    setOpen(true);
  }

  function openEdit(b: Budget) {
    setEditing(b);
    setForm({
      name: b.name,
      trade: b.trade,
      property_id: b.property_id || "",
      fiscal_year: String(b.fiscal_year),
      planned_amount: String(b.planned_amount),
      notes: b.notes || "",
    });
    setOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        trade: form.trade,
        property_id: form.property_id || null,
        fiscal_year: Number(form.fiscal_year),
        planned_amount: Number(form.planned_amount),
        notes: form.notes || null,
      };
      if (editing) {
        await api.patch(`/budgets/${editing.id}`, body);
      } else {
        await api.post("/budgets", body);
      }
      setOpen(false);
      await fetchBudgets();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this budget line?")) return;
    try {
      await api.del(`/budgets/${id}`);
      await fetchBudgets();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const years = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 2 + i);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6">
      {error && <ErrorBanner message={error} />}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-black text-ink">{t("nav.budgets")}</h1>
          <p className="text-sm text-dim">Track planned vs actual spend per trade.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)}>
            <option value="">All years</option>
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </Select>
          <Button onClick={() => void download(`/budgets?format=csv&fiscal_year=${yearFilter}`, "budgets.csv")} variant="secondary">CSV</Button>
          <Button onClick={openCreate}>+ Budget</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Planned" value={`KES ${fmt(totalPlanned)}`} />
        <StatCard label="Total Actual" value={`KES ${fmt(totalActual)}`} accent />
        <StatCard label="Remaining" value={`KES ${fmt(totalPlanned - totalActual)}`} />
      </div>

      {budgets.length === 0 ? (
        <EmptyState title="No budgets yet" body="Create your first budget line to start tracking spend." />
      ) : (
        <div className="space-y-3">
          {budgets.map((b) => {
            const util = pct(b.planned_amount, b.actual_spend);
            const remaining = parseFloat(b.planned_amount) - parseFloat(b.actual_spend);
            return (
              <Card key={b.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-ink">{b.name}</p>
                    <p className="text-xs text-dim">{b.trade} {b.property_name ? `· ${b.property_name}` : "· Portfolio-wide"} · {b.fiscal_year}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" onClick={() => openEdit(b)}>Edit</Button>
                    <Button variant="ghost" onClick={() => void handleDelete(b.id)}>Delete</Button>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-dim">
                  <span>Planned: <strong className="text-ink">KES {fmt(b.planned_amount)}</strong></span>
                  <span>Actual: <strong className="text-ink">KES {fmt(b.actual_spend)}</strong></span>
                  <span>Remaining: <strong className={remaining < 0 ? "text-danger" : "text-ink"}>KES {fmt(remaining)}</strong></span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded bg-panel-2">
                  <div className={`h-full rounded ${utilColor(util)} transition-all`} style={{ width: `${Math.min(util, 100)}%` }} />
                </div>
                <p className="mt-1 text-right text-xs text-dim">{util}% utilized</p>
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "Edit Budget" : "New Budget"}>
        <div className="space-y-4">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Plumbing Annual Budget" />
          </Field>
          <Field label="Trade">
            <Input value={form.trade} onChange={(e) => setForm({ ...form, trade: e.target.value })} placeholder="e.g. plumbing, electrical" />
          </Field>
          <Field label="Property (optional — blank = portfolio-wide)">
            <Select value={form.property_id} onChange={(e) => setForm({ ...form, property_id: e.target.value })}>
              <option value="">All properties</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fiscal Year">
              <Input type="number" value={form.fiscal_year} onChange={(e) => setForm({ ...form, fiscal_year: e.target.value })} />
            </Field>
            <Field label="Planned Amount (KES)">
              <Input type="number" value={form.planned_amount} onChange={(e) => setForm({ ...form, planned_amount: e.target.value })} />
            </Field>
          </div>
          <Field label="Notes">
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional" />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleSave()} disabled={saving}>{editing ? "Save" : "Create"}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
