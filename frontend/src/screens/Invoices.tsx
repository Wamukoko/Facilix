import { useState } from "react";
import type { Invoice, InvoiceStatus, Paged } from "../lib/types";
import { Button, Card, EmptyState, Spinner } from "../components/ui";
import { INVOICE_STATUSES, formatCost, formatDate } from "../lib/format";
import { api } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { useAuth } from "../context/AuthContext";

const FILTERS: { id: InvoiceStatus | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "issued", label: "Issued" },
  { id: "paid", label: "Paid" },
  { id: "void", label: "Void" },
];

function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const s = INVOICE_STATUSES[status] ?? { label: status, text: "text-dim", bg: "bg-dim/15" };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${s.text} ${s.bg}`}>
      {s.label}
    </span>
  );
}

export default function Invoices() {
  const { user } = useAuth();
  const canManage = user?.role === "admin" || user?.role === "manager" || user?.role === "technician";

  const [filter, setFilter] = useState<InvoiceStatus | "all">("all");
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const query = filter === "all" ? "" : `?status=${filter}`;
  const { data, loading, reload } = useFetch<Paged<Invoice>>(`/invoices${query}`);

  async function advance(inv: Invoice, status: InvoiceStatus) {
    setActionError(null);
    setActing(inv.id);
    try {
      await api.patch(`/invoices/${inv.id}`, { status });
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update invoice");
    } finally {
      setActing(null);
    }
  }

  const totals = (data?.data ?? []).reduce(
    (acc, inv) => {
      acc.amount += Number(inv.amount);
      if (inv.status === "draft" || inv.status === "issued") acc.pending += Number(inv.amount);
      if (inv.status === "paid") acc.paid += Number(inv.amount);
      return acc;
    },
    { amount: 0, pending: 0, paid: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Invoices</h1>
          <p className="text-sm text-dim">
            Auto-drafted when work closes: consumed parts + accepted quote.
          </p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2 text-sm">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-lg px-3 py-1.5 font-semibold transition-colors ${
                  filter === f.id ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-dim">Total invoiced</div>
          <div className="mt-1 text-xl font-bold text-ink">{formatCost(totals.amount)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-dim">Outstanding (draft + issued)</div>
          <div className="mt-1 text-xl font-bold text-amber">{formatCost(totals.pending)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-dim">Collected (paid)</div>
          <div className="mt-1 text-xl font-bold text-gardening">{formatCost(totals.paid)}</div>
        </Card>
      </div>

      {actionError ? (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{actionError}</div>
      ) : null}

      {loading ? (
        <div className="py-16">
          <Spinner />
        </div>
      ) : !data?.data.length ? (
        <EmptyState
          title="No invoices yet"
          body="Close a work order with parts or an accepted quote and an INV-<year>-<seq> draft is created automatically."
        />
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {data.data.map((inv) => {
            const next =
              inv.status === "draft"
                ? ({ status: "issued", label: "Issue" } as const)
                : inv.status === "issued"
                  ? ({ status: "paid", label: "Mark paid" } as const)
                  : null;
            return (
              <div key={inv.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{inv.invoice_number}</span>
                    <InvoiceStatusBadge status={inv.status} />
                  </div>
                  <div className="mt-0.5 text-sm text-dim">
                    {inv.work_order_title ?? "Work order"} · {inv.supplier_name ?? "No supplier"}
                  </div>
                  <div className="text-xs text-dim">
                    {formatDate(inv.created_at)}
                    {inv.parts_cost && Number(inv.parts_cost) > 0 ? ` · parts ${formatCost(inv.parts_cost)}` : ""}
                    {inv.quote_amount ? ` · quote ${formatCost(inv.quote_amount)}` : ""}
                  </div>
                </div>
                <div className="text-lg font-bold text-ink">{formatCost(inv.amount)}</div>
                {canManage && next ? (
                  <Button
                    variant={inv.status === "draft" ? "primary" : "ghost"}
                    disabled={acting === inv.id}
                    onClick={() => void advance(inv, next.status)}
                  >
                    {acting === inv.id ? "…" : next.label}
                  </Button>
                ) : null}
                {canManage && inv.status !== "void" ? (
                  <Button
                    variant="ghost"
                    className="text-danger"
                    disabled={acting === inv.id}
                    onClick={() => void advance(inv, "void")}
                  >
                    Void
                  </Button>
                ) : null}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
