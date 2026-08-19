// Display helpers: labels, colors, and formatting for the Facilix domain.
// Class names are literal so Tailwind's JIT picks them up.

import type { ConfigType, Trade } from "./types";

// Controlled closeout failure codes (Phase 8) — must mirror db/schema.sql's
// `failure_code` enum so the picker and stored values stay in lockstep.
export const FAILURE_CODES: Record<string, string> = {
  wear_and_tear: "Wear & tear",
  corrosion: "Corrosion",
  lubrication: "Lubrication",
  blockage: "Blockage",
  leak: "Leak",
  electrical_fault: "Electrical fault",
  overload: "Overload",
  foreign_object: "Foreign object",
  operator_error: "Operator error",
  installation_error: "Installation error",
  manufacturer_defect: "Manufacturer defect",
  water_damage: "Water damage",
  no_fault_found: "No fault found",
  other: "Other",
};

export const TRADES: Record<Trade, { label: string; text: string; bg: string }> = {
  plumbing: { label: "Plumbing", text: "text-plumbing", bg: "bg-plumbing/15" },
  electrical: { label: "Electrical", text: "text-electrical", bg: "bg-electrical/15" },
  gardening: { label: "Gardening", text: "text-gardening", bg: "bg-gardening/15" },
  janitorial: { label: "Janitorial", text: "text-janitorial", bg: "bg-janitorial/15" },
  hvac: { label: "HVAC", text: "text-amber", bg: "bg-amber/15" },
  carpentry: { label: "Carpentry", text: "text-amber", bg: "bg-amber/15" },
  masonry: { label: "Masonry", text: "text-amber", bg: "bg-amber/15" },
  painting: { label: "Painting", text: "text-amber", bg: "bg-amber/15" },
  security: { label: "Security", text: "text-amber", bg: "bg-amber/15" },
  general: { label: "General", text: "text-dim", bg: "bg-dim/15" },
};

export const PRIORITIES: Record<string, { label: string; text: string; bg: string }> = {
  urgent: { label: "Urgent", text: "text-danger", bg: "bg-danger/15" },
  high: { label: "High", text: "text-amber", bg: "bg-amber/15" },
  normal: { label: "Normal", text: "text-dim", bg: "bg-dim/15" },
  low: { label: "Low", text: "text-dim", bg: "bg-dim/10" },
};

export const STATUSES: Record<string, { label: string; text: string; bg: string }> = {
  open: { label: "Open", text: "text-amber", bg: "bg-amber/15" },
  assigned: { label: "Assigned", text: "text-plumbing", bg: "bg-plumbing/15" },
  in_progress: { label: "In Progress", text: "text-plumbing", bg: "bg-plumbing/15" },
  done: { label: "Done", text: "text-gardening", bg: "bg-gardening/15" },
  verified: { label: "Verified", text: "text-gardening", bg: "bg-gardening/15" },
  cancelled: { label: "Cancelled", text: "text-dim", bg: "bg-dim/10" },
};

export const SOURCES: Record<string, string> = {
  plan: "Plan",
  breakdown: "Breakdown",
  tenant_request: "Tenant request",
};

export const TRIGGERS: Record<string, string> = {
  scheduled: "Scheduled",
  meter_based: "Meter-based",
  on_demand: "On demand",
};

export const ASSET_TYPES: Record<string, string> = {
  electrical: "Electrical",
  plumbing: "Plumbing",
  hvac: "HVAC",
  safety: "Safety",
  telecom: "Telecom",
  it: "IT",
  conveyor: "Conveyor",
  green_area: "Green area",
  furniture: "Furniture",
  janitorial_equipment: "Janitorial equipment",
  external_infrastructure: "External infrastructure",
  other: "Other",
};

export const TRADE_OPTIONS: Trade[] = [
  "plumbing",
  "electrical",
  "gardening",
  "janitorial",
  "hvac",
  "carpentry",
  "masonry",
  "painting",
  "security",
  "general",
];

// Fallback option lists for the runtime-configurable vocabulary, used only when
// the config endpoint hasn't loaded yet. Screens should prefer ConfigContext.
export const BUILTIN_TRADE_OPTIONS: ConfigType[] = TRADE_OPTIONS.map((v) => ({
  value: v,
  label: TRADES[v].label,
  active: true,
}));

export const BUILTIN_ASSET_TYPE_OPTIONS: ConfigType[] = Object.entries(ASSET_TYPES).map(([value, label]) => ({
  value,
  label,
  active: true,
}));

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Phase 11 — permit-to-work registry labels (mirror db/schema.sql's enums).
export const PERMIT_TYPES: Record<string, string> = {
  loto: "LOTO",
  confined_space: "Confined space",
  hot_work: "Hot work",
  electrical_isolation: "Electrical isolation",
  working_at_height: "Working at height",
  other: "Other",
};

export const PERMIT_STATUSES: Record<string, { label: string; text: string; bg: string }> = {
  draft: { label: "Draft", text: "text-dim", bg: "bg-dim/15" },
  issued: { label: "Issued", text: "text-gardening", bg: "bg-gardening/15" },
  closed: { label: "Closed", text: "text-dim", bg: "bg-dim/10" },
  cancelled: { label: "Cancelled", text: "text-danger", bg: "bg-danger/15" },
};

// Phase 9 — purchase order lifecycle labels (mirror db/schema.sql's enum).
export const PO_STATUSES: Record<string, { label: string; text: string; bg: string }> = {
  draft: { label: "Draft", text: "text-dim", bg: "bg-dim/15" },
  submitted: { label: "Submitted", text: "text-plumbing", bg: "bg-plumbing/15" },
  approved: { label: "Approved", text: "text-amber", bg: "bg-amber/15" },
  received: { label: "Received", text: "text-gardening", bg: "bg-gardening/15" },
  cancelled: { label: "Cancelled", text: "text-danger", bg: "bg-danger/15" },
};

// Supplier contract status labels — derived from the term plus the notice
// window, so the badge matches the scheduler's classification.
export const CONTRACT_STATUSES: Record<string, { label: string; text: string; bg: string }> = {
  active: { label: "Active", text: "text-gardening", bg: "bg-gardening/15" },
  expiring: { label: "Expiring soon", text: "text-amber", bg: "bg-amber/15" },
  expired: { label: "Expired", text: "text-danger", bg: "bg-danger/15" },
  terminated: { label: "Terminated", text: "text-dim", bg: "bg-dim/15" },
};

export const CONTRACT_TYPES: Record<string, string> = {
  utility: "Utility",
  rental: "Rental",
  sale: "Sale",
  service: "Service",
};

export const INVOICE_STATUSES: Record<string, { label: string; text: string; bg: string }> = {
  draft: { label: "Draft", text: "text-dim", bg: "bg-dim/15" },
  issued: { label: "Issued", text: "text-sky", bg: "bg-sky/15" },
  paid: { label: "Paid", text: "text-gardening", bg: "bg-gardening/15" },
  void: { label: "Void", text: "text-danger", bg: "bg-danger/15" },
};

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  // DATE columns arrive as "YYYY-MM-DD" — parse as local, not UTC, to avoid
  // timezone shifting the displayed day.
  const value = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso;
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatCost(cost: string | number | null | undefined): string {
  if (cost == null) return "—";
  return `KES ${Number(cost).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
