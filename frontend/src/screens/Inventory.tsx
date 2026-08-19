import { useState } from "react";
import type { FormEvent } from "react";
import type { InventoryItem, ReorderRecommendation, Trade } from "../lib/types";
import { BUILTIN_TRADE_OPTIONS } from "../lib/format";
import { formatCost, formatDate } from "../lib/format";
import { Button, Card, EmptyState, Field, Input, Modal, Select, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { useConfig } from "../context/ConfigContext";

interface InventoryPage {
  data: InventoryItem[];
  meta: { total: number; limit: number; offset: number };
}

interface RecsPage {
  data: ReorderRecommendation[];
  meta: { total: number; limit: number; offset: number };
}

interface PriceRow {
  id: string;
  quantity: string;
  unit_cost: string;
  po_number: string;
  approved_at: string | null;
  supplier_name: string | null;
}

function available(item: InventoryItem): number {
  return Number(item.quantity_on_hand) - Number(item.reserved_qty ?? 0);
}

function isLow(item: InventoryItem): boolean {
  if (item.reorder_threshold == null) return false;
  return available(item) <= Number(item.reorder_threshold);
}

function StockBadge({ item }: { item: InventoryItem }) {
  if (isLow(item)) {
    return (
      <span className="inline-flex items-center rounded-full bg-danger/15 px-2 py-0.5 text-xs font-semibold text-danger">
        Low stock
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-gardening/15 px-2 py-0.5 text-xs font-semibold text-gardening">
      In stock
    </span>
  );
}

function emptyForm() {
  return {
    name: "",
    trade: "" as Trade | "",
    unit: "",
    quantity_on_hand: "",
    reorder_threshold: "",
    min_stock: "",
    max_stock: "",
    location_type: "warehouse" as "warehouse" | "van",
    warehouse_location: "",
  };
}

export default function Inventory() {
  const { config, tradeLabel } = useConfig();
  const trades = config?.trades?.filter((t) => t.active) ?? BUILTIN_TRADE_OPTIONS;
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [movementItem, setMovementItem] = useState<InventoryItem | null>(null);
  const [movementForm, setMovementForm] = useState({ quantity_change: "", reason: "", direction: "in" as "in" | "out" });
  const [savingMovement, setSavingMovement] = useState(false);

  const [reserveItem, setReserveItem] = useState<InventoryItem | null>(null);
  const [reserveForm, setReserveForm] = useState({ quantity: "", reason: "" });
  const [savingReserve, setSavingReserve] = useState(false);

  const [pricesItem, setPricesItem] = useState<InventoryItem | null>(null);
  const [prices, setPrices] = useState<PriceRow[] | null>(null);
  const [pricesLoading, setPricesLoading] = useState(false);

  const { data, loading, error, reload } = useFetch<InventoryPage>("/inventory", { limit: 200 });
  const { data: recsData, reload: reloadRecs } = useFetch<RecsPage>("/inventory/reorder-recommendations");

  if (loading) return <Spinner />;
  if (error) return <Card className="p-4 text-danger">{error}</Card>;

  const rows = data?.data ?? [];
  const recs = recsData?.data ?? [];
  const lowCount = rows.filter(isLow).length;

  const closeForm = () => {
    setShowForm(false);
    setForm(emptyForm());
    setActionError(null);
  };

  const submitItem = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setActionError(null);
    try {
      await api.post("/inventory", {
        name: form.name,
        trade: form.trade || null,
        unit: form.unit || null,
        quantity_on_hand: form.quantity_on_hand === "" ? 0 : Number(form.quantity_on_hand),
        reorder_threshold: form.reorder_threshold === "" ? null : Number(form.reorder_threshold),
        min_stock: form.min_stock === "" ? null : Number(form.min_stock),
        max_stock: form.max_stock === "" ? null : Number(form.max_stock),
        location_type: form.location_type,
        warehouse_location: form.warehouse_location || null,
      });
      closeForm();
      reload();
      reloadRecs();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not add item");
    } finally {
      setSaving(false);
    }
  };

  const submitMovement = async (e: FormEvent) => {
    e.preventDefault();
    if (!movementItem) return;
    setSavingMovement(true);
    setActionError(null);
    try {
      const qty = Number(movementForm.quantity_change);
      await api.post(`/inventory/${movementItem.id}/movements`, {
        quantity_change: movementForm.direction === "out" ? -Math.abs(qty) : Math.abs(qty),
        reason: movementForm.reason || null,
      });
      setMovementItem(null);
      setMovementForm({ quantity_change: "", reason: "", direction: "in" });
      reload();
      reloadRecs();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not record movement");
    } finally {
      setSavingMovement(false);
    }
  };

  const submitReserve = async (e: FormEvent) => {
    e.preventDefault();
    if (!reserveItem) return;
    setSavingReserve(true);
    setActionError(null);
    try {
      await api.post(`/inventory/${reserveItem.id}/reservations`, {
        quantity: Number(reserveForm.quantity),
        reason: reserveForm.reason || null,
      });
      setReserveItem(null);
      setReserveForm({ quantity: "", reason: "" });
      reload();
      reloadRecs();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not reserve stock");
    } finally {
      setSavingReserve(false);
    }
  };

  const openPrices = async (item: InventoryItem) => {
    setPricesItem(item);
    setPrices(null);
    setPricesLoading(true);
    setActionError(null);
    try {
      const data = await api.get<{ data: PriceRow[] }>(`/inventory/${item.id}/price-history`, { limit: 50 });
      setPrices(data.data);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not load price history");
    } finally {
      setPricesLoading(false);
    }
  };

  const createPoFor = async (rec: ReorderRecommendation) => {
    setActionError(null);
    try {
      await api.post("/purchase-orders", { items: [{ item_id: rec.id, quantity: rec.suggested_qty }] });
      await reloadRecs();
      alert(`Draft PO created for ${rec.name} (${rec.suggested_qty} ${rec.unit ?? ""}). Manage it under Purchase orders.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not create purchase order");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">Inventory</h1>
          <p className="text-sm text-dim">
            Stock levels, reorder thresholds, reservations, and parts consumed on work orders.
            {lowCount > 0 ? ` ${lowCount} item(s) need reordering.` : ""}
          </p>
        </div>
        <Button onClick={() => setShowForm(true)}>Add item</Button>
      </div>

      {recs.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-bold text-ink">Reorder recommendations</h2>
          <p className="mb-3 text-xs text-dim">
            Items at or below reorder point (net of reservations). Create a draft purchase order straight from here.
          </p>
          <div className="space-y-2">
            {recs.map((rec) => (
              <div key={rec.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel-2/50 px-3 py-2">
                <div className="text-sm">
                  <span className="font-semibold text-ink">{rec.name}</span>
                  <span className="ml-2 text-dim">
                    {available(rec as unknown as InventoryItem)} on hand, threshold {Number(rec.reorder_threshold)}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-dim">
                    Suggested: <span className="font-semibold text-ink">{rec.suggested_qty} {rec.unit ?? ""}</span>
                    {rec.last_unit_cost != null ? ` · ${formatCost(rec.estimated_cost)}` : ""}
                  </span>
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => createPoFor(rec)}>
                    Create PO
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState title="No inventory yet" body="Add stock items to start tracking consumption against work orders." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                <th className="px-4 py-2 font-semibold">Item</th>
                <th className="hidden px-4 py-2 font-semibold sm:table-cell">Trade</th>
                <th className="px-4 py-2 font-semibold">On hand</th>
                <th className="hidden px-4 py-2 font-semibold md:table-cell">Reserved</th>
                <th className="hidden px-4 py-2 font-semibold md:table-cell">Reorder at</th>
                <th className="hidden px-4 py-2 font-semibold lg:table-cell">Min–max</th>
                <th className="hidden px-4 py-2 font-semibold lg:table-cell">Location</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id} className="border-b border-line last:border-0 hover:bg-panel-2/60">
                  <td className="px-4 py-3 font-medium text-ink">{item.name}</td>
                  <td className="hidden px-4 py-3 text-dim sm:table-cell">
                    {item.trade ? tradeLabel(item.trade) : "—"}
                  </td>
                  <td className="px-4 py-3 text-ink">
                    {Number(item.quantity_on_hand)} {item.unit ?? ""}
                  </td>
                  <td className="hidden px-4 py-3 text-dim md:table-cell">
                    {Number(item.reserved_qty ?? 0) > 0
                      ? `${Number(item.reserved_qty)} (${available(item)} available)`
                      : "—"}
                  </td>
                  <td className="hidden px-4 py-3 text-dim md:table-cell">
                    {item.reorder_threshold != null ? item.reorder_threshold : "—"}
                  </td>
                  <td className="hidden px-4 py-3 text-dim lg:table-cell">
                    {item.min_stock != null || item.max_stock != null
                      ? `${item.min_stock ?? "–"}–${item.max_stock ?? "–"}`
                      : "—"}
                  </td>
                  <td className="hidden px-4 py-3 text-dim lg:table-cell">
                    {item.location_type === "van" ? (
                      <span className="inline-flex items-center rounded-full bg-plumbing/15 px-2 py-0.5 text-xs font-semibold text-plumbing">
                        Van stock
                      </span>
                    ) : (
                      (item.warehouse_location ?? "Warehouse")
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StockBadge item={item} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setMovementItem(item)}>
                        Movement
                      </Button>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setReserveItem(item)}>
                        Reserve
                      </Button>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => openPrices(item)}>
                        Prices
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={showForm} onClose={closeForm} title="Add inventory item">
        <form onSubmit={submitItem} className="space-y-4">
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          <Field label="Item name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Flapper valve 20mm" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Trade">
              <Select value={form.trade} onChange={(e) => setForm({ ...form, trade: e.target.value as Trade | "" })}>
                <option value="">—</option>
                {trades.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Unit">
              <Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="pcs, liters, meters" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Opening quantity">
              <Input type="number" min="0" step="any" value={form.quantity_on_hand} onChange={(e) => setForm({ ...form, quantity_on_hand: e.target.value })} />
            </Field>
            <Field label="Reorder threshold">
              <Input type="number" min="0" step="any" value={form.reorder_threshold} onChange={(e) => setForm({ ...form, reorder_threshold: e.target.value })} placeholder="optional" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Min stock">
              <Input type="number" min="0" step="any" value={form.min_stock} onChange={(e) => setForm({ ...form, min_stock: e.target.value })} placeholder="optional" />
            </Field>
            <Field label="Max stock">
              <Input type="number" min="0" step="any" value={form.max_stock} onChange={(e) => setForm({ ...form, max_stock: e.target.value })} placeholder="optional" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Location">
              <Select value={form.location_type} onChange={(e) => setForm({ ...form, location_type: e.target.value as "warehouse" | "van" })}>
                <option value="warehouse">Warehouse</option>
                <option value="van">Van stock</option>
              </Select>
            </Field>
            <Field label="Bin / shelf">
              <Input value={form.warehouse_location} onChange={(e) => setForm({ ...form, warehouse_location: e.target.value })} placeholder="e.g. Rack 3, store room" />
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={closeForm}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add item"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={movementItem != null}
        onClose={() => setMovementItem(null)}
        title={movementItem ? `Record movement — ${movementItem.name}` : ""}
      >
        <form onSubmit={submitMovement} className="space-y-4">
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          <Field label="Direction">
            <Select
              value={movementForm.direction}
              onChange={(e) => setMovementForm({ ...movementForm, direction: e.target.value as "in" | "out" })}
            >
              <option value="in">Restock (+)</option>
              <option value="out">Consume (−)</option>
            </Select>
          </Field>
          <Field label="Quantity">
            <Input
              type="number"
              min="0"
              step="any"
              value={movementForm.quantity_change}
              onChange={(e) => setMovementForm({ ...movementForm, quantity_change: e.target.value })}
              required
              placeholder={`On hand: ${movementItem ? available(movementItem) : ""}`}
            />
          </Field>
          <Field label="Reason">
            <Input value={movementForm.reason} onChange={(e) => setMovementForm({ ...movementForm, reason: e.target.value })} placeholder="e.g. Consumed on work order" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setMovementItem(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={savingMovement}>
              {savingMovement ? "Recording…" : "Record"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={reserveItem != null}
        onClose={() => setReserveItem(null)}
        title={reserveItem ? `Reserve stock — ${reserveItem.name}` : ""}
      >
        <form onSubmit={submitReserve} className="space-y-4">
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          <p className="text-sm text-dim">
            Reserved stock is set aside and excluded from availability. Currently{" "}
            <span className="font-semibold text-ink">{reserveItem ? available(reserveItem) : 0}</span> available.
          </p>
          <Field label="Quantity">
            <Input
              type="number"
              min="0"
              step="any"
              value={reserveForm.quantity}
              onChange={(e) => setReserveForm({ ...reserveForm, quantity: e.target.value })}
              required
            />
          </Field>
          <Field label="Reason">
            <Input value={reserveForm.reason} onChange={(e) => setReserveForm({ ...reserveForm, reason: e.target.value })} placeholder="e.g. Held for scheduled job" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setReserveItem(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={savingReserve}>
              {savingReserve ? "Reserving…" : "Reserve"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={pricesItem != null}
        onClose={() => setPricesItem(null)}
        title={pricesItem ? `Price history — ${pricesItem.name}` : ""}
      >
        <div className="space-y-4">
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          {pricesLoading ? (
            <Spinner />
          ) : prices && prices.length > 0 ? (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                  <th className="py-2 font-semibold">PO</th>
                  <th className="py-2 font-semibold">Supplier</th>
                  <th className="py-2 font-semibold">Qty</th>
                  <th className="py-2 font-semibold">Unit cost</th>
                  <th className="py-2 font-semibold">Received</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0">
                    <td className="py-2 font-medium text-ink">{p.po_number}</td>
                    <td className="py-2 text-dim">{p.supplier_name ?? "—"}</td>
                    <td className="py-2 text-dim">{Number(p.quantity)}</td>
                    <td className="py-2 text-ink">{formatCost(p.unit_cost)}</td>
                    <td className="py-2 text-dim">{formatDate(p.approved_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-dim">No received deliveries yet — prices appear once a purchase order is received.</p>
          )}
          <div className="flex justify-end pt-1">
            <Button variant="ghost" onClick={() => setPricesItem(null)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
