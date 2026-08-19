import type { ReactNode } from "react";
import { PRIORITIES, SOURCES, STATUSES, TRADES, TRIGGERS, titleCase } from "../lib/format";
import type { MaintenancePlan, Trade, WorkOrder, WorkOrderPriority, WorkOrderStatus } from "../lib/types";

function Chip({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

export function TradeBadge({ trade }: { trade: Trade }) {
  // Custom trades (added via /api/config) aren't in the built-in palette — fall
  // back to a neutral chip with the humanized value so badges never break.
  const t = TRADES[trade];
  if (t) return <Chip className={`${t.bg} ${t.text}`}>{t.label}</Chip>;
  return <Chip className="bg-dim/10 text-dim">{titleCase(trade)}</Chip>;
}

export function StatusBadge({ status }: { status: WorkOrderStatus }) {
  const s = STATUSES[status] ?? STATUSES.open;
  return <Chip className={`${s.bg} ${s.text}`}>{s.label}</Chip>;
}

export function PriorityBadge({ priority }: { priority: WorkOrderPriority }) {
  const p = PRIORITIES[priority] ?? PRIORITIES.normal;
  return <Chip className={`${p.bg} ${p.text}`}>{p.label}</Chip>;
}

export function SourceBadge({ source }: { source: WorkOrder["source"] }) {
  return <Chip className="bg-dim/10 text-dim">{SOURCES[source] ?? source}</Chip>;
}

export function TriggerBadge({ trigger }: { trigger: MaintenancePlan["trigger"] }) {
  return <Chip className="bg-dim/10 text-dim">{TRIGGERS[trigger] ?? trigger}</Chip>;
}
