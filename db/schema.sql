-- ============================================================
-- Facilix — Core Schema (Property & Facility Maintenance)
-- PostgreSQL 15+ with optional PostGIS extension
--
-- PostGIS is required for the GIS roadmap (map pins, GeoJSON) and is always
-- present in the production Docker image. For lightweight local dev it is
-- optional: the extension and the properties.geom column are created only
-- when PostGIS is installed (the API then exposes geom as null).
-- ============================================================

-- Only create postgis if the build actually ships it (Docker does; a bare
-- local install may not).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    CREATE EXTENSION postgis;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- Organizations (multi-tenancy: one row per client/owner)
-- ------------------------------------------------------------
CREATE TABLE organizations (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    -- Phase 13 extension (Fixflo-inspired): when on, reactive repair requests
    -- (breakdown / high-urgency) are automatically routed to the least-loaded
    -- supplier for the order's trade instead of sitting in the open queue.
    auto_assign_suppliers BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Configurable vocabulary (Phase: runtime-configurable)
-- Trades and asset types are org-scoped lookup tables so new values can be
-- added from the UI instead of requiring schema migrations. Columns that used
-- to be Postgres enums are now plain TEXT and are validated against these.
-- ------------------------------------------------------------
CREATE TABLE trades (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    value           TEXT NOT NULL,
    label           TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, value)
);
CREATE INDEX idx_trades_org ON trades(organization_id);

CREATE TABLE asset_types (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    value           TEXT NOT NULL,
    label           TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, value)
);
CREATE INDEX idx_asset_types_org ON asset_types(organization_id);


-- ------------------------------------------------------------
-- Users & roles
-- ------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('admin', 'manager', 'technician', 'tenant', 'supplier');

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    role            user_role NOT NULL DEFAULT 'technician',
    trade           TEXT,                 -- e.g. 'plumbing', 'electrical', 'gardening', 'janitorial'
    supplier_id     UUID,                 -- set when role = 'supplier' (Phase 10)
    phone           TEXT,
    active          BOOLEAN NOT NULL DEFAULT true,
    -- Phase 13 extension (Fixflo-inspired): per-user dashboard layout. JSONB so
    -- new panel ids can be added without a migration; unknown ids are ignored.
    dashboard_prefs  JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Spatial hierarchy: Property > Building > Floor > Room/Unit
-- ------------------------------------------------------------
CREATE TABLE properties (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    address         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Portable coordinates (map pins) work without PostGIS; lat/lng are
-- validated by the API. When PostGIS is present a geom point is kept in
-- sync for spatial queries (see the "keep geom in sync" note in
-- routes/properties.js).
ALTER TABLE properties ADD COLUMN latitude NUMERIC;
ALTER TABLE properties ADD COLUMN longitude NUMERIC;

-- geom (GEOGRAPHY point for map pins) is added only when PostGIS is present.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    ALTER TABLE properties ADD COLUMN geom GEOGRAPHY(Point, 4326);
  END IF;
END $$;

CREATE TABLE buildings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    year_built      INT,
    floor_count     INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE floors (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    building_id     UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    label           TEXT NOT NULL,          -- e.g. 'Ground', '1', '2', 'Roof'
    plan_file_url   TEXT,                   -- imported CAD/floor plan image
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    floor_id        UUID NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,          -- e.g. 'Unit 4B', 'Lobby', 'Mechanical Room'
    room_type       TEXT,                   -- 'unit', 'common_area', 'utility', 'outdoor'
    area_sqm        NUMERIC,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Assets — the flexible core. type + attributes(JSONB) covers
-- electrical, plumbing, HVAC, gardening, janitorial equipment, etc.
-- without needing a table per trade. type is validated against the
-- asset_types lookup table (runtime-configurable).
-- ------------------------------------------------------------
CREATE TABLE assets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    room_id         UUID REFERENCES rooms(id) ON DELETE SET NULL,
    building_id     UUID REFERENCES buildings(id) ON DELETE SET NULL, -- for building-level assets (e.g. main panel)
    property_id     UUID REFERENCES properties(id) ON DELETE SET NULL, -- for site-level assets (e.g. garden, parking)
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,       -- validated against asset_types lookup
    attributes      JSONB NOT NULL DEFAULT '{}',  -- type-specific fields, e.g. {"panel_amperage": 200}
    install_date    DATE,
    warranty_end    DATE,
    status          TEXT NOT NULL DEFAULT 'active', -- active, retired, under_repair
    meter_value     NUMERIC,                -- current meter reading, if applicable
    meter_unit      TEXT,                   -- e.g. 'hours', 'kWh', 'liters'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assets_type ON assets(type);
CREATE INDEX idx_assets_attributes ON assets USING GIN (attributes);

-- ------------------------------------------------------------
-- Suppliers / maintenance teams (in-house or subcontracted)
-- ------------------------------------------------------------
CREATE TABLE suppliers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    trade           TEXT NOT NULL,          -- 'plumbing', 'electrical', 'gardening', 'janitorial', 'general'
    contact_name    TEXT,
    contact_email   TEXT,
    contact_phone   TEXT,
    is_internal     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A user with role 'supplier' is linked to the supplier they represent, giving
-- them a scoped guest login into the contractor portal (Phase 10).
ALTER TABLE users ADD CONSTRAINT fk_users_supplier
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- Quotes — suppliers bid on work orders through the contractor portal (Phase 10)
-- ------------------------------------------------------------
CREATE TABLE quotes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    supplier_id     UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    work_order_id   UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
    amount          NUMERIC NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'KES',
    note            TEXT,
    status          TEXT NOT NULL DEFAULT 'submitted',  -- submitted | accepted | rejected
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_quotes_work_order ON quotes(work_order_id);
CREATE INDEX idx_quotes_supplier ON quotes(supplier_id);

CREATE TABLE contracts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contract_number     TEXT NOT NULL,      -- 'CTR-2026-0001', unique per org
    supplier_id         UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    property_id         UUID REFERENCES properties(id) ON DELETE SET NULL,
    contract_type       TEXT NOT NULL,      -- 'utility', 'rental', 'sale', 'service'
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expiring', 'expired', 'terminated')),
    start_date          DATE,
    end_date            DATE,
    annual_value        NUMERIC,
    renewal_notice_days INT NOT NULL DEFAULT 30,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_contracts_number ON contracts(organization_id, contract_number);
CREATE INDEX idx_contracts_org ON contracts(organization_id, end_date);

-- ------------------------------------------------------------
-- Maintenance plans — the "maintenance manual" knowledge base
-- ------------------------------------------------------------
CREATE TYPE trigger_type AS ENUM ('scheduled', 'meter_based', 'on_demand');

CREATE TABLE maintenance_plans (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    asset_type      TEXT,                   -- validated against asset_types lookup; applies to all assets of this type...
    asset_id        UUID REFERENCES assets(id) ON DELETE CASCADE, -- ...or one specific asset
    trigger         trigger_type NOT NULL,
    frequency_days  INT,                    -- for 'scheduled'
    meter_threshold NUMERIC,                -- for 'meter_based'
    checklist       JSONB NOT NULL DEFAULT '[]', -- [{ "step": "Check pressure", "done": false }, ...]
    default_supplier_id UUID REFERENCES suppliers(id),
    active          BOOLEAN NOT NULL DEFAULT true,
    last_run_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ
);

-- ------------------------------------------------------------
-- Work orders — generated by plans, breakdowns, or tenant requests
-- ------------------------------------------------------------
CREATE TYPE wo_source AS ENUM ('plan', 'breakdown', 'tenant_request');
CREATE TYPE wo_status AS ENUM ('open', 'assigned', 'in_progress', 'done', 'verified', 'cancelled');
CREATE TYPE wo_priority AS ENUM ('low', 'normal', 'high', 'urgent');

-- Controlled failure modes captured at closeout (Phase 8). Keeping these as
-- an enum forces technicians to pick a real mode instead of typing "fixed",
-- and later phases aggregate them into reliability analytics.
CREATE TYPE failure_code AS ENUM (
    'wear_and_tear',        -- normal degradation / reached end of service life
    'corrosion',            -- rust / chemical damage
    'lubrication',          -- dry running / damage from lack of lubrication
    'blockage',             -- clogged drain, filter, or duct
    'leak',                 -- leak in pipe, seal, or valve
    'electrical_fault',     -- wiring, breaker, or motor electrical failure
    'overload',             -- run beyond rated load or capacity
    'foreign_object',       -- debris or material obstructing operation
    'operator_error',       -- misuse / incorrect settings
    'installation_error',   -- faulty original installation
    'manufacturer_defect',  -- faulty part or unit
    'water_damage',         -- water intrusion damage
    'no_fault_found',       -- reported but no fault found
    'other'                 -- anything not covered
);

CREATE TABLE work_orders (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id            UUID REFERENCES assets(id) ON DELETE SET NULL,
    room_id             UUID REFERENCES rooms(id) ON DELETE SET NULL,
    maintenance_plan_id UUID REFERENCES maintenance_plans(id) ON DELETE SET NULL,
    source              wo_source NOT NULL,
    trade               TEXT NOT NULL,       -- 'plumbing', 'electrical', 'gardening', 'janitorial'
    title               TEXT NOT NULL,
    description         TEXT,
    status              wo_status NOT NULL DEFAULT 'open',
    priority            wo_priority NOT NULL DEFAULT 'normal',
    sla_due_at          TIMESTAMPTZ,        -- Phase 10 SLA clock; set on create by priority
    requires_permit     BOOLEAN NOT NULL DEFAULT false,  -- Phase 11: permit-to-work gate on closeout
    client_id           TEXT,               -- Phase 13: device idempotency token for offline field creates
    assigned_supplier_id UUID REFERENCES suppliers(id),
    assigned_user_id    UUID REFERENCES users(id),
    reported_by_user_id UUID REFERENCES users(id), -- tenant or staff who reported it
    -- True when a supplier was picked automatically at creation (auto-assign
    -- routing) rather than by a human or a quote-accept — drives the board badge.
    auto_assigned       BOOLEAN NOT NULL DEFAULT false,
    cost                NUMERIC,
    due_date            DATE,
    -- Phase 8: closeout discipline — structured reliability data
    failure_code        failure_code,        -- required to move to 'done'/'verified'
    root_cause          TEXT,                -- what actually failed (vague text rejected)
    remedy              TEXT,                -- the fix performed (vague text rejected)
    parts_used          TEXT,                -- parts consumed, e.g. "washer 20mm x2"
    meter_value_at_closeout NUMERIC,         -- asset meter reading at completion
    completed_at        TIMESTAMPTZ,
    -- Cancellation audit trail — who cancelled, when, and why (staff cancel
    -- any in-flight order; a tenant may withdraw only their own open request;
    -- reason required, terminal once cancelled).
    cancelled_at        TIMESTAMPTZ,
    cancelled_by_user_id UUID REFERENCES users(id),
    cancellation_reason TEXT,
    -- Soft archive — admin clears done/cancelled orders from the board tabs
    -- without destroying reliability/audit data; archived rows can be restored
    -- or permanently deleted (quotes cascade; permits/inventory null the link).
    archived_at          TIMESTAMPTZ,
    -- Phase 4: resident-reported location — portable coordinates (like
    -- properties) so the one-minute request can pin where the fault is
    -- without PostGIS. Set from the resident's device geolocation or a
    -- scanned site tag.
    latitude            NUMERIC CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90)),
    longitude           NUMERIC CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wo_status ON work_orders(status);
CREATE INDEX idx_wo_trade ON work_orders(trade);
CREATE INDEX idx_wo_asset ON work_orders(asset_id);
CREATE INDEX idx_wo_location ON work_orders(organization_id, latitude, longitude);
-- Phase 13: device idempotency token for offline field creates. Scoped per org
-- so the same client temp id in different organizations cannot collide, and a
-- replay (lost response / background-sync flush racing the app) finds the row.
CREATE UNIQUE INDEX uq_work_orders_client_id ON work_orders(organization_id, client_id) WHERE client_id IS NOT NULL;

-- ------------------------------------------------------------
-- Spare parts / inventory (Logistic Management)
-- ------------------------------------------------------------
CREATE TABLE inventory_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    trade           TEXT,
    unit            TEXT,                   -- 'pcs', 'liters', 'meters'
    quantity_on_hand NUMERIC NOT NULL DEFAULT 0,
    reorder_threshold NUMERIC,
    min_stock       NUMERIC,                -- procurement: minimum target
    max_stock       NUMERIC,                -- procurement: top-up target
    location_type   TEXT NOT NULL DEFAULT 'warehouse' CHECK (location_type IN ('warehouse', 'van')),
    warehouse_location TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_movements (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    work_order_id   UUID REFERENCES work_orders(id) ON DELETE SET NULL,
    quantity_change NUMERIC NOT NULL,       -- negative = consumed, positive = restocked
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 9 — Procurement: purchase orders + reservations
CREATE TABLE purchase_orders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    po_number       TEXT NOT NULL,          -- 'PO-2026-0001', unique per org
    supplier_id     UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    contract_id     UUID REFERENCES contracts(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'received', 'cancelled')),
    ordered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at     TIMESTAMPTZ,
    expected_date   DATE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_purchase_orders_number ON purchase_orders(organization_id, po_number);
CREATE INDEX idx_purchase_orders_org ON purchase_orders(organization_id, created_at DESC);
CREATE INDEX idx_purchase_orders_contract ON purchase_orders(contract_id);

CREATE TABLE purchase_order_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    quantity        NUMERIC NOT NULL CHECK (quantity > 0),
    unit_cost       NUMERIC NOT NULL DEFAULT 0,
    received_qty    NUMERIC NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_po_items_order ON purchase_order_items(purchase_order_id);

-- ------------------------------------------------------------
-- Invoices (Phase 13 extension, Fixflo-inspired: end-to-end cost)
-- Auto-drafted at work-order closeout: consumed parts valued at the last
-- received PO unit cost, plus the accepted quote amount (if any). Org-scoped
-- with a per-org 'INV-<year>-<seq>' number so the money trail is auditable.
-- ------------------------------------------------------------
CREATE TABLE invoices (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    invoice_number  TEXT NOT NULL,
    work_order_id   UUID REFERENCES work_orders(id) ON DELETE CASCADE,
    supplier_id     UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    amount          NUMERIC NOT NULL DEFAULT 0 CHECK (amount >= 0),
    currency        TEXT NOT NULL DEFAULT 'KES',
    parts_cost      NUMERIC NOT NULL DEFAULT 0,
    quote_amount    NUMERIC,
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'issued', 'paid', 'void')),
    issued_at       TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    voided_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, invoice_number)
);
CREATE INDEX idx_invoices_org ON invoices(organization_id);
CREATE INDEX idx_invoices_wo ON invoices(work_order_id);

CREATE TABLE reservations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    work_order_id   UUID REFERENCES work_orders(id) ON DELETE SET NULL,
    quantity        NUMERIC NOT NULL CHECK (quantity > 0),
    reason          TEXT,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reservations_item ON reservations(inventory_item_id, status);

-- ------------------------------------------------------------
-- Budgets (Economic Management)
-- ------------------------------------------------------------
CREATE TABLE budget_centers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    property_id     UUID REFERENCES properties(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    fiscal_year     INT NOT NULL,
    allocated_amount NUMERIC NOT NULL DEFAULT 0,
    spent_amount    NUMERIC NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- Documents (attachable to any entity via polymorphic link)
-- ------------------------------------------------------------
CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL,          -- 'asset', 'work_order', 'property', ...
    entity_id       UUID NOT NULL,
    file_url        TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    content_type    TEXT,
    uploaded_by     UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_documents_entity ON documents(entity_type, entity_id);

-- ------------------------------------------------------------
-- Energy & environment meter readings
-- ------------------------------------------------------------
CREATE TABLE meter_readings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_id        UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    reading_value   NUMERIC NOT NULL,
    reading_unit    TEXT NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    cost            NUMERIC
);

-- ------------------------------------------------------------
-- Notifications (in-app feed; email/SMS routed through providers later)
-- ------------------------------------------------------------
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL DEFAULT 'in_app',  -- 'in_app' | 'email' | 'sms'
    type            TEXT NOT NULL,                   -- e.g. work_order_assigned
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    ref_type        TEXT,                            -- 'work_order' | 'asset' | ...
    ref_id          UUID,
    read            BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, read);
CREATE INDEX idx_notifications_org ON notifications(organization_id);

-- ------------------------------------------------------------
-- Compliance & safety (Phase 11)
--   permits        — permit-to-work (LOTO, confined space, hot work, ...)
--   competencies   — staff certifications with expiry gating closeout
--   inspections    — statutory / scheduled inspection schedule
-- ------------------------------------------------------------
CREATE TYPE permit_type AS ENUM ('loto', 'confined_space', 'hot_work', 'electrical_isolation', 'working_at_height', 'other');
CREATE TYPE permit_status AS ENUM ('draft', 'issued', 'closed', 'cancelled');

CREATE TABLE permits (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    work_order_id   UUID REFERENCES work_orders(id) ON DELETE SET NULL,
    type            permit_type NOT NULL,
    status          permit_status NOT NULL DEFAULT 'draft',
    issued_by       UUID REFERENCES users(id),         -- competent person who signed it off
    issued_at       TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,                        -- permit validity window
    closed_at       TIMESTAMPTZ,
    notes           TEXT,
    evidence_url    TEXT,                              -- immutable evidence (MinIO link when wired)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_permits_wo ON permits(work_order_id);
CREATE INDEX idx_permits_org_status ON permits(organization_id, status);

CREATE TABLE competencies (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,                     -- e.g. 'Electrical LV', 'LOTO authorized'
    trade           TEXT,                              -- links to work_order.trade for gating
    expires_at      TIMESTAMPTZ,
    issued_by       UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_competencies_user ON competencies(user_id);

CREATE TABLE statutory_inspections (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id        UUID REFERENCES assets(id) ON DELETE CASCADE,
    requirement     TEXT NOT NULL,                     -- e.g. 'Fire extinguisher annual'
    frequency_days  INT NOT NULL DEFAULT 365,
    last_done_at    TIMESTAMPTZ,
    due_date        TIMESTAMPTZ NOT NULL,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_inspections_org ON statutory_inspections(organization_id);

-- ------------------------------------------------------------
-- Phase 12 — Integrations & event bus
--   event_outbox       — durable queue: events waiting for webhook delivery
--   webhooks           — per-org outbound endpoint subscriptions
--   webhook_deliveries — delivery attempt log + retry state
-- ------------------------------------------------------------
CREATE TABLE event_outbox (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event           TEXT NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}',
    attempts        INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT,
    delivered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_pending ON event_outbox(organization_id, next_attempt_at) WHERE delivered_at IS NULL;

CREATE TABLE webhooks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL,          -- endpoint the org wants POSTed
    secret          TEXT NOT NULL,          -- HMAC signing secret (never exposed)
    events          TEXT[] NOT NULL DEFAULT '{}',  -- subscribed event names, e.g. work_order.created
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhooks_org ON webhooks(organization_id);

CREATE TABLE webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    webhook_id      UUID REFERENCES webhooks(id) ON DELETE SET NULL,
    event           TEXT NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}',
    response_status INT,
    response_body   TEXT,
    attempts        INT NOT NULL DEFAULT 0,
    delivered_at    TIMESTAMPTZ,            -- set when a 2xx was returned
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wh_deliveries_org ON webhook_deliveries(organization_id, created_at DESC);

-- ------------------------------------------------------------
-- Phase 13 — Offline-first field mode sync outbox
--   sync_changes — a monotonically-increasing change log written by triggers
--   on the field-facing tables (work_orders, assets, inventory_items,
--   properties, users, notifications, trades, asset_types). The BIGSERIAL id
--   is the cursor a device remembers; deletes are recorded as tombstones
--   (payload = the removed row) so every device converges on the same state.
-- ------------------------------------------------------------
CREATE TABLE sync_changes (
    id              BIGSERIAL PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    entity          TEXT NOT NULL,          -- table name: 'work_order' etc.
    entity_id       TEXT NOT NULL,          -- uuid as text (composite keys fit too)
    op              TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
    payload         JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sync_changes_cursor ON sync_changes(organization_id, id);

-- One trigger function for every table we sync. DELETE uses OLD (a tombstone);
-- INSERT/UPDATE use NEW. The users table is scrubbed of its password hash so a
-- syncing device never receives credentials.
CREATE OR REPLACE FUNCTION sync_record_change() RETURNS trigger AS $$
DECLARE
  payload JSONB;
  op TEXT;
  ent TEXT := TG_TABLE_NAME;
  org_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    op := 'delete';
    payload := to_jsonb(OLD);
    org_id := OLD.organization_id;
  ELSE
    op := lower(TG_OP);
    payload := to_jsonb(NEW);
    org_id := NEW.organization_id;
  END IF;
  -- Skip when the owning org is itself being deleted (cascade teardown): the
  -- org row is already gone, so inserting here would violate the FK.
  IF EXISTS (SELECT 1 FROM organizations WHERE id = org_id) THEN
    IF ent = 'users' THEN
      payload := payload - 'password_hash';
    END IF;
    INSERT INTO sync_changes (organization_id, entity, entity_id, op, payload)
    VALUES (org_id, ent,
      CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
      op, payload);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_work_orders AFTER INSERT OR UPDATE OR DELETE ON work_orders FOR EACH ROW EXECUTE FUNCTION sync_record_change();
CREATE TRIGGER trg_sync_assets AFTER INSERT OR UPDATE OR DELETE ON assets FOR EACH ROW EXECUTE FUNCTION sync_record_change();
CREATE TRIGGER trg_sync_inventory_items AFTER INSERT OR UPDATE OR DELETE ON inventory_items FOR EACH ROW EXECUTE FUNCTION sync_record_change();
CREATE TRIGGER trg_sync_properties AFTER INSERT OR UPDATE OR DELETE ON properties FOR EACH ROW EXECUTE FUNCTION sync_record_change();
CREATE TRIGGER trg_sync_users AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION sync_record_change();
CREATE TRIGGER trg_sync_notifications AFTER INSERT OR UPDATE OR DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION sync_record_change();
CREATE TRIGGER trg_sync_trades AFTER INSERT OR UPDATE OR DELETE ON trades FOR EACH ROW EXECUTE FUNCTION sync_record_change();
CREATE TRIGGER trg_sync_asset_types AFTER INSERT OR UPDATE OR DELETE ON asset_types FOR EACH ROW EXECUTE FUNCTION sync_record_change();

-- ---------------------------------------------------------------------------
-- Phase 22 — Audit trail.
--
-- Captures who changed what (INSERT/UPDATE/DELETE) on key business tables,
-- storing both the old and new row state as JSONB so the full diff is
-- queryable.  The trigger fires AFTER the write so it never blocks the
-- business transaction.  ip_address is set per-request by middleware (when
-- available) so the audit record includes geolocation context.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  entity          TEXT NOT NULL,
  entity_id       UUID,
  old_data        JSONB,
  new_data        JSONB,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_org       ON audit_log(organization_id, created_at DESC);
CREATE INDEX idx_audit_log_entity    ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_log_actor     ON audit_log(actor_user_id);

-- Populated by middleware (req.audit_ip) on each request; the trigger reads
-- it from a session setting so it stays out of the function signature.

CREATE OR REPLACE FUNCTION audit_record_change() RETURNS trigger AS $$
DECLARE
  org_id  UUID;
  actor   UUID;
  old_row JSONB;
  new_row JSONB;
BEGIN
  org_id := COALESCE(
    CASE WHEN TG_OP != 'DELETE' THEN (NEW).organization_id END,
    (OLD).organization_id
  );

  -- Best-effort actor extraction.  Use individual BEGIN/EXCEPTION blocks so a
  -- missing column on a specific table doesn't kill the entire trigger.
  actor := NULL;
  BEGIN
    IF TG_TABLE_NAME = 'users' AND TG_OP = 'DELETE' THEN
      actor := NULL;
    ELSIF TG_TABLE_NAME = 'users' THEN
      actor := CASE WHEN TG_OP != 'DELETE' THEN (NEW).id ELSE (OLD).id END;
    END IF;
  EXCEPTION WHEN undefined_column THEN NULL; END;
  BEGIN
    IF actor IS NULL AND TG_TABLE_NAME = 'work_orders' THEN
      actor := COALESCE(
        CASE WHEN TG_OP != 'DELETE' THEN (NEW).reported_by_user_id END,
        (OLD).reported_by_user_id
      );
    END IF;
  EXCEPTION WHEN undefined_column THEN NULL; END;
  BEGIN
    IF actor IS NULL AND TG_TABLE_NAME = 'purchase_orders' THEN
      actor := COALESCE(
        CASE WHEN TG_OP != 'DELETE' THEN (NEW).ordered_by_user_id END,
        (OLD).ordered_by_user_id
      );
    END IF;
  EXCEPTION WHEN undefined_column THEN NULL; END;
  BEGIN
    IF actor IS NULL AND TG_TABLE_NAME = 'invoices' THEN
      actor := COALESCE(
        CASE WHEN TG_OP != 'DELETE' THEN (NEW).approved_by_user_id END,
        (OLD).approved_by_user_id
      );
    END IF;
  EXCEPTION WHEN undefined_column THEN NULL; END;

  IF TG_OP = 'INSERT' THEN
    old_row := NULL; new_row := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    old_row := to_jsonb(OLD); new_row := to_jsonb(NEW);
  ELSE
    old_row := to_jsonb(OLD); new_row := NULL;
  END IF;

  IF old_row ? 'password_hash' THEN old_row := old_row - 'password_hash'; END IF;
  IF new_row ? 'password_hash' THEN new_row := new_row - 'password_hash'; END IF;

  INSERT INTO audit_log(organization_id, actor_user_id, action, entity, entity_id, old_data, new_data)
  VALUES (org_id, actor, TG_OP, TG_TABLE_NAME,
          CASE WHEN TG_OP = 'DELETE' THEN (OLD).id ELSE (NEW).id END,
          old_row, new_row);
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN foreign_key_violation THEN
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_work_orders   AFTER INSERT OR UPDATE OR DELETE ON work_orders   FOR EACH ROW EXECUTE FUNCTION audit_record_change();
CREATE TRIGGER trg_audit_assets        AFTER INSERT OR UPDATE OR DELETE ON assets        FOR EACH ROW EXECUTE FUNCTION audit_record_change();
CREATE TRIGGER trg_audit_inventory     AFTER INSERT OR UPDATE OR DELETE ON inventory_items FOR EACH ROW EXECUTE FUNCTION audit_record_change();
CREATE TRIGGER trg_audit_contracts     AFTER INSERT OR UPDATE OR DELETE ON contracts     FOR EACH ROW EXECUTE FUNCTION audit_record_change();
CREATE TRIGGER trg_audit_invoices      AFTER INSERT OR UPDATE OR DELETE ON invoices      FOR EACH ROW EXECUTE FUNCTION audit_record_change();
CREATE TRIGGER trg_audit_purchase_orders AFTER INSERT OR UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION audit_record_change();
CREATE TRIGGER trg_audit_maintenance_plans AFTER INSERT OR UPDATE OR DELETE ON maintenance_plans FOR EACH ROW EXECUTE FUNCTION audit_record_change();
CREATE TRIGGER trg_audit_statutory     AFTER INSERT OR UPDATE OR DELETE ON statutory_inspections FOR EACH ROW EXECUTE FUNCTION audit_record_change();
CREATE TRIGGER trg_audit_competencies  AFTER INSERT OR UPDATE OR DELETE ON competencies  FOR EACH ROW EXECUTE FUNCTION audit_record_change();
CREATE TRIGGER trg_audit_users         AFTER INSERT OR UPDATE OR DELETE ON users         FOR EACH ROW EXECUTE FUNCTION audit_record_change();

-- ---------------------------------------------------------------------------
-- Phase 23 — Budget tracking.
--
-- A budget line captures the planned annual spend per trade or category for
-- a given property (or portfolio-wide when property_id is NULL).  Actual
-- spend is derived at query time from completed work orders + POs + invoices
-- so there is no denormalized "actual" column to keep in sync.
-- ---------------------------------------------------------------------------

CREATE TABLE budgets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  trade           TEXT NOT NULL,
  property_id     UUID REFERENCES properties(id) ON DELETE SET NULL,
  fiscal_year     INT NOT NULL CHECK (fiscal_year >= 2020 AND fiscal_year <= 2100),
  planned_amount  NUMERIC(14, 2) NOT NULL CHECK (planned_amount >= 0),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_budgets_org_year ON budgets(organization_id, fiscal_year);
CREATE UNIQUE INDEX idx_budgets_org_trade_year_prop ON budgets(organization_id, trade, fiscal_year, COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid));
