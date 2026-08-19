import { useCallback, useEffect, useState } from "react";
import { api, download } from "../lib/api";
import { Button, Card, Field, Input, Select, Spinner } from "../components/ui";

// ---------------------------------------------------------------------------
// Report Builder — Phase 18.
//
// Self-service export of operational data into CSV (or JSON preview).
// Four report types: Work Orders, Asset Register, Compliance, Spending,
// Inventory.  Each has its own filter set and column definition.
// ---------------------------------------------------------------------------

type ReportKind = "work-orders" | "assets" | "compliance" | "spending" | "inventory";

const REPORTS: { id: ReportKind; label: string; description: string }[] = [
  { id: "work-orders", label: "Work Orders", description: "Filtered work order export with cost, status, and failure codes." },
  { id: "assets", label: "Asset Register", description: "Full asset inventory with location, warranty, and meter data." },
  { id: "compliance", label: "Compliance", description: "Statutory inspection and staff competency status." },
  { id: "spending", label: "Spending", description: "Purchase order and invoice totals grouped by month or quarter." },
  { id: "inventory", label: "Inventory", description: "Stock levels, reorder thresholds, and warehouse locations." },
];

// ---- Helpers ---------------------------------------------------------------

function downloadCsv(kind: ReportKind, params: Record<string, string>) {
  const qs = new URLSearchParams({ format: "csv", ...params }).toString();
  return download(`/reports/${kind}?${qs}`, `${kind}.csv`);
}

interface TableProps {
  columns: string[];
  rows: Record<string, unknown>[];
}

function ReportTable({ columns, rows }: TableProps) {
  if (!rows.length) {
    return <p className="py-6 text-center text-sm text-dim">No data matches the current filters.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => (
              <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-semibold text-dim">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/50 hover:bg-panel-2/50">
              {columns.map((c) => (
                <td key={c} className="whitespace-nowrap px-3 py-1.5 text-ink">{String(r[c] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DateFilter({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="text-xs" />
    </Field>
  );
}

// ---- Individual report panels -----------------------------------------------

function WorkOrdersPanel() {
  const [status, setStatus] = useState("");
  const [trade, setTrade] = useState("");
  const [priority, setPriority] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const preview = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      if (trade) params.trade = trade;
      if (priority) params.priority = priority;
      if (from) params.created_after = from;
      if (to) params.created_before = to;
      const res = await api.get<{ columns: string[]; rows: Record<string, unknown>[] }>("/reports/work-orders", params);
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [status, trade, priority, from, to]);

  useEffect(() => { void preview(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {["open", "assigned", "in_progress", "done", "verified", "cancelled"].map((s) => (
              <option key={s} value={s}>{s.replace("_", " ")}</option>
            ))}
          </Select>
        </Field>
        <Field label="Trade">
          <Select value={trade} onChange={(e) => setTrade(e.target.value)}>
            <option value="">All</option>
            {["plumbing", "electrical", "gardening", "janitorial", "general"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">All</option>
            {["low", "normal", "high", "urgent"].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </Select>
        </Field>
        <DateFilter label="From" value={from} onChange={setFrom} />
        <DateFilter label="To" value={to} onChange={setTo} />
        <Button onClick={preview} disabled={loading} className="mb-0.5">Preview</Button>
        <Button variant="ghost" onClick={() => downloadCsv("work-orders", { status, trade, priority, created_after: from, created_before: to })} className="mb-0.5">Export CSV</Button>
      </div>
      {loading ? <Spinner /> : data ? <ReportTable columns={data.columns} rows={data.rows} /> : null}
    </div>
  );
}

function AssetsPanel() {
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [data, setData] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const preview = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (type) params.type = type;
      if (status) params.status = status;
      const res = await api.get<{ columns: string[]; rows: Record<string, unknown>[] }>("/reports/assets", params);
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [type, status]);

  useEffect(() => { void preview(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Type">
          <Input value={type} onChange={(e) => setType(e.target.value)} placeholder="e.g. pump, generator" className="text-xs" />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {["active", "retired", "under_repair"].map((s) => (
              <option key={s} value={s}>{s.replace("_", " ")}</option>
            ))}
          </Select>
        </Field>
        <Button onClick={preview} disabled={loading} className="mb-0.5">Preview</Button>
        <Button variant="ghost" onClick={() => downloadCsv("assets", { type, status })} className="mb-0.5">Export CSV</Button>
      </div>
      {loading ? <Spinner /> : data ? <ReportTable columns={data.columns} rows={data.rows} /> : null}
    </div>
  );
}

function CompliancePanel() {
  const [kind, setKind] = useState("all");
  const [data, setData] = useState<{ inspections?: Record<string, unknown>[]; competencies?: Record<string, unknown>[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const preview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ inspections?: Record<string, unknown>[]; competencies?: Record<string, unknown>[] }>("/reports/compliance", { kind });
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { void preview(); }, []);

  const inspCols = ["requirement", "asset_name", "frequency_days", "last_done_at", "due_date", "overdue"];
  const compCols = ["user_name", "name", "trade", "expires_at", "expired"];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">All</option>
            <option value="inspections">Statutory Inspections</option>
            <option value="competencies">Staff Competencies</option>
          </Select>
        </Field>
        <Button onClick={preview} disabled={loading} className="mb-0.5">Preview</Button>
        <Button variant="ghost" onClick={() => downloadCsv("compliance", { kind })} className="mb-0.5">Export CSV</Button>
      </div>
      {loading ? <Spinner /> : data ? (
        <div className="space-y-6">
          {data.inspections ? (
            <div>
              <h3 className="mb-2 text-sm font-bold text-ink">Statutory Inspections</h3>
              <ReportTable columns={inspCols} rows={data.inspections} />
            </div>
          ) : null}
          {data.competencies ? (
            <div>
              <h3 className="mb-2 text-sm font-bold text-ink">Staff Competencies</h3>
              <ReportTable columns={compCols} rows={data.competencies} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SpendingPanel() {
  const [period, setPeriod] = useState("month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const preview = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { period };
      if (from) params.start_date = from;
      if (to) params.end_date = to;
      const res = await api.get<{ columns: string[]; rows: Record<string, unknown>[] }>("/reports/spending", params);
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [period, from, to]);

  useEffect(() => { void preview(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Period">
          <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="month">Monthly</option>
            <option value="quarter">Quarterly</option>
          </Select>
        </Field>
        <DateFilter label="From" value={from} onChange={setFrom} />
        <DateFilter label="To" value={to} onChange={setTo} />
        <Button onClick={preview} disabled={loading} className="mb-0.5">Preview</Button>
        <Button variant="ghost" onClick={() => downloadCsv("spending", { period, start_date: from, end_date: to })} className="mb-0.5">Export CSV</Button>
      </div>
      {loading ? <Spinner /> : data ? <ReportTable columns={data.columns} rows={data.rows} /> : null}
    </div>
  );
}

function InventoryPanel() {
  const [trade, setTrade] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [data, setData] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const preview = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (trade) params.trade = trade;
      if (lowOnly) params.low_only = "true";
      const res = await api.get<{ columns: string[]; rows: Record<string, unknown>[] }>("/reports/inventory", params);
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [trade, lowOnly]);

  useEffect(() => { void preview(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Trade">
          <Select value={trade} onChange={(e) => setTrade(e.target.value)}>
            <option value="">All</option>
            {["plumbing", "electrical", "gardening", "janitorial", "general"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <label className="mb-0.5 flex items-center gap-2 text-xs text-dim">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="rounded border-line" />
          Low stock only
        </label>
        <Button onClick={preview} disabled={loading} className="mb-0.5">Preview</Button>
        <Button variant="ghost" onClick={() => downloadCsv("inventory", { trade, low_only: lowOnly ? "true" : "" })} className="mb-0.5">Export CSV</Button>
      </div>
      {loading ? <Spinner /> : data ? <ReportTable columns={data.columns} rows={data.rows} /> : null}
    </div>
  );
}

// ---- Main screen -----------------------------------------------------------

export default function Reports() {
  const [kind, setKind] = useState<ReportKind>("work-orders");

  const Panel =
    kind === "work-orders" ? WorkOrdersPanel :
    kind === "assets" ? AssetsPanel :
    kind === "compliance" ? CompliancePanel :
    kind === "spending" ? SpendingPanel :
    InventoryPanel;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink">Reports</h1>
        <p className="text-sm text-dim">Preview data on screen, then export to CSV for audits and external analysis.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {REPORTS.map((r) => (
          <button
            key={r.id}
            onClick={() => setKind(r.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
              kind === r.id ? "bg-amber text-bg" : "border border-line text-dim hover:text-ink"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <Card className="p-4">
        <p className="mb-4 text-xs text-dim">{REPORTS.find((r) => r.id === kind)?.description}</p>
        <Panel />
      </Card>
    </div>
  );
}
