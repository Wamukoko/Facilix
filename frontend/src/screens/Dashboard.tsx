import { useEffect, useMemo, useState } from "react";
import type { Contract, InventoryItem, MeterAlert, Notification, WorkOrder } from "../lib/types";
import { FAILURE_CODES, formatCost, formatDate, titleCase } from "../lib/format";
import { PriorityBadge, SourceBadge, StatusBadge, TradeBadge } from "../components/Badges";
import { Button, Card, EmptyState, Spinner, StatCard } from "../components/ui";
import { useFetch } from "../lib/useFetch";
import { api } from "../lib/api";
import { useI18n } from "../context/I18nContext";

interface WorkOrderPage {
  data: WorkOrder[];
  meta: { total: number; limit: number; offset: number };
}

interface FailureCodeAgg {
  failure_code: string;
  count: number;
  avg_repair_hours: number | null;
}

interface BadActor {
  asset_id: string;
  asset_name: string;
  wo_count: number;
  distinct_failure_codes: number;
  failure_codes: string[];
  repeat_count: number;
  mtbf_days: number | null;
}

interface Reliability {
  failureCodes: FailureCodeAgg[];
  badActors: BadActor[];
  pmEffectiveness: {
    planned_total: number;
    planned_done: number;
    planned_on_time: number;
    planned_overdue: number;
    on_time_rate: number | null;
  };
  summary: {
    total_closed: number;
    total_open: number;
    overdue_open: number;
    avg_repair_hours_all: number | null;
  };
}

const WO_LIMIT = 200;

// Panel registry — id order is the default layout. A user can hide or reorder
// panels; the saved layout is persisted per-user via /users/me/prefs.
const PANELS: { id: string; title: string }[] = [
  { id: "stats", title: "Key numbers" },
  { id: "low-stock", title: "Low-stock alert" },
  { id: "contracts", title: "Contract renewals" },
  { id: "meter-alerts", title: "Meter alerts" },
  { id: "reliability", title: "Reliability & failure analysis" },
  { id: "notifications", title: "Notifications" },
  { id: "recent", title: "Recent work orders" },
];
const PANEL_IDS = PANELS.map((p) => p.id);

function dueSoon(wo: WorkOrder): boolean {
  if (!wo.due_date) return false;
  if (wo.status === "done" || wo.status === "verified" || wo.status === "cancelled") return false;
  const due = new Date(wo.due_date);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() - Date.now() <= 7 * 24 * 60 * 60 * 1000;
}

function FailureBadge({ code }: { code: string }) {
  return (
    <span className="rounded-md bg-amber/15 px-1.5 py-0.5 text-xs font-medium text-amber">
      {FAILURE_CODES[code] ?? titleCase(code)}
    </span>
  );
}

export default function Dashboard() {
  const { t } = useI18n();
  // Per-user layout. Defaults to every panel until the saved prefs arrive;
  // the hooks below gate their fetches on what is visible, so hiding a panel
  // also stops polling its endpoint.
  const [panels, setPanels] = useState<string[]>(PANEL_IDS);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const panelTitle: Record<string, string> = useMemo(
    () => ({
      stats: "Key numbers",
      "low-stock": t("dash.lowStock"),
      contracts: t("dash.contractRenewals"),
      "meter-alerts": t("dash.meterAlerts"),
      reliability: t("dash.reliability"),
      notifications: t("dash.notifications"),
      recent: t("dash.recentWO"),
    }),
    [t]
  );

  const visible = useMemo(() => new Set(panels), [panels]);
  const needWos = visible.has("stats") || visible.has("recent");
  const needAssets = visible.has("stats");

  const wos = useFetch<WorkOrderPage>(needWos ? "/work-orders" : null, { limit: WO_LIMIT });
  const assets = useFetch<{ data: unknown[] }>(needAssets ? "/assets" : null, { limit: WO_LIMIT });
  const rel = useFetch<Reliability>(visible.has("reliability") ? "/reliability" : null);
  const notifs = useFetch<{ data: Notification[]; meta: { unread: number } }>(
    visible.has("notifications") ? "/notifications" : null,
    { limit: 8 }
  );
  const inv = useFetch<{ data: InventoryItem[] }>(visible.has("low-stock") ? "/inventory" : null, { limit: 200 });
  const meterAlerts = useFetch<{ data: MeterAlert[] }>(visible.has("meter-alerts") ? "/meter-readings/alerts" : null);
  const contracts = useFetch<{ data: Contract[] }>(visible.has("contracts") ? "/contracts" : null, { limit: 200 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prefs = await api.get<{ dashboard: string[] }>("/users/me/prefs");
        const saved = (prefs.dashboard ?? []).filter((id) => PANEL_IDS.includes(id));
        if (!cancelled && saved.length > 0) setPanels(saved);
      } catch {
        // No saved layout — keep the defaults.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function markRead(id: string) {
    try {
      await api.patch(`/notifications/${id}/read`);
      notifs.reload();
    } catch {
      // best-effort; ignore
    }
  }

  async function savePanels(next: string[]) {
    setSaving(true);
    try {
      setPanels(next);
      await api.put("/users/me/prefs", { dashboard: next });
      setEditing(false);
    } catch {
      // Keep the local layout even if persistence fails.
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  const lowItems = useMemo(
    () =>
      (inv.data?.data ?? []).filter(
        (i) => i.reorder_threshold != null && Number(i.quantity_on_hand) <= Number(i.reorder_threshold)
      ),
    [inv.data]
  );

  const flaggedContracts = useMemo(
    () =>
      (contracts.data?.data ?? []).filter(
        (c) => c.effective_status === "expiring" || c.effective_status === "expired"
      ),
    [contracts.data]
  );

  const stats = useMemo(() => {
    const list = wos.data?.data ?? [];
    const open = list.filter((w) => w.status === "open").length;
    const high = list.filter(
      (w) =>
        w.status !== "done" &&
        w.status !== "verified" &&
        w.status !== "cancelled" &&
        (w.priority === "high" || w.priority === "urgent")
    ).length;
    const due = list.filter(dueSoon).length;
    const recent = [...list]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 6);
    return { open, high, due, recent, assetCount: assets.data?.data.length ?? 0 };
  }, [wos.data, assets.data]);

  const r = rel.data;
  const maxFc = Math.max(1, ...(r?.failureCodes.map((f) => f.count) ?? [1]));

  if (needWos && wos.loading) return <Spinner />;
  if (needWos && wos.error) return <Card className="p-4 text-danger">{wos.error}</Card>;

  // Panel renderers — each returns the JSX for one card/block (or null when it
  // has nothing to show). Rendered in the user's chosen order.
  const renderers: Record<string, () => React.ReactNode> = {
    stats: () => (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label={t("dash.openWO")} value={stats.open} accent />
        <StatCard label={t("dash.highUrgent")} value={stats.high} />
        <StatCard label={t("dash.dueThisWeek")} value={stats.due} />
        <StatCard label={t("dash.totalAssets")} value={stats.assetCount} />
      </div>
    ),
    "low-stock": () =>
      lowItems.length > 0 ? (
        <Card className="border-danger/40 bg-danger/5 p-4">
          <p className="text-sm font-semibold text-danger">
            Low stock — {lowItems.length} item(s) at or below reorder point
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {lowItems.map((i) => (
              <li key={i.id} className="rounded-md bg-panel px-2 py-1 text-xs text-ink">
                {i.name}: {Number(i.quantity_on_hand)} {i.unit ?? ""} left
              </li>
            ))}
          </ul>
        </Card>
      ) : null,
    contracts: () =>
      flaggedContracts.length > 0 ? (
        <Card className="border-amber/40 bg-amber/5 p-4">
          <p className="text-sm font-semibold text-amber">
            Supplier contracts — {flaggedContracts.length} in or past the renewal window
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {flaggedContracts.map((c) => (
              <li key={c.id} className="rounded-md bg-panel px-2 py-1 text-xs text-ink">
                {c.contract_number}: {c.supplier_name ?? "Supplier"} ·{" "}
                {c.effective_status === "expired" ? "expired" : `${c.days_to_expiry}d to expiry`} · ends{" "}
                {formatDate(c.end_date)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null,
    "meter-alerts": () =>
      meterAlerts.data?.data?.length ? (
        <Card className="border-amber/40 bg-amber/5 p-4">
          <p className="text-sm font-semibold text-amber">
            Meter alerts — {meterAlerts.data.data.length} asset(s) at or near a maintenance threshold
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {meterAlerts.data.data.map((a) => (
              <li
                key={`${a.asset_id}-${a.plan_id}`}
                className="rounded-md bg-panel px-2 py-1 text-xs text-ink"
              >
                {a.asset_name}: {a.meter_value} {a.meter_unit ?? ""} · threshold {a.meter_threshold} (
                {a.status === "breached" ? "reached" : "near"})
              </li>
            ))}
          </ul>
        </Card>
      ) : null,
    reliability: () =>
      r ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="grid grid-cols-3 gap-3 lg:col-span-3 lg:grid-cols-6">
            <StatCard label={t("dash.closed")} value={r.summary.total_closed} />
            <StatCard label={t("dash.overdue")} value={r.summary.overdue_open} />
            <StatCard label={t("dash.meanRepair")} value={r.summary.avg_repair_hours_all ?? "—"} />
            <StatCard label={t("dash.planned")} value={r.pmEffectiveness.planned_total} />
            <StatCard label={t("dash.pmOnTime")} value={r.pmEffectiveness.on_time_rate ?? "—"} />
            <StatCard label={t("dash.pmOverdue")} value={r.pmEffectiveness.planned_overdue} />
          </div>

          <Card className="overflow-hidden lg:col-span-2">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-sm font-bold text-ink">{t("dash.topFailures")}</h2>
              <p className="text-xs text-dim">{t("dash.topFailuresDesc")}</p>
            </div>
            {r.failureCodes.length === 0 ? (
              <EmptyState title={t("dash.noClosed")} body={t("dash.noClosedBody")} />
            ) : (
              <ul className="divide-y divide-line">
                {r.failureCodes.map((f) => (
                  <li key={f.failure_code} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="w-32 shrink-0">
                      <FailureBadge code={f.failure_code} />
                    </div>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-bg">
                      <div
                        className="h-full rounded bg-amber/70"
                        style={{ width: `${(f.count / maxFc) * 100}%` }}
                      />
                    </div>
                    <div className="w-24 shrink-0 text-right text-xs text-dim">
                      {f.count}× · {f.avg_repair_hours ?? "—"}h
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-sm font-bold text-ink">{t("dash.badActors")}</h2>
              <p className="text-xs text-dim">{t("dash.badActorsDesc")}</p>
            </div>
            {r.badActors.length === 0 ? (
              <EmptyState title={t("dash.noRepeat")} body={t("dash.noRepeatBody")} />
            ) : (
              <ul className="divide-y divide-line">
                {r.badActors.map((a) => (
                  <li key={a.asset_id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-ink">{a.asset_name}</span>
                      <span className="shrink-0 text-xs text-dim">
                        {a.wo_count}×{a.repeat_count > 0 ? ` · ${a.repeat_count} repeat` : ""}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {a.failure_codes.slice(0, 4).map((c, i) => (
                        <FailureBadge key={`${c}-${i}`} code={c} />
                      ))}
                      {a.mtbf_days != null ? <span className="ml-auto text-xs text-dim">MTBF {a.mtbf_days}d</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : rel.error ? (
        <Card className="p-4 text-danger">{rel.error}</Card>
      ) : null,
    notifications: () => (
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-bold text-ink">{t("dash.notifications")}</h2>
          {notifs.data?.meta?.unread ? (
            <span className="rounded-full bg-amber/15 px-2 py-0.5 text-xs font-semibold text-amber">
              {notifs.data.meta.unread} {t("dash.unread")}
            </span>
          ) : null}
        </div>
        {notifs.loading ? (
          <div className="p-4 text-sm text-dim">Loading…</div>
        ) : (notifs.data?.data ?? []).length === 0 ? (
          <EmptyState title={t("dash.noNotifications")} body={t("dash.noNotificationsBody")} />
        ) : (
          <ul className="divide-y divide-line">
            {(notifs.data?.data ?? []).map((n) => (
              <li key={n.id} className={`flex items-start justify-between gap-3 px-4 py-3 ${n.read ? "" : "bg-amber/5"}`}>
                <div className="min-w-0">
                  <p className={`text-sm font-medium ${n.read ? "text-dim" : "text-ink"}`}>{n.title}</p>
                  <p className="mt-0.5 text-xs text-dim">{n.body}</p>
                  <p className="mt-0.5 text-[11px] text-dim/70">{formatDate(n.created_at)}</p>
                </div>
                {!n.read ? (
                  <button onClick={() => markRead(n.id)} className="shrink-0 text-xs font-semibold text-amber hover:underline">
                    {t("action.markRead")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    ),
    recent: () => (
      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-bold text-ink">{t("dash.recentWO")}</h2>
        </div>
        {stats.recent.length === 0 ? (
          <EmptyState
            title={t("dash.noWorkOrders")}
            body={t("dash.noWorkOrdersBody")}
          />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                <th className="px-4 py-2 font-semibold">{t("dash.woCol")}</th>
                <th className="hidden px-4 py-2 font-semibold sm:table-cell">{t("dash.tradeCol")}</th>
                <th className="px-4 py-2 font-semibold">{t("dash.priorityCol")}</th>
                <th className="hidden px-4 py-2 font-semibold md:table-cell">{t("dash.sourceCol")}</th>
                <th className="hidden px-4 py-2 font-semibold md:table-cell">{t("dash.dueCol")}</th>
                <th className="hidden px-4 py-2 font-semibold lg:table-cell">{t("dash.costCol")}</th>
                <th className="px-4 py-2 font-semibold">{t("dash.statusCol")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.recent.map((w) => (
                <tr key={w.id} className="border-b border-line last:border-0 hover:bg-panel-2/60">
                  <td className="px-4 py-3 font-medium text-ink">{w.title}</td>
                  <td className="hidden px-4 py-3 sm:table-cell">
                    <TradeBadge trade={w.trade} />
                  </td>
                  <td className="px-4 py-3">
                    <PriorityBadge priority={w.priority} />
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <SourceBadge source={w.source} />
                  </td>
                  <td className="hidden px-4 py-3 text-dim md:table-cell">{formatDate(w.due_date)}</td>
                  <td className="hidden px-4 py-3 text-dim lg:table-cell">{formatCost(w.cost)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={w.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    ),
  };

  const visiblePanels = panels.filter((id) => PANEL_IDS.includes(id));

  function move(id: string, dir: -1 | 1) {
    const idx = visiblePanels.indexOf(id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= visiblePanels.length) return;
    const next = [...visiblePanels];
    [next[idx], next[target]] = [next[target], next[idx]];
    setPanels(next);
  }

  function togglePanel(id: string) {
    setPanels((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">{t("dash.title")}</h1>
          <p className="text-sm text-dim">{t("dash.subtitle")}</p>
        </div>
        {!editing ? (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {t("dash.customize")}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <Card className="p-4">
          <div className="mb-3">
            <h2 className="text-sm font-bold text-ink">{t("dash.customizeTitle")}</h2>
            <p className="text-xs text-dim">{t("dash.customizeDesc")}</p>
          </div>
          <ul className="space-y-2">
            {PANELS.map((p) => {
              const on = visiblePanels.includes(p.id);
              return (
                <li key={p.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${on ? "border-line bg-panel-2/50" : "border-dashed border-line opacity-60"}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => togglePanel(p.id)}
                    className="h-4 w-4 accent-amber"
                  />
                  <span className="flex-1 text-sm text-ink">{panelTitle[p.id]}</span>
                  <button
                    type="button"
                    disabled={!on || visiblePanels.indexOf(p.id) === 0}
                    onClick={() => move(p.id, -1)}
                    className="rounded p-1 text-dim hover:bg-panel hover:text-ink disabled:opacity-30"
                    title={t("dash.moveUp")}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={!on || visiblePanels.indexOf(p.id) === visiblePanels.length - 1}
                    onClick={() => move(p.id, 1)}
                    className="rounded p-1 text-dim hover:bg-panel hover:text-ink disabled:opacity-30"
                    title={t("dash.moveDown")}
                  >
                    ↓
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => savePanels(visiblePanels)} disabled={saving}>
              {saving ? t("dash.saving") : t("dash.saveLayout")}
            </Button>
          </div>
        </Card>
      ) : null}

      {visiblePanels.map((id) => {
        const render = renderers[id];
        const node = render ? render() : null;
        return node == null ? null : <div key={id}>{node}</div>;
      })}
    </div>
  );
}
