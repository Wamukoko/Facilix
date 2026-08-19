# Facilix

A modern, self-hosted property & facility maintenance app — asset inventory,
preventive/breakdown maintenance, work orders, suppliers, and inventory — scoped for
property management covering plumbing, electrical, gardening, and janitorial work.

## What's here

```
db/
  schema.sql          → full PostgreSQL + PostGIS schema (assets, work orders,
                         maintenance plans, suppliers, inventory, budgets, docs)
backend/
  src/
    index.js          → Express app entrypoint (rate limiting, trust proxy)
    db.js             → Postgres connection pool + withTransaction helper
    scheduler.js       → daily cron job that turns maintenance plans into work orders
    pagination.js     → shared { data, meta } envelope for list endpoints
    notifications.js  → stub dispatch for email/SMS/in-app (providers plug in later)
    middleware/auth.js → JWT signing/verification + org-scoping + role checks
    middleware/errors.js → asyncHandler, ApiError, centralized error handler
    middleware/rateLimit.js → API-wide + stricter auth brute-force limiter
    middleware/validate.js → zod middleware + shared field schemas
    routes/
      auth.js           → signup/login (bcrypt + JWT issuing)
      properties.js    → properties/buildings CRUD + geo
      assets.js         → asset inventory CRUD (electrical, plumbing, HVAC, green areas...)
      maintenancePlans.js → the "maintenance manual" — scheduled & meter-based rules
      workOrders.js     → work order lifecycle (open → assigned → in_progress → done)
      suppliers.js      → trade contacts / maintenance teams
  test/
    pagination.test.js → unit tests (node --test)
frontend/
  src/
    lib/              → API client, types, formatting, data-fetch hook
    context/          → AuthProvider (JWT in-memory + localStorage session)
    components/       → UI primitives + status/trade badges
    layouts/          → app shell (tabs: dashboard / work orders / assets / plans / ... field / settings)
    screens/          → Login, Dashboard, WorkOrders board, Assets, MaintenancePlans, Inventory, PurchaseOrders, Field (offline board)
    lib/offline.ts    → IndexedDB cache / queue / meta store (Phase 13)
    lib/syncClient.ts → bootstrap, change-stream pull, write-ahead queue, /sync/ops replay (Phase 13)
  public/sw.js        → production service worker (shell precache + API read cache)
  public/manifest.webmanifest → PWA manifest
  vite.config.ts      → dev proxy /api → localhost:4000
  nginx.conf          → production: serves SPA + proxies /api to the API container
```

> All list endpoints return `{ data: [...], meta: { total, limit, offset } }` and
> accept `?limit=` (default 50, max 200) and `?offset=`.


There's also a runnable UI prototype (the dashboard/work order board) shown in the
chat as an interactive artifact — it demonstrates the same data model with mock data
so you can click through the flow before wiring up the real backend.

## Getting the backend running locally

1. **Install PostgreSQL 15+ with PostGIS**, or use Docker:
   ```bash
   docker run --name facilix-db -e POSTGRES_PASSWORD=facilix_password \
     -e POSTGRES_USER=facilix_user -e POSTGRES_DB=facilix \
     -p 5432:5432 -d postgis/postgis:15-3.4
   ```

2. **Load the schema:**
   ```bash
   psql postgres://facilix_user:facilix_password@localhost:5432/facilix -f db/schema.sql
   ```

3. **Install backend deps and configure env:**
   ```bash
   cd backend
   npm install
   cp .env.example .env   # then edit DATABASE_URL / JWT_SECRET
   ```

4. **Run it:**
   ```bash
   npm run dev
   ```
   API is now live at `http://localhost:4000`. Try `GET /health`.

5. **Load demo data (optional, idempotent):**
   ```bash
   npm run seed
   ```
   Wipes the database and creates the `Denvic Property Managers` demo
   workspace (all logins use password `facilix-demo`, e.g. admin
   `eric.newborn@denvic.co.ke`) — three admins, three managers, four trade
   technicians, eight residents/shop owners and a contractor-portal login.
   Denvic runs **Greatwall Gardens Estate** (Phase 1 & 2) on Shanghai Road,
   Pridelands, Athi River with units in the estate's own scheme (`A101`, `A102`,
   `A351`, `C622`, `E832`, `1601`, `1846`, `3032`) plus the **Greatwall Gardens
   Mall** (`Shop S203`), and also manages **Acacia Court** (Syokimau) and a
   **Denvic Corporate Centre** (Upper Hill, Nairobi). Buildings, floors, rooms,
   assets (borehole pump + backup generator and more), suppliers, maintenance
   plans, and work orders — including a metered borehole pump/genset and Phase 8
   closeout examples — are pre-seeded, along with invoices, contracts, POs,
   inventory and compliance records. Costs are in KES. Staff use Denvic's own
   domain (`<first.last>@denvic.co.ke`); residents and contractors are not staff,
   so they log in with personal/company emails (e.g. `fred.muka@gmail.com`,
   `alex.muthoka@gmail.com`, `joseph.muriuki@gmail.com`). Re-running clears and
   rebuilds the demo workspace.

6. **End-to-end smoke test (needs a live API on port 4000):**
   ```bash
   npm run e2e
   ```
    Boots its own API instance, then runs 177 checks against it — signup/auth,
    the work-order lifecycle, closeout enforcement (missing/`vague` fields →
    400), meter-reading capture, the no-PostGIS property fallback, and the
    Phase 13 sync contract (change stream, cursor pagination, tombstones,
    offline closeout/parts/meter/inventory ops, batch LWW sessions, stale skips,
    tenant+supplier isolation). Cleanup removes the workspace it created.

> `POST /api/auth/signup` and `POST /api/auth/login` are implemented — signup
> creates a new organization plus its first (admin) user and returns a JWT with
> `{ sub, orgId, role }` claims. To use them, create a `.env` with `DATABASE_URL`
> and a strong `JWT_SECRET`; the API refuses to boot in production with a default
> secret.

## Getting the frontend running locally

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 — proxies /api → localhost:4000
```

Sign up from the login screen ("Create workspace") to spin up an organization.
Tabs cover the dashboard, the work-order board (advance a card to move it
open → assigned → in_progress → done, or report a breakdown), assets, and
maintenance plans.

### Deploying with Docker (production only)

Local development does not use Docker — run Postgres locally and the API with
`npm run dev` as above. Docker is the **deployment/production** path, using the
`docker-compose.yml` at the repo root (PostgreSQL/PostGIS + MinIO + API + web;
the schema loads automatically the first time the DB volume is created).

```bash
cp .env.example .env            # set real secrets (JWT_SECRET is required)
docker compose up -d --build    # services come up behind your reverse proxy
```

The compose file does not publish the DB port to the host, sets `restart:
unless-stopped`, and health-checks every service. The frontend is served from an
nginx container that also proxies `/api/` to the API service, so the SPA stays
same-origin in production.

## How this maps to your use case (plumbing / electrical / gardening / janitorial)

- **Assets** table's `type` enum includes `electrical`, `plumbing`, `green_area`,
  `janitorial_equipment`, etc. — `attributes` (JSONB) holds trade-specific fields
  without needing a new table per trade (e.g. `{"panel_amperage": 200}` for
  electrical, `{"pipe_material": "copper"}` for plumbing).
- **Maintenance plans** define the recurring rules per trade — e.g. "quarterly
  plumbing inspection" (scheduled) or "irrigation check every 500L" (meter-based).
  The scheduler (`scheduler.js`) runs nightly and spawns work orders automatically.
- **Work orders** carry a `trade` field so you can filter/board by plumbing,
  electrical, gardening, janitorial, etc. `source` distinguishes plan-generated
  maintenance from breakdown reports and tenant self-service requests.
- **Suppliers** table covers both in-house staff and subcontracted trade companies,
  with a `trade` field for routing.

## Build roadmap (as discussed)

Phases 1–7 are the original plan; **8–14 add the gaps from `Gaps1.txt`**
(the same list appears in `Gaps2.txt`). "Gap" refers to the Gaps1.txt numbering.

| Phase | Scope | Gap(s) | Status |
|---|---|---|---|
| 1 | Auth, RBAC, property/asset CRUD | #1 (roles) | Done — including a Properties screen (create/edit/delete with an address→coordinates locate, open-work-order delete guard) |
| 2 | Maintenance plans + scheduler + work order lifecycle | #3 (hierarchy), #11 (meters) | Done — plan CRUD (create/edit/pause/resume/delete), on-demand run per plan, bulk due-run, daily 02:00 cron, no-pile-up guard, plan-sourced work orders, next-due/open-job tracking in the UI |
| 3 | Suppliers, contracts, cost tracking | #7 (vendors) | Done — contracts CRUD (org-unique `CTR-<year>-<seq>` numbers, types, dates, annual value, renewal-notice window), derived `active`/`expiring`/`expired`/`terminated` status, spend roll-up from linked POs with over-budget flags, expiry notifications + events, Contracts screen + dashboard alert |
| 4 | Tenant self-service portal (PWA): one-minute request — QR/NFC scan, photo/video, voice note, location, AI triage suggestions | #13, #8 | Done — resident portal (tenant login, one-minute request, status tracking, tenant-scoped data, withdraw); QR/NFC tag scan, photo/video capture, voice-note recorder, device location, and AI triage suggestions on the report form |
| 5 | GIS mapping (Leaflet + PostGIS) | #3 (site context) | Done — portable `latitude`/`longitude` on properties (works without PostGIS; `geom` stays in sync when PostGIS is present), `PATCH /properties/:id`, spatial aggregates (buildings, open work orders per site), interactive Leaflet map screen with work-load-coloured markers, popups, jump-to + edit-location, plus address→coordinates lookup (Nominatim) on create/edit |
| 6 | Dashboards, reporting & reliability intelligence: repeat failures, bad actors, MTBF/MTTR, PM effectiveness, overdue risk, self-service report builder | #4, #9 | Done — reliability aggregation + CSV report builder + dashboard panels |
| 7 | Notifications (email/SMS/push) + provider wiring | #10 (messaging) | Done — in-app feed persisted, wired into WO lifecycle, dashboard panel |
| 8 | Work-order closeout discipline: failure codes, root-cause prompts, meter capture, vague-entry rejection | #5 | Done — enum + columns, backend validation, closeout modal, tests |
| 9 | Inventory & procurement depth: min/max, movements, reservations, van stock, PO approvals, reorder recommendations | #6 | Done — CRUD + movements + low-stock + closeout consumption + screen; min/max + van stock; reservations (create/release, net availability); reorder recommendations with suggested qty + last price + one-click draft PO; full purchase-order lifecycle (draft → submit → admin/manager approve → receive → stock top-up) with line items, price history, and PO list/detail screens |
| 10 | Contractor portal: guest access, quotes + comparison, SLA clock, evidence capture, scorecards | #7, #1 (contractor mode) | Done — supplier role + scoped login, quote submit/compare/accept, SLA clock, scorecard, portal UI |
| 11 | Compliance & safety: permits, LOTO, competency expiry, statutory inspections, immutable evidence | #12 | Done — permit-to-work lifecycle + closeout gate, competency expiry, statutory inspections with due-date roll, compliance summary |
| 12 | Integrations & event bus: webhooks, CSV import/export, data dictionary, M365/G Workspace/ERP/BMS connectors | #10, #9 (economics) | Done — outbox-based event bus + HMAC-signed webhook delivery with retries, `/api/integrations` export/import + connector registry, public data dictionary, Settings panel |
| 13 | Offline-first field mode (PWA): cached assets/checklists/WOs, sync + conflict resolution, capture audit trail | #2, #14 | Done — production service worker (precached shell + API read cache + offline index fallback + Background Sync flush), IndexedDB cache/queue/conflict store, change-stream pull, write-ahead offline ops replayed via `/sync/ops` with batch LWW, server-id remapping so offline photos land on work orders created in the same session, a Field conflict-review surface (keep-mine / accept-server), Field screen with offline report/closeout/meter/stock/evidence modals, optimistic UI; 241/241 e2e |
| 14 | Condition-based maintenance: meter/sensor ingestion, thresholds, anomaly detection, evidence-backed WO recommendations | #11 | Done — reading ingestion (single + bulk) with monotonicity guard, threshold-crossing recommendations with evidence payload, trend/rate-spike detection, threshold projections, dashboard alerts |

**Cross-cutting (latest)** — runtime-configurable vocabulary and staff management:
- Trades and asset types are now org-scoped lookup tables (`trades` / `asset_types`), no longer Postgres enums. `GET /api/config` serves the org's vocabulary; admin/manager can add or deactivate options via `POST /api/config/:kind` and `PATCH /api/config/:kind/:value`. Every write route that stores a trade or asset type validates it against the lookup (400 for unknown/inactive values).
- New `POST /api/users` (admin/manager) creates staff accounts — only an admin can create admins, managers can add techs/other managers — and new accounts log straight in. `PATCH /api/users/:id` (admin) soft-deactivates/restores a member: deactivated staff can't log in but their work-order/competency history is preserved, with guards against deactivating yourself or the last active admin.
- New frontend screens: **Team** (staff roster with add/remove/restore) and **Settings** (manage trades/asset types). Trade/asset-type pickers across the app are config-driven, and custom values render as neutral chips.
- New **CalendarPicker** component replaces native date/datetime inputs with a consistent month-grid calendar + time picker across all browsers.
- **Phase 3 — supplier contracts & cost tracking**: full `contracts` lifecycle (`contract_type` utility/rental/sale/service, org-unique `CTR-<year>-<seq>` numbering, start/end dates, annual value, renewal-notice window in days). The live status (`active` / `expiring` / `expired` / `terminated`) is derived in pure JS (`backend/src/lib/contracts.js`, shared by the routes, the daily 02:00 scheduler pass, and an on-demand `POST /api/contracts/check-expiry` so admins can re-check or tests can drive it). Spend rolls up from **linked purchase orders** (draft/cancelled excluded) with an over-budget flag when committed spend exceeds the annual value. Entering the renewal window (or expiring) notifies every active admin/manager (`contract_expiring`/`contract_expired`) and publishes `contract.expiring`/`contract.expired` outbox events. Terminating is terminal — a terminated contract can't be edited or terminated again. New **Contracts** screen (status filter chips, spend-vs-annual bars with over-budget flags, create/edit modal, detail with linked-PO table + attachments, Terminate, Re-check expiries); the Purchase orders screen can attach a PO to a contract; the dashboard lists "N in or past the renewal window". Demo: `CTR-2026-0001` (PowerTech, expiring, 2 linked POs) + `CTR-2026-0002` (plumbing, active).
- **Phase 12 — integrations & event bus**: `publishEvent()` writes to an `event_outbox` and delivers to org webhooks (`/api/webhooks`) as signed HMAC-SHA256 POSTs (`X-Facilix-Signature`, `X-Facilix-Event`, dedupe on `event_id`), retrying failed deliveries with exponential backoff via a background worker (`POST /api/webhooks/flush` forces a pass). Events: `work_order.created/assigned/closed`, `inventory.low_stock`, `asset.threshold_crossed`, `compliance.permit_issued`. `/api/integrations` adds CSV export (5 kinds) + import (assets/inventory/properties), a connector-adapter registry (M365/G Workspace/ERP/BMS), and a **public** data dictionary at `/api/integrations/data-dictionary`. The Settings screen gains webhook CRUD, export buttons, and CSV import.
- **Phase 4 — tenant self-service portal (core)**: a `tenant` role logs into a dedicated resident portal (`/api/auth/login`, role scoped). Tenants open work orders as `source='tenant_request'` with `reported_by_user_id` forced to their own account (spoofing rejected), and `GET /api/work-orders` returns **only their own requests** — never the org portfolio; tenants are blocked from mutating work orders (403). Admins/Managers create tenant accounts via the Team screen (tenants now appear in the `/api/users` roster), and `POST /api/users` already allowed the `tenant` role. Frontend: new **Resident portal** screen (`TenantPortal.tsx`) — one-minute "Report a problem" form (title, category, urgency, details) + "My requests" tracker (status, priority, SLA due, SLA-breached flags). Demo tenant `fred.muka@gmail.com` / `facilix-demo` with a live seeded request. **Phase 4 extensions shipped:** the report form now offers AI triage suggestions as you type (a pure keyword/hazard classifier in `backend/src/triage.js` behind `POST /api/triage`, which only suggests trades the org has configured), a QR/NFC site-tag scan (Web NFC + BarcodeDetector camera scan + photo-decode via jsQR + manual entry; `facilix://trade/<trade>` / `facilix://location/<text>` payloads pre-fill the form), a device-location pin (`work_orders.latitude`/`longitude`, validated ranges, shown on request rows), and photo/video capture (`capture="environment"`) plus an inline voice-note recorder (MediaRecorder) staged and uploaded as work-order attachments after filing — each request row shows its evidence count (`document_count`) and coordinates.
- **Work-order cancellation discipline**: cancelling a work order is now **two-tier**. Admins/managers can cancel any in-flight order (`open`/`assigned`/`in_progress`) — a reason is required (vague answers like "n/a" are rejected via the same text discipline as closeouts) and it's fully audited, with `work_orders` gaining `cancelled_at` / `cancelled_by_user_id` / `cancellation_reason` (server-stamped, never accepted from the body), the reporter notified, and a `work_order.cancelled` webhook event firing. A **tenant** may only *withdraw* their **own** `tenant_request` order while it's still **open** (unassigned) — same reason-required audit (stamped `cancelled_by_user_id = tenant`), but staff are notified instead via a `work_order_withdrawn` in-app notification so the request doesn't silently vanish from the board. Cancelled orders are **terminal**: they can't be re-advanced (400) and only cancel from `open`/`assigned`/`in_progress` is allowed. The board gains status **tabs** (All / Open / Assigned / In progress / Done / Cancelled) with a reason-required cancel modal and a "Cancelled by &lt;name&gt; · date — reason" line on cancelled cards (`cancelled_by_name` is joined from the canceller).
- **Archive & purge (admin "clear")**: done/verified/cancelled orders can be **soft-archived** (`archived_at`) — an "Archive all" button per terminal lane or `POST /work-orders/archive {status}` hides them from every list by default while keeping reliability data, cancellation audit, and history intact (undoable via `PATCH /work-orders/:id {archive:false}`). `GET /work-orders?archived=1` lists archived rows in the Done/Cancelled tabs ("Show archived" toggle, admin-only), where each can be **restored** or **permanently deleted** (`DELETE /work-orders/:id`, admin-only, requires archived terminal state; quotes cascade, permit/inventory links null). All archive/delete endpoints are admin-only (403 otherwise).
- **Phase 5 — GIS mapping (Leaflet)**: `properties` gain portable `latitude`/`longitude` NUMERIC columns so map pins work without PostGIS (the GEOGRAPHY `geom` column still exists and is kept in sync whenever coordinates change on a PostGIS install). `POST /properties` persists coordinates (validated ±90/±180), new `PATCH /properties/:id` (admin/manager) edits name/address/coordinates, `DELETE /properties/:id` (admin/manager) removes a site (buildings/floors/rooms cascade, assets stay unlinked, guarded with 400 while it still has open work orders), and `GET /properties` returns spatial aggregates: `buildings_count` and `open_work_orders` (counted across the whole asset hierarchy — site-level, building-level, and room-level assets). New `GET /properties/geocode?q=` proxies address→coordinates via Nominatim/OSM (cached, injectable for tests) with a 502 fallback to manual entry. The new **Map** screen (`Map.tsx`) renders an OpenStreetMap/Leaflet view with one marker per plotted property, coloured by open work order load, popups with site + workload details, jump-to list, "Zoom to all", and an edit-location modal (with "Locate address"). The new **Properties** screen (`Properties.tsx`) completes the Phase 1 CRUD promise — create/edit/delete sites with a type-your-address "Locate address" picker that fills the coordinates automatically. Demo coords are seeded for all three sites (Greatwall Gardens Estate, Acacia Court Syokimau, Denvic Corporate Centre).

### Concrete scope for the gap phases (8–14)

**Phase 8 — Closeout discipline**
- Schema: `failure_code` enum + `root_cause` / `remedy` on `work_orders`, required on the `done`/`verified` transition.
- Backend: closeout validation rejects vague entries ("fixed", "other") and captures a meter reading.
- Frontend: closeout modal on the board with controlled code pickers and a "replaced a part — reason + part + meter" prompt.

**Phase 9 — Inventory & procurement depth**
- Schema: min/max + reorder point on `inventory_items`; `purchase_orders` / `purchase_order_items`; price history; reservation + van-stock locations.
- Backend: `inventory_movements` write routes (in/out/transfer/reserve); automatic reorder recommendations.
- Frontend: Inventory screen + low-stock alerts on the dashboard.

*Shipped:* `inventory_items` gains `min_stock` / `max_stock` / `location_type` ('warehouse' | 'van'); `reservations` (active/released, netted out of availability and reorder checks, over-reservation rejected with the available count); `purchase_orders` / `purchase_order_items` with an org-unique `PO-<year>-<seq>` number and the full lifecycle — draft (line items add/remove) → submit → **admin/manager approve** (403 otherwise) → receive (stock incremented via one `inventory_movements` row per line, received price recorded) → cancelled/delete guards; `GET /api/inventory/reorder-recommendations` (items at/below reorder point net of reservations, suggested qty from max-stock or reorder point, last unit cost from received POs) and `GET /api/inventory/:id/price-history`; the Inventory screen gains reserved/available, min–max, van-stock badges, a reserve modal, a price-history modal, and a reorder panel with one-click draft PO creation; a new **Purchase orders** screen (`PurchaseOrders.tsx`) with status filters, create/edit-line-items, and contextual Submit/Approve/Receive/Cancel actions. Pure reorder math lives in `backend/src/reorder.js` (unit-tested).

**Phase 10 — Contractor portal**
- Schema: supplier↔user link for guest logins; `quotes`; SLA fields on `work_orders`; scorecard metrics.
- Backend: supplier-scoped JWT role; quote submit/compare; SLA clock; first-time-fix + recurrence scorecards.
- Frontend: separate supplier login shell — assigned jobs, quote submission, evidence upload.

**Phase 11 — Compliance & safety**
- Schema: `permits` (permit-to-work with issue/close/cancel lifecycle), `competencies` (expiry), statutory inspection schedules.
- Backend: `work_orders.requires_permit` flag + closeout gate (an order needing a permit can only be closed while one is issued); `/api/compliance` — summary, permit lifecycle, competency registry with computed `expired`, inspections that roll their due date on completion; `/api/users` roster.
- Frontend: Compliance screen (summary cards, permit queue with issue/close/cancel, competency expiry list, inspection schedule with mark-done) plus compliance summary on the dashboard.

**Phase 12 — Integrations & event bus**
- Backend: in-process event bus + outbox table → webhook delivery; CSV import/export; public data dictionary; adapter interface for M365 / Google Workspace / ERP / BMS. (Done — see the cross-cutting note above; the M365/G Workspace/ERP/BMS adapters ship as a registry with stubs ready for real providers.)
- Frontend: settings screen for webhooks and import/export. (Done — Integrations panel in Settings.)

**Phase 13 — Offline-first field mode** (Done)
- Schema: `sync_changes` outbox (BIGSERIAL cursor, org-scoped, insert/update/delete with tombstones) populated by `sync_record_change()` triggers on the main entity tables.
- Backend: `GET /api/sync/changes?since=&limit=` (cursor pagination, `has_more`) and `POST /api/sync/ops` (staff-only; work_order create/update, meter_reading create, inventory_movement create, asset update) reusing the online business rules (closeout discipline, permit gate, monotonic metering, trade vocabulary, atomic parts consumption) with last-write-wins conflicts resolved once per entity against the pre-batch server state — so a device's own ordered session (take → start work → close out) replays cleanly while a concurrent server edit still wins. Batch caps, per-op results, and `password_hash` scrubbing are covered by unit tests + e2e.
- Frontend (PWA): production-only service worker precaching the built shell (with `ignoreVary` so `Vary: Origin` assets match offline), network-first `/api` GET with cache fallback, offline index fallback; IndexedDB cache/queue/meta store; sync client (bootstrap lists, fold change stream incl. tombstones, write-ahead queue with optimistic cache updates, replay via `/sync/ops`); Field screen (jobs board, offline report/closeout/meter/stock modals, Sync now with applied/stale/rejected/pulled summary). Verified end-to-end in the browser: queue offline → reconnect → flush → server converges.

**Phase 14 — Condition-based maintenance**
- Backend: `metering.js` engine — `POST /assets/:id/readings` + bulk `POST /meter-readings` ingestion with monotonicity guard; threshold-crossing recommendations (`spawnMeterWorkOrder`) with JSON evidence payload in the description; `GET /meter-readings/alerts` (breached/near) and `GET /meter-readings/assets/:id/trend` (deltas, per-day rates, rate-spike anomalies, projected days-to-breach).
- Frontend: asset meter modal (record reading, live value, threshold alerts + projections, reading history with spike flags); dashboard meter-alerts panel.
- Scheduler: meter-based plans now reuse the shared engine (evidence payloads, no duplicate open recommendations, no meter reset).

### Where each Gaps1.txt recommendation stands today

| Gaps1.txt gap | Status in the build | Phase |
|---|---|---|
| 1 Frontline usability (role modes) | Partial — roles + RBAC exist; single shared UI | 4, 10, 13 |
| 2 Offline & poor-connectivity | Done (Phase 13) — PWA shell, change-stream sync, write-ahead offline ops with LWW, cached job board, offline evidence capture (photos/videos queued via `document.create` and replayed to work-order attachments) | 13 |
| 3 Complex multi-site operations | Partial — properties → buildings → floors → rooms + asset FKs; no portfolio/campus/system layers | 5 |
| 4 Reliability intelligence | Done (Phase 6) — repeat failures, bad actors, MTBF/MTTR, PM effectiveness + CSV report builder | 6 |
| 5 Data quality & closeout discipline | Done (Phase 8) — failure-code enum, vague-entry rejection, closeout modal, meter capture | 8 |
| 6 Inventory & procurement depth | Done (Phase 9) — min/max, reservations, van stock, full PO lifecycle (draft → approve → receive) with reorder recommendations + price history, screens | 9 |
| 7 Contractor & vendor performance | Done (Phase 10) — supplier portal, quotes, SLA, scorecards | 10 |
| 8 Building ops beyond maintenance | Done — document attachments (work-order photos/PDFs via a pluggable object-storage layer) + supplier contracts (CRUD, renewal-window alerts, spend tracking) | 4, 3 |
| 9 Reporting & customization economics | Partial — live snapshot dashboard + CSV export (Phase 6) | 6, 12 |
| 10 Integrations & operational data | Partial — documented API, in-app notification feed (Phase 7), CSV export (Phase 6) | 12 |
| 11 Preventive-to-predictive | Done (Phase 14) — meter ingestion, thresholds, trend + anomaly detection, evidence-backed WO recommendations | 14 |
| 12 Governance, compliance & safety | Partial — permits, competency expiry, statutory inspections, closeout gate (Phase 11) | 11 |

The Gaps1 "highest-value wedge" — *an offline-first facility maintenance
operating system that turns every job into structured reliability data and
automatically coordinates staff, contractors, inventory, compliance, and
building systems* — is the combined target of Phases 13 (offline), 8
(structured reliability data), 10 (contractor coordination), 12 (open
platform), and 14 (building systems).

## Suggested next steps

Phases 6 (reliability + report builder), 7 (notifications), 9 (inventory &
procurement — purchase orders, reservations, reorder recommendations, price
history), 10 (contractor portal), 11 (compliance & safety, incl. a dedicated compliance
screen — permit queue, competency expiry, inspection schedule), 12
(integrations & event bus), and 14 (condition-based maintenance — meter
ingestion, thresholds, trend + anomaly detection, evidence-backed
recommendations) are shipped and verified against
a real local PostgreSQL: `npm run seed` loads a Kenyan demo workspace and
`npm run e2e` passes 241/241 checks (backend unit tests: 62/62). Also shipped:
runtime-configurable trades &
asset types (Settings screen), staff management with remove/restore/permanent
delete (Team screen, `POST /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id`),
the Phase 12 integrations & event bus (webhooks, CSV import/export, data
dictionary, connector registry), a Phase 4 resident portal (tenant login,
one-minute request reporting with AI triage suggestions, QR/NFC tag scan,
photo/video/voice-note evidence, and device location — demo `fred.muka@gmail.com`),
work-order cancellation discipline (two tiers: admins/managers cancel any
in-flight order, reason-required, audited with cancelled_by/at/reason, terminal
state, board tabs; a tenant may only **withdraw** their own request while it is
still `open`, reason-required and staff-notified via a `work_order_withdrawn`
notification, from the resident portal),
an admin archive & purge flow (soft "Archive all" per lane + show-archived
toggle with restore / permanent delete),
a completed Phase 2 preventive-maintenance scheduler (plan create/edit/pause/
resume/delete, on-demand "Run now" per plan, bulk due-run, daily 02:00 cron,
a no-pile-up guard so an in-flight plan never re-spawns, plan-sourced work
orders, and next-due + open-job columns in the plans screen),
a completed Phase 5 GIS mapping UI (Leaflet + OpenStreetMap map screen,
markers coloured by open work order load with site popups, jump-to and
edit-location for admins/managers, portable lat/lng columns that work with or
without PostGIS plus spatial aggregates),
and a cross-browser calendar picker for all date fields. **Document attachments**
(Phase 8 "building ops"): a pluggable object-storage layer (`backend/src/lib/storage.js`)
— local disk by default, S3/MinIO via `STORAGE_DRIVER=s3` (auto-selected when
`MINIO_ENDPOINT`/`S3_*` is set; the compose stack already wires MinIO in) — with
org-scoped, unguessable keys (`<orgId>.<uuid><ext>`) so cross-tenant file reads
are impossible. `POST /api/documents` (multipart, 20MB cap, entity-ownership
validated against assets/work_orders/properties), `GET /api/documents?entity_type&entity_id`,
`DELETE /api/documents/:id` (removes the stored object too), and an
authenticated `GET /api/files/:key` stream (org prefix gate → 404 for anyone
else). Work orders gain a paperclip button opening an **Attachments** modal
(upload, image thumbnails via authenticated blob URLs, download, delete,
uploader + date). **Offline evidence capture** (Phase 13 extension): the Field
screen's job cards gain an **Evidence** button that captures a photo or video
(`capture="environment"`) even while disconnected, queues a `document.create`
op (base64 payload, same 20MB cap and entity-ownership rules as the online
upload — shared via `backend/src/lib/attachments.js`) into the IndexedDB
queue, badges the job with how many files are still pending, and replays them
as work-order attachments the next time the device syncs (JSON body limit
raised to 35MB to carry them). Same-session remap: evidence can reference the
temp client id of a work order created earlier in the same offline batch —
the server rewrites it to the real id (per-org dedupe index) so the photo is
attached exactly where the tech shot it, even before a pull round-trip.
Conflicts (stale-skip) surface in a Field banner + review modal with keep-mine
(requeues a fresh edit) / accept-server (drops) actions, and the queue flushes
through the service worker's Background Sync API when the app is closed,
a complete Phase 3 supplier-contracts module (CRUD with `CTR-<year>-<seq>`
numbering, derived expiry status within a renewal-notice window, spend roll-up
from linked purchase orders with over-budget flags, expiry notifications +
`contract.expiring`/`contract.expired` events, a terminal terminate guard, a
dedicated Contracts screen, and a dashboard renewal-window alert), and
compliance-permit evidence (`POST /api/compliance/permits/:id/evidence`,
multipart, same object-storage layer, viewable from the Compliance screen).
Contractors can attach quote breakdowns / site photos straight from the
SupplierPortal quote modal (`POST /api/documents`, work-order-scoped, so staff
see them in the job's Attachments modal).
Four Fixflo-inspired facilities workflow upgrades:

1. **Contractor auto-assignment** — `PATCH /api/config/auto-assign` + a Settings
   toggle (admin/manager) turns on auto-routing: urgent/high breakdowns land
   with the least-loaded supplier of that trade (`assigned_supplier_id`,
   `status='assigned'`, `auto_assigned=true`), the supplier's team is notified,
   and board cards show an amber "Auto-assigned" chip. Off by default so the
   e2e suite (which provisions its own orgs) is unaffected; the demo seed turns
   it on.
2. **Customisable KPI dashboards** — per-user panel layout persisted to
   `users.dashboard_prefs` (`GET`/`PUT /api/users/me/prefs`); the Dashboard
   screen's Customize card toggles which KPI panels render and their order, and
   only visible panels hit the network.
3. **Invoice-on-completion** — closing a work order auto-drafts an invoice
   (`INV-<year>-<seq>`, `invoices` table) netting consumed parts (valued at the
   last received PO unit cost) against the accepted contractor quote; replays
   never double-bill, and offline-sync closeouts generate too. `GET
   /api/invoices` (supplier-scoped for contractors, tenant-scoped for
   residents) + `PATCH /api/invoices/:id` to progress draft → issued → paid (or
   void); an Invoices screen shows outstanding vs collected totals with
   one-click transitions.
4. **Picture-first resident reporting** — the report form leads with a photo: a
   large camera tile + thumbnail grid capture evidence up front (video and
   voice notes stay secondary), so triage and job scoping start from what the
   resident sees. The resident portal and contractor portal have their own demo
   logins (`fred.muka@gmail.com`, `alex.muthoka@gmail.com`, `joseph.muriuki@gmail.com`,
   all `facilix-demo`).
5. **Role-scoped work-order visibility** — staff only see (and can act on) what
   concerns them. **Technicians** see and work only the orders assigned to them —
   on the online board, the offline field board, and every mutation (online and
   replayed), and they cannot reassign anything. **Managers** keep operational
   powers across the whole portfolio (assign, route suppliers, close, cancel
   with reason). **Admins** hold the overall powers — Eric Newborn is the
   overall admin for the demo — including archiving, permanent delete, org
   configuration (trades, asset types, auto-assign), and user management.
   Tenants and suppliers were already scoped to their own requests/jobs.

Remaining high-value work:

1. Point a deployment at real MinIO (already wired in `docker-compose.yml`; enable in `.env` via `STORAGE_DRIVER=s3` / `S3_*` or the `MINIO_*` vars).
