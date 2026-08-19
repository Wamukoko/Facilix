import { useState } from "react";
import type { FormEvent } from "react";
import type { Contract, InventoryItem, Paged, PurchaseOrder, PurchaseOrderItem, PurchaseOrderStatus, Supplier } from "../lib/types";
import { Button, Card, EmptyState, Field, Input, Modal, Select, Spinner } from "../components/ui";
import { CalendarPicker } from "../components/CalendarPicker";
import { PO_STATUSES } from "../lib/format";
import { formatCost, formatDate } from "../lib/format";
import { api } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { useAuth } from "../context/AuthContext";

interface LineDraft {
  item_id: string;
  quantity: string;
  unit_cost: string;
}

function emptyLine(): LineDraft {
  return { item_id: "", quantity: "", unit_cost: "" };
}

const FILTERS: { id: PurchaseOrderStatus | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "submitted", label: "Submitted" },
  { id: "approved", label: "Approved" },
  { id: "received", label: "Received" },
  { id: "cancelled", label: "Cancelled" },
];

function PoStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const s = PO_STATUSES[status] ?? PO_STATUSES.draft;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${s.text} ${s.bg}`}>
      {s.label}
    </span>
  );
}

function lineTotal(item: PurchaseOrderItem): number {
  return Number(item.quantity) * Number(item.unit_cost);
}

export default function PurchaseOrders() {
  const { user } = useAuth();
  const canApprove = user?.role === "admin" || user?.role === "manager";

  const [filter, setFilter] = useState<PurchaseOrderStatus | "all">("all");
  const [detail, setDetail] = useState<PurchaseOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ supplier_id: "", contract_id: "", expected_date: "", notes: "" });
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [saving, setSaving] = useState(false);

  const [addingItem, setAddingItem] = useState(false);
  const [itemDraft, setItemDraft] = useState<LineDraft>(emptyLine());

  const { data, loading, error, reload } = useFetch<Paged<PurchaseOrder>>("/purchase-orders", { limit: 200 });
  const { data: suppliersData } = useFetch<Paged<Supplier>>("/suppliers", { limit: 200 });
  const { data: itemsData } = useFetch<Paged<InventoryItem>>("/inventory", { limit: 200 });
  const { data: contractsData } = useFetch<Paged<Contract>>("/contracts", { limit: 200 });

  if (loading) return <Spinner />;
  if (error) return <Card className="p-4 text-danger">{error}</Card>;

  const rows = data?.data ?? [];
  const filtered = filter === "all" ? rows : rows.filter((po) => po.status === filter);
  const suppliers = suppliersData?.data ?? [];
  const items = itemsData?.data ?? [];
  const contracts = contractsData?.data ?? [];

  const openDetail = async (po: PurchaseOrder) => {
    setDetail(po);
    setDetailLoading(true);
    setActionError(null);
    try {
      const fresh = await api.get<PurchaseOrder>(`/purchase-orders/${po.id}`);
      setDetail(fresh);
    } catch {
      // keep the list row as the detail view
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setDetail(null);
    setActionError(null);
  };

  const reloadAfter = async () => {
    reload();
    if (detail) openDetail(detail);
  };

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setActionError(null);
    try {
      const payloadLines = lines
        .filter((l) => l.item_id)
        .map((l) => ({ item_id: l.item_id, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost) || 0 }));
      await api.post("/purchase-orders", {
        supplier_id: createForm.supplier_id || null,
        contract_id: createForm.contract_id || null,
        expected_date: createForm.expected_date || null,
        notes: createForm.notes || null,
        items: payloadLines,
      });
      setShowCreate(false);
      setCreateForm({ supplier_id: "", contract_id: "", expected_date: "", notes: "" });
      setLines([]);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not create purchase order");
    } finally {
      setSaving(false);
    }
  };

  const submitAddItem = async (e: FormEvent) => {
    e.preventDefault();
    if (!detail || !itemDraft.item_id) return;
    setSaving(true);
    setActionError(null);
    try {
      await api.post(`/purchase-orders/${detail.id}/items`, { item_id: itemDraft.item_id, quantity: Number(itemDraft.quantity), unit_cost: Number(itemDraft.unit_cost) || 0 });
      setAddingItem(false);
      setItemDraft(emptyLine());
      await openDetail(detail);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not add line item");
    } finally {
      setSaving(false);
    }
  };

  const act = async (path: string, method: "POST" | "DELETE") => {
    setActionError(null);
    try {
      if (method === "DELETE") await api.del(path);
      else await api.post(path);
      await reloadAfter();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const actionsFor = (po: PurchaseOrder) => {
    const actions: { label: string; disabled?: boolean; onClick: () => void }[] = [];
    if (po.status === "draft") {
      actions.push({ label: "Submit", onClick: () => act(`/purchase-orders/${po.id}/submit`, "POST") });
      actions.push({ label: "Delete", onClick: () => act(`/purchase-orders/${po.id}`, "DELETE") });
    }
    if (po.status === "submitted" && canApprove) {
      actions.push({ label: "Approve", onClick: () => act(`/purchase-orders/${po.id}/approve`, "POST") });
    }
    if (po.status === "approved") {
      actions.push({ label: "Receive", onClick: () => act(`/purchase-orders/${po.id}/receive`, "POST") });
    }
    if (po.status === "draft" || po.status === "submitted" || po.status === "approved") {
      actions.push({ label: "Cancel", onClick: () => act(`/purchase-orders/${po.id}/cancel`, "POST") });
    }
    return actions;
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">Purchase orders</h1>
          <p className="text-sm text-dim">Procurement lifecycle: draft → submitted → approved → received, with stock top-ups.</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>New purchase order</Button>
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

      <Card className="overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState title="No purchase orders" body="Create a draft PO to start the procurement flow." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                <th className="px-4 py-2 font-semibold">PO</th>
                <th className="hidden px-4 py-2 font-semibold sm:table-cell">Supplier</th>
                <th className="hidden px-4 py-2 font-semibold lg:table-cell">Contract</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="hidden px-4 py-2 font-semibold md:table-cell">Items</th>
                <th className="hidden px-4 py-2 font-semibold md:table-cell">Total</th>
                <th className="hidden px-4 py-2 font-semibold lg:table-cell">Expected</th>
                <th className="px-4 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((po) => (
                <tr key={po.id} className="border-b border-line last:border-0 hover:bg-panel-2/60">
                  <td className="px-4 py-3">
                    <button onClick={() => openDetail(po)} className="font-semibold text-ink hover:text-amber">
                      {po.po_number}
                    </button>
                  </td>
                  <td className="hidden px-4 py-3 text-dim sm:table-cell">{po.supplier_name ?? "—"}</td>
                  <td className="hidden px-4 py-3 text-dim lg:table-cell">{po.contract_number ?? "—"}</td>
                  <td className="px-4 py-3">
                    <PoStatusBadge status={po.status} />
                  </td>
                  <td className="hidden px-4 py-3 text-dim md:table-cell">{po.item_count}</td>
                  <td className="hidden px-4 py-3 text-ink md:table-cell">{formatCost(po.total)}</td>
                  <td className="hidden px-4 py-3 text-dim lg:table-cell">{formatDate(po.expected_date)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => openDetail(po)}>
                        View
                      </Button>
                      {actionsFor(po).map((a) => (
                        <Button key={a.label} variant="ghost" className="!px-2 !py-1 text-xs" onClick={a.onClick}>
                          {a.label}
                        </Button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="New purchase order">
        <form onSubmit={submitCreate} className="space-y-4">
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Supplier">
              <Select value={createForm.supplier_id} onChange={(e) => setCreateForm({ ...createForm, supplier_id: e.target.value })}>
                <option value="">—</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Contract">
              <Select value={createForm.contract_id} onChange={(e) => setCreateForm({ ...createForm, contract_id: e.target.value })}>
                <option value="">—</option>
                {contracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.contract_number}
                    {c.supplier_name ? ` · ${c.supplier_name}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Expected date">
              <CalendarPicker
                value={createForm.expected_date}
                onChange={(v) => setCreateForm({ ...createForm, expected_date: v })}
                placeholder="Pick a date"
              />
            </Field>
            <Field label="Notes">
              <Input value={createForm.notes} onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })} placeholder="optional" />
            </Field>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">Line items</span>
              <Button
                type="button"
                variant="ghost"
                className="!px-2 !py-1 text-xs"
                onClick={() => setLines([...lines, emptyLine()])}
              >
                + Add item
              </Button>
            </div>
            {lines.length === 0 ? <p className="text-sm text-dim">No line items yet.</p> : null}
            {lines.map((line, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_5rem_6rem_auto] items-center gap-2">
                <Select
                  value={line.item_id}
                  onChange={(e) => {
                    const next = [...lines];
                    next[idx] = { ...line, item_id: e.target.value };
                    setLines(next);
                  }}
                >
                  <option value="">Item…</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name}
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={line.quantity}
                  onChange={(e) => {
                    const next = [...lines];
                    next[idx] = { ...line, quantity: e.target.value };
                    setLines(next);
                  }}
                  placeholder="Qty"
                />
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={line.unit_cost}
                  onChange={(e) => {
                    const next = [...lines];
                    next[idx] = { ...line, unit_cost: e.target.value };
                    setLines(next);
                  }}
                  placeholder="Cost"
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="!px-2 !py-1 text-xs text-danger"
                  onClick={() => setLines(lines.filter((_, i) => i !== idx))}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Creating…" : "Create draft"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={detail != null} onClose={closeDetail} title={detail ? `Purchase order ${detail.po_number}` : ""}>
        {detailLoading ? (
          <Spinner />
        ) : detail ? (
          <div className="space-y-4">
            {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <PoStatusBadge status={detail.status} />
              <span className="text-dim">Supplier: {detail.supplier_name ?? "—"}</span>
              <span className="text-dim">Contract: {detail.contract_number ?? "—"}</span>
              <span className="text-dim">Expected: {formatDate(detail.expected_date)}</span>
            </div>
            {detail.ordered_by_name ? <p className="text-sm text-dim">Ordered by {detail.ordered_by_name}</p> : null}
            {detail.approved_by_name ? <p className="text-sm text-dim">Approved by {detail.approved_by_name}</p> : null}
            {detail.notes ? <p className="text-sm text-dim">{detail.notes}</p> : null}

            {detail.items.length === 0 ? (
              <p className="text-sm text-dim">No line items on this order.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                    <th className="py-2 font-semibold">Item</th>
                    <th className="py-2 font-semibold">Qty</th>
                    <th className="py-2 font-semibold">Unit cost</th>
                    <th className="py-2 font-semibold">Received</th>
                    <th className="py-2 font-semibold text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((it) => (
                    <tr key={it.id} className="border-b border-line last:border-0">
                      <td className="py-2 font-medium text-ink">{it.item_name}</td>
                      <td className="py-2 text-dim">
                        {Number(it.quantity)} {it.unit ?? ""}
                      </td>
                      <td className="py-2 text-dim">{formatCost(it.unit_cost)}</td>
                      <td className="py-2 text-dim">
                        {Number(it.received_qty)} {it.unit ?? ""}
                      </td>
                      <td className="py-2 text-right text-ink">{formatCost(lineTotal(it))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                className="!px-2 !py-1 text-xs"
                onClick={() => setAddingItem(true)}
                disabled={detail.status !== "draft"}
              >
                Add line item
              </Button>
              <div className="text-sm font-semibold text-ink">
                Total: <span className="text-amber">{formatCost(detail.total)}</span>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              {actionsFor(detail).map((a) => (
                <Button key={a.label} onClick={a.onClick}>
                  {a.label}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={addingItem} onClose={() => setAddingItem(false)} title="Add line item">
        <form onSubmit={submitAddItem} className="space-y-4">
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          <Field label="Item">
            <Select value={itemDraft.item_id} onChange={(e) => setItemDraft({ ...itemDraft, item_id: e.target.value })}>
              <option value="">—</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity">
              <Input type="number" min="0" step="any" value={itemDraft.quantity} onChange={(e) => setItemDraft({ ...itemDraft, quantity: e.target.value })} required />
            </Field>
            <Field label="Unit cost">
              <Input type="number" min="0" step="any" value={itemDraft.unit_cost} onChange={(e) => setItemDraft({ ...itemDraft, unit_cost: e.target.value })} placeholder="KES" />
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setAddingItem(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
