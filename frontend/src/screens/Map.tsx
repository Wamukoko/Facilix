import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Paged, Property } from "../lib/types";
import { Button, Card, EmptyState, Field, Input, Modal, Spinner } from "../components/ui";
import { AddressLocate } from "../components/AddressLocate";
import { useFetch } from "../lib/useFetch";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";

const DEFAULT_CENTER: [number, number] = [-1.2921, 36.8219]; // Nairobi

function woColor(open: number): string {
  if (open >= 3) return "#ef4444";
  if (open >= 1) return "#f59e0b";
  return "#22c55e";
}

function num(s: string | null): number | null {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export default function Map() {
  const { user } = useAuth();
  const editable = user?.role === "admin" || user?.role === "manager";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const [editing, setEditing] = useState<Property | null>(null);
  const [latInput, setLatInput] = useState("");
  const [lngInput, setLngInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, reload } = useFetch<Paged<Property>>("/properties", { limit: 200 });
  const properties = data?.data ?? [];

  const plotted = useMemo(
    () => properties.filter((p) => num(p.latitude) != null && num(p.longitude) != null),
    [properties]
  );

  useEffect(() => {
    if (loading || !containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { center: DEFAULT_CENTER, zoom: 12, scrollWheelZoom: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    const t = window.setTimeout(() => map.invalidateSize(), 60);
    return () => {
      window.clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markersRef.current = null;
    };
  }, [loading]);

  // Rebuild markers whenever properties change.
  useEffect(() => {
    const map = mapRef.current;
    const group = markersRef.current;
    if (!map || !group) return;
    group.clearLayers();
    if (plotted.length === 0) return;

    const bounds = L.latLngBounds([]);
    for (const p of plotted) {
      const lat = num(p.latitude);
      const lng = num(p.longitude);
      if (lat == null || lng == null) continue;
      bounds.extend([lat, lng]);
      const m = L.circleMarker([lat, lng], {
        radius: p.open_work_orders > 0 ? 11 : 9,
        color: woColor(p.open_work_orders),
        weight: 2,
        fillColor: woColor(p.open_work_orders),
        fillOpacity: 0.55,
      });
      m.bindPopup(
        `<div style="min-width:180px">
           <strong>${escapeHtml(p.name)}</strong><br/>
           ${escapeHtml(p.address ?? "No address")}<br/>
           <span style="color:${woColor(p.open_work_orders)};font-weight:600">${p.open_work_orders} open work order${p.open_work_orders === 1 ? "" : "s"}</span> · ${p.buildings_count} building${p.buildings_count === 1 ? "" : "s"}
         </div>`
      );
      group.addLayer(m);
    }
    map.fitBounds(bounds.pad(0.15), { maxZoom: 13 });
  }, [plotted]);

  const openEditor = (p: Property) => {
    setEditing(p);
    setLatInput(p.latitude ?? "");
    setLngInput(p.longitude ?? "");
    setActionError(null);
  };

  const jumpTo = (p: Property) => {
    const lat = num(p.latitude);
    const lng = num(p.longitude);
    if (lat == null || lng == null || !mapRef.current) return;
    mapRef.current.flyTo([lat, lng], 15);
  };

  const saveLocation = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const lat = num(latInput);
    const lng = num(lngInput);
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setActionError("Enter valid coordinates (lat -90…90, lng -180…180).");
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      await api.patch(`/properties/${editing.id}`, { lat, lng });
      setEditing(null);
      reload();
    } catch (err) {
      const issues = (err as { issues?: { message: string }[] })?.issues;
      setActionError(issues?.map((i) => i.message).join("; ") ?? (err instanceof Error ? err.message : "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return <Card className="p-4 text-danger">{error}</Card>;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-ink">Property map</h2>
            <p className="text-sm text-dim">
              {plotted.length} of {properties.length} properties plotted · marker colour = open work orders
            </p>
          </div>
          {plotted.length > 0 ? (
            <Button variant="ghost" onClick={() => mapRef.current?.flyToBounds(L.latLngBounds(plotted.flatMap((p) => {
              const lat = num(p.latitude); const lng = num(p.longitude);
              return lat != null && lng != null ? [[lat, lng] as [number, number]] : [];
            })), { maxZoom: 13 })}>
              Zoom to all
            </Button>
          ) : null}
        </div>
        <div ref={containerRef} className="h-[520px] w-full rounded-lg border border-line" />
      </Card>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-bold text-ink">Sites</h3>
        {properties.length === 0 ? (
          <EmptyState title="No properties yet" body="Add a property from the properties data (see dashboard exports) or the API." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {properties.map((p) => {
              const lat = num(p.latitude);
              const lng = num(p.longitude);
              return (
                <div key={p.id} className="rounded-lg border border-line p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-ink">{p.name}</p>
                      <p className="text-xs text-dim">{p.address ?? "No address"}</p>
                    </div>
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                      style={{ backgroundColor: `${woColor(p.open_work_orders)}22`, color: woColor(p.open_work_orders) }}>
                      {p.open_work_orders} open
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-dim">
                    <span>{p.buildings_count} buildings</span>
                    <span>·</span>
                    <span>{lat != null && lng != null ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : "No coordinates"}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {lat != null && lng != null ? (
                      <Button variant="ghost" onClick={() => jumpTo(p)}>Jump to</Button>
                    ) : null}
                    {editable ? (
                      <Button variant="ghost" onClick={() => openEditor(p)}>
                        {lat != null && lng != null ? "Edit location" : "Set location"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal open={editing != null} onClose={() => setEditing(null)} title={editing ? `Location — ${editing.name}` : ""}>
        <form onSubmit={saveLocation} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude">
              <Input type="number" step="any" value={latInput} onChange={(e) => setLatInput(e.target.value)} required />
            </Field>
            <Field label="Longitude">
              <Input type="number" step="any" value={lngInput} onChange={(e) => setLngInput(e.target.value)} required />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-dim">or let the address find itself:</span>
            <AddressLocate address={editing?.address ?? ""} onPick={(r) => { setLatInput(String(r.lat)); setLngInput(String(r.lng)); }} />
          </div>
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c
  );
}
