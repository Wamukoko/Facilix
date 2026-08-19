import { useState } from "react";
import type { FormEvent } from "react";
import { List, Map as MapIcon, Plus, Trash2 } from "lucide-react";
import type { Paged, Property } from "../lib/types";
import { Button, Card, EmptyState, ErrorBanner, Field, Input, Modal, Spinner } from "../components/ui";
import { AddressLocate } from "../components/AddressLocate";
import type { GeocodeResult } from "../components/AddressLocate";
import { useFetch } from "../lib/useFetch";
import { api } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import MapScreen from "./Map";

interface PropertyForm {
  name: string;
  address: string;
  lat: string;
  lng: string;
}

const EMPTY: PropertyForm = { name: "", address: "", lat: "", lng: "" };

export default function Properties() {
  const { user } = useAuth();
  const editable = user?.role === "admin" || user?.role === "manager";

  const { data, loading, error, reload } = useFetch<Paged<Property>>("/properties", { limit: 200 });
  const rows = data?.data ?? [];

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Property | null>(null);
  const [form, setForm] = useState<PropertyForm>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "map">("list");

  if (loading) return <Spinner />;
  if (error) return <Card className="p-4 text-danger">{error}</Card>;

  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
    setForm(EMPTY);
    setActionError(null);
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setActionError(null);
    setShowForm(true);
  };

  const openEdit = (p: Property) => {
    setEditing(p);
    setForm({
      name: p.name,
      address: p.address ?? "",
      lat: p.latitude ?? "",
      lng: p.longitude ?? "",
    });
    setActionError(null);
    setShowForm(true);
  };

  const onGeocode = (r: GeocodeResult) => {
    setForm((f) => ({ ...f, lat: String(r.lat), lng: String(r.lng) }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setActionError(null);
    const lat = form.lat.trim() === "" ? undefined : Number(form.lat);
    const lng = form.lng.trim() === "" ? undefined : Number(form.lng);
    try {
      const body = {
        name: form.name.trim(),
        address: form.address.trim() || undefined,
        ...(lat != null ? { lat } : {}),
        ...(lng != null ? { lng } : {}),
      };
      if (editing) await api.patch(`/properties/${editing.id}`, body);
      else await api.post("/properties", body);
      closeForm();
      reload();
    } catch (err) {
      const issues = (err as { issues?: { message: string }[] })?.issues;
      setActionError(issues?.map((i) => i.message).join("; ") ?? (err instanceof Error ? err.message : "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: Property) => {
    const sure = window.confirm(
      `Delete ${p.name}? Buildings, floors and rooms under it are removed; assets stay but lose their site link. Cannot be undone.`
    );
    if (!sure) return;
    setActionError(null);
    try {
      await api.del(`/properties/${p.id}`);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Properties</h1>
          <p className="text-sm text-dim">
            Your sites. Type an address and use <span className="text-ink">Locate address</span> to fill the map
            coordinates automatically, or enter them by hand.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-lg border border-line bg-panel p-0.5">
            <button
              onClick={() => setView("list")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                view === "list" ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
              }`}
            >
              <List className="h-4 w-4" /> List
            </button>
            <button
              onClick={() => setView("map")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                view === "map" ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
              }`}
            >
              <MapIcon className="h-4 w-4" /> Map
            </button>
          </div>
          {editable && view === "list" ? (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> New property
            </Button>
          ) : null}
        </div>
      </div>

      {view === "map" ? (
        <MapScreen />
      ) : (
        <>
          {actionError ? <ErrorBanner message={actionError} /> : null}

          <Card className="overflow-hidden">
            {rows.length === 0 ? (
              <EmptyState title="No properties yet" body="Add your first site to start mapping and planning maintenance." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                      <th className="px-4 py-2 font-semibold">Name</th>
                      <th className="px-4 py-2 font-semibold">Address</th>
                      <th className="hidden px-4 py-2 font-semibold md:table-cell">Location</th>
                      <th className="px-4 py-2 font-semibold text-center">Buildings</th>
                      <th className="px-4 py-2 font-semibold text-center">Open WOs</th>
                      {editable ? <th className="px-4 py-2 font-semibold text-right">Actions</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-3 font-semibold text-ink">{p.name}</td>
                        <td className="px-4 py-3 text-dim">{p.address ?? "—"}</td>
                        <td className="hidden px-4 py-3 text-dim md:table-cell">
                          {p.latitude && p.longitude ? `${Number(p.latitude).toFixed(4)}, ${Number(p.longitude).toFixed(4)}` : "Not set"}
                        </td>
                        <td className="px-4 py-3 text-center text-dim">{p.buildings_count}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                            p.open_work_orders > 0 ? "bg-amber/15 text-amber" : "bg-gardening/15 text-gardening"
                          }`}>
                            {p.open_work_orders}
                          </span>
                        </td>
                        {editable ? (
                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex gap-2">
                              <Button variant="ghost" onClick={() => openEdit(p)}>Edit</Button>
                              <button
                                onClick={() => remove(p)}
                                aria-label={`Delete ${p.name}`}
                                className="rounded-lg p-1.5 text-dim transition-colors hover:bg-danger/10 hover:text-danger"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
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

          <Modal
            open={showForm}
            onClose={closeForm}
            title={editing ? `Edit property — ${editing.name}` : "New property"}
          >
            <form onSubmit={submit} className="space-y-4">
              <Field label="Name">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} />
              </Field>
              <Field label="Address">
                <Input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="e.g. Argwings Kodhek Rd, Kilimani, Nairobi"
                />
              </Field>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="grid flex-1 grid-cols-2 gap-3">
                  <Field label="Latitude">
                    <Input type="number" step="any" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} placeholder="−1.2863" />
                  </Field>
                  <Field label="Longitude">
                    <Input type="number" step="any" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} placeholder="36.7829" />
                  </Field>
                </div>
                <AddressLocate address={form.address} onPick={onGeocode} />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={closeForm}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
              </div>
            </form>
          </Modal>
        </>
      )}
    </div>
  );
}
