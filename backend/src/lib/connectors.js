// Phase 12 — connector adapters (M365 / Google Workspace / ERP / BMS).
//
// Facilix integrates with external systems behind a narrow interface: an
// adapter is { id, name, kind, description, configured }. Real providers
// (OAuth, API clients) plug in here later; the registry below is the contract
// the rest of the app (and integrations routes) rely on.

const adapters = [
  {
    id: "microsoft_365",
    name: "Microsoft 365",
    kind: "calendar",
    description: "Push work-order deadlines and PM schedules to a shared Outlook calendar.",
    configured: false,
  },
  {
    id: "google_workspace",
    name: "Google Workspace",
    kind: "calendar",
    description: "Two-way calendar sync for maintenance schedules and inspections.",
    configured: false,
  },
  {
    id: "erp",
    name: "ERP / Accounting",
    kind: "finance",
    description: "Export costs, purchase orders, and supplier invoices to SAP/Oracle/custom ERPs.",
    configured: false,
  },
  {
    id: "bms",
    name: "Building Management System",
    kind: "iot",
    description: "Ingest meter and sensor telemetry into the condition-based maintenance engine.",
    configured: false,
  },
];

export function listConnectors() {
  return adapters.map((a) => ({ ...a }));
}
