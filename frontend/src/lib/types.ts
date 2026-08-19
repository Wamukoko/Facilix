// API response shapes — mirror the backend's SQL columns (snake_case) and the
// `{ data, meta }` pagination envelope.

export type Role = "admin" | "manager" | "technician" | "tenant" | "supplier";

// Trades and asset types are runtime-configurable per org (see /api/config).
// The string keys below are the built-in defaults; custom values are added via
// the config endpoint and surfaced through ConfigContext.
export type Trade = string;

export type AssetType = string;

export type WorkOrderStatus = "open" | "assigned" | "in_progress" | "done" | "verified" | "cancelled";
export type WorkOrderPriority = "low" | "normal" | "high" | "urgent";
export type WorkOrderSource = "plan" | "breakdown" | "tenant_request";
export type TriggerType = "scheduled" | "meter_based" | "on_demand";
export type FailureCode =
  | "wear_and_tear"
  | "corrosion"
  | "lubrication"
  | "blockage"
  | "leak"
  | "electrical_fault"
  | "overload"
  | "foreign_object"
  | "operator_error"
  | "installation_error"
  | "manufacturer_defect"
  | "water_damage"
  | "no_fault_found"
  | "other";

export interface Paged<T> {
  data: T[];
  meta: { total: number; limit: number; offset: number };
}

export interface ConfigType {
  value: string;
  label: string;
  active: boolean;
}

export interface Config {
  trades: ConfigType[];
  asset_types: ConfigType[];
  auto_assign_suppliers: boolean;
}

export interface StaffUser {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  trade: string | null;
  supplier_id: string | null;
  active: boolean;
}

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  trade: string | null;
  phone: string | null;
  supplier_id: string | null;
  organization_id: string;
  organization_name: string | null;
}

export interface Property {
  id: string;
  name: string;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  geom: string | null;
  buildings_count: number;
  open_work_orders: number;
  created_at: string;
}

export interface Asset {
  id: string;
  organization_id: string;
  room_id: string | null;
  building_id: string | null;
  property_id: string | null;
  name: string;
  type: AssetType;
  attributes: Record<string, unknown>;
  install_date: string | null;
  warranty_end: string | null;
  status: "active" | "retired" | "under_repair";
  meter_value: string | null;
  meter_unit: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkOrder {
  id: string;
  organization_id: string;
  asset_id: string | null;
  room_id: string | null;
  maintenance_plan_id: string | null;
  source: WorkOrderSource;
  trade: Trade;
  title: string;
  description: string | null;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  assigned_supplier_id: string | null;
  assigned_user_id: string | null;
  reported_by_user_id: string | null;
  auto_assigned?: boolean | null;
  cost: string | null;
  due_date: string | null;
  failure_code: FailureCode | null;
  root_cause: string | null;
  remedy: string | null;
  parts_used: string | null;
  meter_value_at_closeout: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_by_user_id: string | null;
  cancelled_by_name: string | null;
  cancellation_reason: string | null;
  archived_at: string | null;
  sla_due_at: string | null;
  sla_breached: boolean | null;
  latitude: number | null;
  longitude: number | null;
  document_count: number | null;
  created_at: string;
  updated_at: string;
}

// AI-triage suggestion for a resident request — a trade + urgency derived from
// the free text (nulls when nothing matched or the trade isn't configured).
export interface TriageSuggestion {
  trade: Trade | null;
  priority: WorkOrderPriority | null;
  confidence: number;
  matched: string[];
  label: string | null;
}

// File attachment on any entity (asset / work_order / property). file_url is
// a /files/<key> path — load it through api.fileUrl() so the JWT travels with
// the request.
export interface Document {
  id: string;
  entity_type: string;
  entity_id: string;
  file_url: string;
  file_name: string;
  content_type: string | null;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  created_at: string;
}

export interface MaintenancePlan {
  id: string;
  organization_id: string;
  name: string;
  asset_type: AssetType | null;
  asset_id: string | null;
  trigger: TriggerType;
  frequency_days: number | null;
  meter_threshold: string | null;
  checklist: { step: string; done?: boolean }[];
  default_supplier_id: string | null;
  active: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  due: boolean;
  open_work_orders: number;
  created_at: string;
}

export interface Supplier {
  id: string;
  organization_id: string;
  name: string;
  trade: Trade;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  is_internal: boolean;
  created_at: string;
}

export interface InventoryItem {
  id: string;
  organization_id: string;
  name: string;
  trade: Trade | null;
  unit: string | null;
  quantity_on_hand: string;
  reorder_threshold: string | null;
  min_stock: string | null;
  max_stock: string | null;
  location_type: "warehouse" | "van";
  reserved_qty: string;
  warehouse_location: string | null;
  created_at: string;
}

export interface InventoryMovement {
  id: string;
  inventory_item_id: string;
  work_order_id: string | null;
  quantity_change: string;
  reason: string | null;
  created_at: string;
}

export interface Reservation {
  id: string;
  inventory_item_id: string;
  work_order_id: string | null;
  quantity: string;
  reason: string | null;
  status: "active" | "released";
  created_at: string;
}

export interface ReorderRecommendation {
  id: string;
  name: string;
  trade: Trade | null;
  unit: string | null;
  quantity_on_hand: string;
  reorder_threshold: string;
  min_stock: string | null;
  max_stock: string | null;
  reserved_qty: string;
  last_unit_cost: string | null;
  suggested_qty: number;
  estimated_cost: string | null;
}

export type PurchaseOrderStatus = "draft" | "submitted" | "approved" | "received" | "cancelled";

export interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_id: string | null;
  supplier_name: string | null;
  contract_id: string | null;
  contract_number: string | null;
  status: PurchaseOrderStatus;
  ordered_by_name: string | null;
  approved_by_name: string | null;
  expected_date: string | null;
  notes: string | null;
  total: number;
  item_count: number;
  items: PurchaseOrderItem[];
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderItem {
  id: string;
  purchase_order_id: string;
  inventory_item_id: string;
  item_name: string;
  unit: string | null;
  quantity: string;
  unit_cost: string;
  received_qty: string;
  created_at: string;
}

export type ContractType = "utility" | "rental" | "sale" | "service";
export type ContractStatus = "active" | "expiring" | "expired" | "terminated";

export interface Contract {
  id: string;
  organization_id: string;
  contract_number: string;
  supplier_id: string | null;
  supplier_name: string | null;
  property_id: string | null;
  property_name: string | null;
  contract_type: ContractType;
  status: ContractStatus;
  effective_status: ContractStatus;
  start_date: string | null;
  end_date: string | null;
  annual_value: string | null;
  renewal_notice_days: number;
  notes: string | null;
  days_to_expiry: number | null;
  po_spend: number;
  po_count: number;
  over_budget: boolean;
  purchase_orders?: ContractPurchaseOrder[];
  created_at: string;
  updated_at: string;
}

export interface ContractPurchaseOrder {
  id: string;
  po_number: string;
  status: PurchaseOrderStatus;
  expected_date: string | null;
  po_total: number;
}

export interface Notification {
  id: string;
  organization_id: string;
  user_id: string | null;
  channel: string;
  type: string;
  title: string;
  body: string;
  ref_type: string | null;
  ref_id: string | null;
  read: boolean;
  created_at: string;
}

export type InvoiceStatus = "draft" | "issued" | "paid" | "void";

export interface Invoice {
  id: string;
  organization_id: string;
  invoice_number: string;
  work_order_id: string | null;
  work_order_title: string | null;
  work_order_status: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  amount: string;
  currency: string;
  parts_cost: string;
  quote_amount: string | null;
  status: InvoiceStatus;
  issued_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  created_at: string;
}

export type PermitType =
  | "loto"
  | "confined_space"
  | "hot_work"
  | "electrical_isolation"
  | "working_at_height"
  | "other";
export type PermitStatus = "draft" | "issued" | "closed" | "cancelled";

export interface Permit {
  id: string;
  organization_id: string;
  work_order_id: string | null;
  type: PermitType;
  status: PermitStatus;
  issued_by: string | null;
  issued_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
  notes: string | null;
  evidence_url: string | null;
  has_evidence?: boolean;
  created_at: string;
}

export interface Competency {
  id: string;
  organization_id: string;
  user_id: string;
  name: string;
  trade: string | null;
  expires_at: string | null;
  issued_by: string | null;
  created_at: string;
  user_name?: string;
  expired?: boolean;
}

export interface StatutoryInspection {
  id: string;
  organization_id: string;
  asset_id: string | null;
  requirement: string;
  frequency_days: string | number;
  last_done_at: string | null;
  due_date: string;
  notes: string | null;
  created_at: string;
  overdue?: boolean;
}

export interface ComplianceSummary {
  open_permits: number;
  expired_competencies: number;
  overdue_inspections: number;
}

export interface MeterReading {
  id: string;
  asset_id: string;
  reading_value: string;
  reading_unit: string;
  recorded_at: string;
  cost: string | null;
}

export interface MeterTrendPoint extends MeterReading {
  delta: number | null;
  rate_per_day: number | null;
  anomaly: boolean;
}

export interface MeterTrend {
  asset: { id: string; name: string; type: string; meter_value: string | null; meter_unit: string | null };
  readings: MeterTrendPoint[];
  thresholds: {
    plan_id: string;
    plan_name: string;
    threshold: string;
    reached: boolean;
    predicted_days: number | null;
  }[];
}

export interface MeterAlert {
  asset_id: string;
  asset_name: string;
  asset_type: string;
  meter_value: string;
  meter_unit: string | null;
  plan_id: string;
  plan_name: string;
  meter_threshold: string;
  status: "breached" | "near";
}

// Phase 13 — offline-first field mode.
export interface SyncChange {
  id: number;
  organization_id: string;
  entity: string;
  entity_id: string;
  op: "insert" | "update" | "delete";
  payload: Record<string, unknown> | null;
  created_at: string;
}

export type SyncOp =
  | { op: "work_order.create"; client_id?: string; client_updated_at?: string; data: Record<string, unknown> }
  | { op: "work_order.update"; entity_id: string; client_updated_at: string; data: Record<string, unknown> }
  | { op: "meter_reading.create"; client_id?: string; client_updated_at?: string; data: Record<string, unknown> }
  | { op: "inventory_movement.create"; client_id?: string; client_updated_at?: string; data: Record<string, unknown> }
  | { op: "asset.update"; entity_id: string; client_updated_at: string; data: Record<string, unknown> }
  | { op: "document.create"; client_id?: string; data: Record<string, unknown> };

export interface SyncOpResult {
  op: string;
  entity?: string;
  entity_id: string | null;
  client_id: string | null;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  row?: Record<string, unknown>;
  server_entity_id?: string;
  server_updated_at?: string;
  quantity_on_hand?: number;
}
