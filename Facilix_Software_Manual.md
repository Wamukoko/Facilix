# Facilix — Software Manual

**Version:** 1.0 · **Release date:** August 2026 · **Build:** Phase 14 (Condition-Based Maintenance)

---

## Table of Contents

1. [Front Matter](#1-front-matter)
2. [Introduction](#2-introduction)
3. [Getting Started](#3-getting-started)
4. [Interface Overview](#4-interface-overview)
5. [Core Functionality](#5-core-functionality)
6. [Advanced Usage](#6-advanced-usage)
7. [Administration](#7-administration)
8. [Troubleshooting](#8-troubleshooting)
9. [FAQ](#9-faq)
10. [Support & Resources](#10-support--resources)
11. [Reference Appendices](#11-reference-appendices)

---

## 1. Front Matter

### Product Identity

| Field | Value |
|---|---|
| Product name | **Facilix** |
| Version | 1.0 |
| Release date | August 2026 |
| Type | Self-hosted property & facility maintenance platform |
| Stack | Node.js / Express backend, React / TypeScript frontend, PostgreSQL 15+ database |
| License | Proprietary (internal use) |

### Revision History

| Version | Date | Changes |
|---|---|---|
| 0.1 | Jul 2026 | Phases 1–7: Auth, RBAC, property/asset CRUD, maintenance plans, supplier contracts, tenant portal, GIS mapping, dashboards, notifications |
| 0.2 | Jul 2026 | Phases 8–12: Closeout discipline, inventory/procurement, contractor portal, compliance & safety, integrations & event bus |
| 0.3 | Aug 2026 | Phase 13: Offline-first field mode (PWA, sync, conflict resolution) |
| 1.0 | Aug 2026 | Phase 14: Condition-based maintenance (meter ingestion, thresholds, anomaly detection); Fixflo-inspired upgrades (auto-assign, KPI dashboards, invoices, picture-first reporting, role-scoped visibility) |

### Copyright

Facilix is proprietary software. This manual is for internal reference only. All rights reserved.

---

## 2. Introduction

### Purpose of This Document

This manual is written for **Facilix end-users** (property managers, maintenance technicians, administrators, tenants, and contractors) and **system administrators** responsible for deployment and configuration. It covers every screen, workflow, and administrative function in the application.

Use this manual as a reference — you can jump directly to the section you need via the Table of Contents, or read progressively from Getting Started if you are new to the platform.

### Product Overview

Facilix is a self-hosted, offline-capable facility maintenance platform built for property management companies in East Africa. It manages the full lifecycle of building maintenance — from asset inventory and preventive maintenance schedules, through work-order assignment and closeout, to supplier management, procurement, compliance, and condition-based monitoring.

The platform is designed around **Kenyan operational realities**: multi-currency (KES), frequent power outages (borehole pumps, backup generators), contractor portal access, and a mobile-first field workforce that needs offline capability in areas with poor connectivity.

### Key Features Summary

| Feature Area | Highlights |
|---|---|
| **Property & Asset Management** | Hierarchical property → building → floor → room structure; asset inventory with trade-specific attributes; GIS map view (Leaflet) with address lookup |
| **Work-Order Lifecycle** | Status tracking (open → assigned → in_progress → done → verified → cancelled); role-scoped visibility; auto-assignment; SLA tracking; closeout discipline with failure codes and root-cause analysis |
| **Preventive Maintenance** | Scheduled (time-based) and meter-based plans; daily cron scheduler with pile-up prevention; on-demand "Run Now" |
| **Condition-Based Maintenance** | Meter reading ingestion with monotonicity guard; threshold-crossing alerts; trend and anomaly detection; projected breach dates |
| **Inventory & Procurement** | Min/max stock levels, reservations, van stock, low-stock alerts; purchase orders with draft → approve → receive lifecycle; reorder recommendations with one-click PO creation; price history |
| **Supplier & Contractor Management** | Supplier portal with role-scoped access; quote submission and comparison; SLA clock and scorecards; auto-assignment to least-loaded supplier of the correct trade |
| **Contracts** | Contract lifecycle with CTR-`<year>`-`<seq>` numbering; expiry tracking with configurable renewal-notice window; spend roll-up from linked purchase orders with over-budget flags |
| **Compliance & Safety** | Permit-to-work lifecycle (draft → issued → closed/cancelled); competency registry with expiry tracking; statutory inspection scheduling; closeout gate (orders requiring a permit cannot be closed without an issued, unexpired permit) |
| **Tenant Self-Service** | Dedicated resident portal; one-minute problem reporting with AI triage; photo/video/voice evidence capture; device GPS pin; QR/NFC site-tag scan; request tracking and withdrawal |
| **Dashboards & Reporting** | Customisable KPI panels (show/hide, reorder); MTBF/MTTR, repeat failures, PM effectiveness; CSV report builder |
| **Offline-First Field Mode** | Progressive Web App with service worker; IndexedDB cache; change-stream sync with LWW conflict resolution; offline report, closeout, meter reading, parts consumption, and evidence capture |
| **Integrations & Event Bus** | Outbox-based event bus with HMAC-signed webhook delivery; CSV import/export; connector registry (M365, Google Workspace, ERP, BMS) |
| **Invoicing** | Auto-drafted on work-order closeout (INV-`<year>`-`<seq>`); draft → issued → paid/void lifecycle; supplier and tenant scoped views |
| **Notifications** | In-app notification feed wired into the full work-order and contract lifecycle; email/SMS stubs ready for provider integration |

### System Requirements

**Minimum hardware:**

| Component | Requirement |
|---|---|
| Database server | 1 CPU core, 1 GB RAM (PostgreSQL 15+) |
| API server | 1 CPU core, 512 MB RAM (Node.js 18+) |
| Web server | 1 CPU core, 256 MB RAM (nginx, serves the SPA) |
| Storage | 2 GB minimum (grows with document uploads) |

**For Docker deployment (recommended):**

| Requirement | Detail |
|---|---|
| Docker | 20.10+ |
| Docker Compose | v2+ |
| Available ports | 80/443 (reverse proxy), 5432 (DB, internal only) |

**Browser support:**

| Browser | Minimum version |
|---|---|
| Chrome (Android / desktop) | 90+ |
| Safari (iOS / macOS) | 15+ |
| Firefox | 90+ |
| Edge | 90+ |

> **Offline mode** requires a browser supporting Service Workers and IndexedDB (Chrome, Edge, Firefox, Safari 15+).

**Software dependencies (for local development):**

- Node.js 18+
- PostgreSQL 15+ (with or without PostGIS)
- npm 9+

### Conventions Used in This Manual

| Convention | Meaning |
|---|---|
| **Bold** | UI element names, screen titles, button labels |
| `Code font` | API endpoints, database fields, commands, file paths |
| > Blockquote | Tip, best practice, or important note |
| ⚠ Warning | Action that may cause data loss or requires caution |
| *Italic* | Emphasis or first-time terminology introduction |

---

## 3. Getting Started

### Installation — Local Development

Facilix uses a three-tier architecture: PostgreSQL database, Node.js API server, and a React single-page application (SPA). For local development, run each tier separately.

#### Step 1: Set Up the Database

**Option A — Docker (easiest):**

```bash
docker run --name facilix-db \
  -e POSTGRES_PASSWORD=facilix_password \
  -e POSTGRES_USER=facilix_user \
  -e POSTGRES_DB=facilix \
  -p 5432:5432 -d postgis/postgis:15-3.4
```

**Option B — Local PostgreSQL:**

Install PostgreSQL 15+ directly, then create the database:

```bash
psql -U postgres -c "CREATE USER facilix_user WITH PASSWORD 'facilix_password';"
psql -U postgres -c "CREATE DATABASE facilix OWNER facilix_user;"
psql -U postgres -d facilix -c "CREATE EXTENSION IF NOT EXISTS postgis;"
```

#### Step 2: Load the Schema

```bash
psql postgres://facilix_user:facilix_password@localhost:5432/facilix -f db/schema.sql
```

#### Step 3: Install and Configure the Backend

```bash
cd backend
npm install
cp .env.example .env    # edit DATABASE_URL and set a strong JWT_SECRET
```

The `.env` file controls database connectivity and security:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://facilix_user:facilix_password@localhost:5432/facilix` | PostgreSQL connection string |
| `JWT_SECRET` | `change-me-in-production` | Secret for signing JWTs (must be changed for production) |

> The API **refuses to boot** if `JWT_SECRET` is left as the default in production mode.

#### Step 4: Start the API Server

```bash
npm run dev
```

The API is now live at `http://localhost:4000`. Verify with:

```
GET http://localhost:4000/health
# → { "status": "ok" }
```

#### Step 5: Install and Start the Frontend

```bash
cd ../frontend
npm install
npm run dev
```

The app is now accessible at `http://localhost:5173`. The dev server proxies all `/api` requests to the backend on port 4000.

#### Step 6 (Optional): Load Demo Data

```bash
cd ../backend
npm run seed
```

This wipes the database and rebuilds a complete demo workspace — **Denvic Property Managers** — with 3 properties, 10 work orders, 18 users across all roles, suppliers, maintenance plans, contracts, POs, invoices, compliance records, and more. All demo logins use password `facilix-demo`.

See [Appendix A: Demo Logins](#appendix-a-demo-logins) for the full list.

### Installation — Production (Docker)

```bash
# From the repo root:
cp .env.example .env       # set real secrets
docker compose up -d --build
```

The Docker Compose stack brings up four services:

| Service | Port | Role |
|---|---|---|
| `db` | 5432 (internal) | PostgreSQL + PostGIS |
| `api` | 4000 (internal) | Express API |
| `web` | 80 | nginx SPA + API proxy |
| `minio` | 9000 (internal) | Object storage for documents |

The frontend nginx container also reverse-proxies `/api/` to the API service, so the entire application is served from a single origin in production. The schema loads automatically on first database creation.

> **Do not expose the database port** to the host in production. The compose file binds it to `127.0.0.1` by default.

### Licensing / Account Setup

Facilix uses self-hosted authentication — there is no external licence server. On first launch, use **"Create workspace"** on the login screen to create an organisation and its first admin account. Subsequent users are added by administrators via the **Team** screen.

### Quick Start Guide

1. **Log in** as the admin: `eric.newborn@denvic.co.ke` / `facilix-demo` (if demo data is loaded).
2. **Explore the Dashboard** — review the KPI panels showing open work orders, overdue SLAs, low-stock alerts, and contract renewals.
3. **Open the Work Orders board** — filter by status tab or trade; drag a card forward to advance it through the lifecycle.
4. **Open the Map screen** — see your properties plotted on an interactive map with workload-coloured markers.
5. **Switch to the Resident Portal** (log in as `fred.muka@gmail.com`) — submit a test maintenance request with a photo.
6. **Return as admin** — see the new request appear on the board, assign it, and advance it through to closeout.

---

## 4. Interface Overview

### Navigation Layout

Facilix uses a **tabbed application shell** (`AppShell.tsx`). The main navigation is a horizontal tab bar at the top (or bottom on mobile). The available tabs depend on your role:

| Tab | Roles That See It | Description |
|---|---|---|
| **Dashboard** | admin, manager, technician | KPI panels (customisable), alerts, trends |
| **Work Orders** | admin, manager, technician | Kanban-style board with status tabs |
| **Assets** | admin, manager, technician | Asset inventory with filters and detail modals |
| **Plans** | admin, manager | Maintenance plan management and scheduler |
| **Inventory** | admin, manager, technician | Stock levels, movements, reorder alerts |
| **Purchase Orders** | admin, manager | PO lifecycle (draft → approve → receive) |
| **Contracts** | admin, manager | Supplier contract management and renewal tracking |
| **Invoices** | admin, manager | Auto-drafted invoices, payment tracking |
| **Compliance** | admin, manager, technician | Permits, competencies, statutory inspections |
| **Team** | admin, manager | User roster, role management |
| **Settings** | admin, manager | Trades, asset types, auto-assign, webhooks, integrations |
| **Map** | admin, manager, technician | Leaflet map with property markers |
| **Field** | admin, manager, technician | Offline-first jobs board for mobile workers |

**Role-specific portals** have their own login shells:

| Portal | Login Role | Description |
|---|---|---|
| **Resident Portal** | tenant | Report problems, track own requests, withdraw requests |
| **Contractor Portal** | supplier | View assigned jobs, submit quotes, upload evidence, close out work |

### Key Terminology

| Term | Definition |
|---|---|
| **Property** | A site or building complex (e.g. "Greatwall Gardens Estate") |
| **Building** | A structure within a property (e.g. "Phase 1 · Block A") |
| **Floor** | A level within a building |
| **Room** | A unit, utility room, common area, or retail space on a floor |
| **Asset** | A tracked piece of equipment (borehole pump, generator, solar array, etc.) |
| **Work Order (WO)** | A maintenance task — the central entity in Facilix |
| **Maintenance Plan** | A recurring rule (scheduled or meter-based) that auto-generates work orders |
| **Supplier** | A trade company or in-house crew that performs maintenance work |
| **Contract** | A formal agreement with a supplier, tracking value, spend, and renewal dates |
| **Permit** | A permit-to-work required before certain hazardous work can be closed |
| **Competency** | A certification or qualification held by a staff member |
| **Statutory Inspection** | A legally required inspection on an asset (e.g. annual generator inspection) |
| **Invoice** | A financial record auto-drafted when a work order is closed |
| **Purchase Order (PO)** | A procurement record for buying inventory from a supplier |
| **Reservation** | A hold on inventory items (netted from available stock) |
| **Trade** | A work category — plumbing, electrical, gardening, janitorial, solar, etc. |

---

## 5. Core Functionality

### 5.1 Authentication & Workspaces

#### Creating a Workspace

1. Open the login screen at `http://localhost:5173` (or your production URL).
2. Click **"Create workspace"**.
3. Enter your **Organisation name**, **Full name**, **Email**, **Password** (min 8 characters), and optionally your **Phone** number.
4. Click **Sign up**.
5. You are logged in as **Admin** of your new organisation.

> The first user of every organisation is always an admin. Default trades and asset types are seeded automatically.

#### Logging In

1. Enter your **Email** and **Password** on the login screen.
2. Click **Log in**.
3. You are redirected to the screen matching your role:
   - Admin/Manager/Technician → the main application (Dashboard)
   - Tenant → Resident Portal
   - Supplier → Contractor Portal

#### Session Management

- JWTs are valid for **7 days**.
- The token is stored in both memory and `localStorage`.
- Logging out clears the stored token.
- Closing the browser preserves the session; reopening resumes it automatically.

---

### 5.2 Dashboard

The Dashboard is your operational overview. It shows a grid of **KPI panels** — small cards that each visualise one aspect of your facility operations.

#### Default Panels

| Panel | Content |
|---|---|
| **Open Work Orders** | Count and breakdown by status (open, assigned, in_progress) |
| **Overdue SLAs** | Work orders whose SLA due date has passed |
| **Completion Rate** | Done/verified as a percentage of all active orders |
| **MTBF / MTTR** | Mean time between failures and mean time to repair |
| **PM Effectiveness** | Percentage of preventive maintenance completed on time |
| **Low-Stock Alerts** | Inventory items at or below their reorder threshold |
| **Contract Renewals** | Contracts approaching their renewal window or already expired |
| **Meter Alerts** | Assets with threshold breaches or projected breaches |
| **Recent Notifications** | Latest in-app notification feed entries |
| **Unpaid Invoices** | Outstanding draft or issued invoices |

#### Customising the Dashboard

1. Click the **Customize** button on the Dashboard.
2. A panel list appears showing all available panels with toggle switches.
3. Toggle each panel **on/off** to show or hide it.
4. Drag panels to reorder them.
5. Changes are saved to your user preferences immediately — only visible panels are fetched, saving bandwidth.

> Each user's layout is independent. A technician may prefer a simpler view; an admin may want every panel visible.

---

### 5.3 Work Orders

The **Work Orders** screen is the operational heart of Facilix. It displays work orders on a kanban-style board with **status tabs** across the top.

#### Board Tabs

| Tab | Shows |
|---|---|
| **All** | Every non-archived work order matching your role scope |
| **Open** | Not yet assigned to anyone |
| **Assigned** | Assigned to a technician or supplier, work not started |
| **In Progress** | Technician has started working |
| **Done** | Work completed, awaiting admin verification |
| **Verified** | Admin-confirmed closeout |
| **Cancelled** | Withdrawn or cancelled (shows reason, canceller, and date) |

> **Technicians** see only work orders assigned to them across every tab. **Tenants** see only their own requests. **Suppliers** see jobs assigned to their company plus open jobs for bidding.

#### Creating a Work Order

1. Click **New Work Order** (top-right).
2. Fill in:
   - **Trade** (required) — plumbing, electrical, gardening, janitorial, etc.
   - **Title** (required) — short description of the problem.
   - **Description** (optional) — detailed notes.
   - **Priority** — urgent, high, normal (default), or low.
   - **Source** — breakdown (default), plan (auto-generated), or tenant_request.
   - **Asset** (optional) — link to a tracked asset.
   - **Room** (optional) — link to a specific location.
   - **Requires Permit** — toggle on if the work needs a permit-to-work before closeout.
3. Click **Create**.

> If the organisation has **auto-assign** enabled and the priority is urgent or high, the work order is automatically routed to the least-loaded supplier of the correct trade (status becomes "assigned" immediately, and the supplier is notified).

#### Advancing a Work Order

Progress a work order by changing its status. The allowed transitions are:

```
open → assigned → in_progress → done → verified
                   ↘ cancelled
         ↘ cancelled
open ↘ cancelled (tenant withdrawal)
```

**To assign:**
1. Open the work order detail.
2. Set **Assigned Technician** and/or **Assigned Supplier**.
3. Save — status moves to `assigned` and the assignee is notified.

**To start work:**
1. On the board, move the card to the **In Progress** column (or update status in the detail).
2. The SLA clock is ticking.

**To close out:**
1. Move the card to **Done** (or click "Complete").
2. The **Closeout Modal** opens — you must fill in:
   - **Failure Code** (required) — select from the standardised list (see [Appendix B: Failure Codes](#appendix-b-failure-codes)).
   - **Root Cause** (required) — at least 10 characters; vague answers like "fixed" or "other" are rejected.
   - **Remedy** (required) — at least 10 characters.
   - **Parts Used** (optional) — free-text summary.
   - **Meter Reading** (optional) — capture the asset's meter value at closeout.
   - **Parts Consumed** (optional) — select structured parts from inventory (decrements stock automatically).
3. If the work order requires a **permit**, the system checks for an issued, unexpired permit. Without one, closeout is blocked.
4. Submit — the work order moves to `done`, an invoice is auto-drafted, and the reporter is notified.

**To verify:** An admin moves `done` → `verified`, confirming the closeout is satisfactory.

#### Cancelling a Work Order

Cancellation follows a **two-tier** model:

- **Admins and managers** can cancel any in-flight order (`open`, `assigned`, or `in_progress`). A **reason** is required (minimum 5 characters, vague answers rejected). The reporter is notified.
- **Tenants** can only **withdraw** their own request while it is still `open` (unassigned). A reason is required. Staff are notified via a `work_order_withdrawn` notification.

Cancelled orders are **terminal** — they cannot be re-opened or re-advanced.

#### Archiving & Purging (Admin Only)

Done, verified, and cancelled orders accumulate on the board. Admins can clean up:

1. **Archive all** — click the archive button in a terminal tab's header (or `POST /api/work-orders/archive`). This soft-archives all matching orders (`archived_at` is set). They disappear from every default view but all data is preserved.
2. **Show archived** — toggle to view archived rows (admin only).
3. **Restore** — un-archive an individual order.
4. **Permanently delete** — only available for archived, terminal orders. Quotes cascade; permit and inventory links are nulled. **This action is irreversible.**

#### Role-Scoped Visibility

Every staff member sees only the work orders relevant to their scope:

| Role | Visible Work Orders | Mutation Powers |
|---|---|---|
| **Admin** | All | Full: create, assign, reassign, advance, close, cancel, archive, delete, config |
| **Manager** | All | Operational: create, assign, reassign, advance, close, cancel with reason |
| **Technician** | Only assigned to them | Own jobs only: advance, close out with closeout data, add parts, meter readings. Cannot reassign or cancel. |
| **Tenant** | Own `tenant_request` only | Withdraw (cancel) own open requests only |
| **Supplier** | Assigned to their company + open for bidding | Submit quotes, advance own assigned jobs, close out |

#### Offline Field Board

The **Field** screen is an offline-first version of the work-order board for mobile technicians. It:

- **Bootstraps** from the server when online, caching jobs in IndexedDB.
- **Queues** mutations (report, closeout, meter reading, parts consumption, evidence capture) locally when offline.
- **Replays** queued operations via `POST /api/sync/ops` when connectivity returns, using last-write-wins conflict resolution.
- **Pulls** incremental changes from the server via cursor-based pagination.
- Shows a **Sync** button with a summary of applied, stale, rejected, and pulled items.
- Technicians see only their assigned work orders in both the cached list and the change-stream feed.

**Offline evidence capture:** From a job card in the Field screen, you can capture photos or videos even while disconnected. They are queued and uploaded as work-order attachments when the device reconnects.

---

### 5.4 Asset Management

The **Assets** screen lists all tracked equipment across your properties.

#### Creating an Asset

1. Click **Add Asset**.
2. Fill in:
   - **Name** (required) — e.g. "Borehole pump BP-1".
   - **Type** (required) — from your configured trades/asset types (plumbing, electrical, hvac, solar, etc.).
   - **Property / Building / Room** — hierarchical location assignment.
   - **Install date** and **Warranty end** (optional).
   - **Meter value** and **meter unit** (optional) — for condition-based maintenance.
   - **Attributes** (JSONB) — trade-specific fields (e.g. `capacity_lpm: 300` for plumbing, `kva: 750` for generators).
3. Click **Save**.

#### Meter Readings

For assets with meter values:

1. Open the asset detail.
2. Click **Record Reading**.
3. Enter the current meter value (must be ≥ the previous reading — monotonicity enforced).
4. The system checks for threshold crossings and generates alerts or maintenance recommendations if triggered.

See [Section 5.11: Condition-Based Maintenance](#511-condition-based-maintenance) for details.

#### Asset Statuses

| Status | Meaning |
|---|---|
| `active` | Normal operation (default) |
| `under_repair` | Currently being repaired |
| `decommissioned` | No longer in service |

---

### 5.5 Properties & Mapping

#### Properties Screen

Manage your portfolio of sites:

1. **Create** — enter name, address, and optionally use **Locate address** to auto-fill GPS coordinates via Nominatim.
2. **Edit** — update name, address, or coordinates.
3. **Delete** — cascades to buildings, floors, and rooms. Blocked with a 400 error if the property still has open work orders.

The properties list shows **buildings count** and **open work orders** per site.

#### Map Screen

An interactive Leaflet map with:

- One marker per property, **colour-coded** by open work order load (green = none, orange = moderate, red = heavy).
- **Popups** with property name, address, building count, and open work order count.
- **Jump-to list** — click a property name to zoom to it.
- **Zoom to all** — fit all properties in view.
- **Edit location** (admin/manager) — move a property's pin or use the address locator.

---

### 5.6 Preventive Maintenance

#### Creating a Plan

1. Navigate to the **Plans** screen.
2. Click **New Plan**.
3. Fill in:
   - **Name** — e.g. "Borehole pump quarterly service".
   - **Trade** — plumbing, electrical, etc.
   - **Trigger type:**
     - **Scheduled** — time-based; enter the frequency in days (e.g. 90 for quarterly).
     - **Meter-based** — condition-based; select an asset and enter a threshold (e.g. 50,000 hours).
   - **Checklist** — numbered steps for the technician to follow.
   - **Default supplier** (optional) — auto-assigned to the spawned work order.
4. Click **Save**.

#### How the Scheduler Works

A daily cron job (02:00) runs three passes:

1. **Scheduled plans:** Finds all active plans where the frequency interval has elapsed since the last run, or where no run has occurred yet. For each due plan, spawns a work order for each target asset (all assets matching the plan's asset type, or a single specified asset).

2. **Meter-based plans:** Finds assets where the current meter value meets or exceeds the plan's threshold. Spawns a work order with an evidence payload.

3. **Contract expiry check:** Scans contracts and fires notifications for those entering or passing their renewal window.

**Pile-up prevention:** Before spawning, the scheduler checks whether a work order for the same plan + asset combination already exists in `open`, `assigned`, or `in_progress`. If so, it skips that asset — preventing duplicate work orders.

#### On-Demand Execution

- **Run now** — click the play button next to any plan to execute it immediately.
- **Run all due** — bulk-execute every plan that is currently due.

---

### 5.7 Inventory & Procurement

#### Inventory Management

The **Inventory** screen tracks spare parts and consumables.

**Item details:**
- **Name**, **Trade** (plumbing, electrical, etc.), **Unit** (pcs, litres, metres, etc.).
- **Quantity on hand** — current stock level.
- **Reorder threshold** — when stock falls to this level, a low-stock alert fires.
- **Min/Max stock** — used for reorder recommendations.
- **Location type** — `warehouse` (central store) or `van` (technician's vehicle).
- **Warehouse location** — physical description (e.g. "Rack 1, Greatwall store").

**Movements:** Every stock change (receive, consume, transfer, reserve) is recorded as an `inventory_movement` row, providing a full audit trail.

**Reservations:** Stock can be reserved for a specific work order, reducing available quantity without physically moving the item. Reservations are released on closeout or manually.

**Low-Stock Alerts:** Dashboard panel shows items at or below the reorder threshold. The Inventory screen highlights them in red.

#### Reorder Recommendations

Navigate to **Inventory → Reorder** to see items at or below the reorder threshold. Each recommendation shows:

- Suggested quantity (based on max stock level or a configurable default).
- Last unit cost from a received purchase order.
- **Draft PO** button — creates a purchase order with the recommended quantity in one click.

#### Purchase Orders

The **Purchase Orders** screen manages procurement:

**Lifecycle:**

```
draft → submitted → approved → received → (completed)
         ↘ cancelled
```

1. **Draft** — create a PO, add line items (inventory item, quantity, unit price).
2. **Submit** — locks the PO for review.
3. **Approve** (admin/manager only) — authorises the purchase.
4. **Receive** — stock is incremented for each line item; unit price is recorded for price history.
5. **Cancel** — voids the PO before receiving.

Each PO gets an org-unique number: `PO-<year>-<seq>` (e.g. `PO-2026-0001`).

**Linking to Contracts:** A PO can be attached to a supplier contract. The contract's spend roll-up includes linked PO amounts, and an over-budget flag triggers when committed spend exceeds the contract's annual value.

---

### 5.8 Supplier & Contractor Management

#### Supplier Directory

The **Settings** screen (or supplier route) manages your supplier list:

| Field | Description |
|---|---|
| **Name** | Company or crew name (e.g. "Athi Power Electricals") |
| **Trade** | Primary trade (plumbing, electrical, gardening, janitorial) |
| **Contact name** | Primary contact person |
| **Contact email** | Used for the contractor portal login |
| **Contact phone** | Phone number |
| **In-house** | Flag for internal crews vs. external subcontractors |

#### Contractor Portal

Suppliers log in to a dedicated portal (`/supplier`) with their email and the shared password. From there they can:

1. **View assigned jobs** — work orders assigned to their company.
2. **Submit quotes** — enter amount, currency (KES), and notes. Attach supporting documents (site photos, breakdowns).
3. **Close out work** — advance job status and capture closeout details.
4. **View scorecard** — total quotes, acceptance rate, average completion time.

**Quote comparison:** When multiple quotes are submitted for a job, admin/managers can compare them side-by-side and accept one. Accepting assigns the supplier to the work order.

#### Auto-Assignment

When **auto-assign** is enabled (Settings → toggle, admin only):

- New urgent/high-priority breakdowns are automatically routed to the **least-loaded supplier** of the correct trade.
- Status is set to `assigned` immediately, and the supplier is notified.
- Board cards show an **amber "Auto-assigned" chip**.
- Normal and low-priority work still enters the `open` state for manual routing.

---

### 5.9 Supplier Contracts

The **Contracts** screen manages formal agreements with suppliers.

#### Creating a Contract

1. Click **New Contract**.
2. Fill in:
   - **Supplier** — select from the supplier directory.
   - **Contract type** — `utility`, `rental`, `sale`, or `service`.
   - **Status** — `active`, `expiring`, `expired`, or `terminated` (latter two are terminal; status is derived from dates).
   - **Start date** and **End date**.
   - **Annual value** (KES) — the budget for the contract year.
   - **Renewal notice days** — how many days before end to trigger renewal alerts (e.g. 30).
   - **Notes** (optional).
3. Click **Save**.

Each contract gets a unique number: `CTR-<year>-<seq>` (e.g. `CTR-2026-0001`).

#### Contract Lifecycle

- **Active** — the contract is current.
- **Expiring** — the end date is within the renewal-notice window. Admins/managers receive a `contract_expiring` notification.
- **Expired** — the end date has passed. A `contract_expired` notification fires.
- **Terminated** — manually ended by an admin. **Terminal** — cannot be edited or re-terminated.

#### Spend Tracking

The contract detail shows a table of **linked purchase orders** (POs attached to this contract). The total committed spend is compared against the annual value, and an **over-budget flag** appears when spend exceeds the budget.

---

### 5.10 Compliance & Safety

The **Compliance** screen provides a summary of safety and regulatory compliance across your organisation.

#### Permit-to-Work

For hazardous jobs (roof work, electrical isolation, hot work, confined spaces, LOTO):

1. A work order can be flagged as **"Requires permit"** on creation.
2. An admin/manager issues a permit via the Compliance screen:
   - Select the **Permit type** (working at height, hot work, electrical isolation, confined space, LOTO, other).
   - Enter the **Issued by** name and **Expiry date**.
   - Attach supporting evidence (safety photos, method statements).
3. The work order **cannot be closed** until a permit with status `issued` and a non-expired expiry date is on record.
4. The permit can be **closed** or **cancelled** after the work is complete.

**Permit statuses:** `draft` → `issued` → `closed` or `cancelled`.

#### Competency Registry

Track staff qualifications and certifications:

| Field | Description |
|---|---|
| **Staff member** | Linked to a user account |
| **Name** | Certification name (e.g. "Electrical LV (authorised)") |
| **Trade** | Relevant trade |
| **Expires at** | Expiry date — the system flags expired competencies |
| **Issued by** | Who issued the certification |

#### Statutory Inspections

Track legally mandated inspections on assets:

| Field | Description |
|---|---|
| **Asset** | The equipment being inspected |
| **Requirement** | Description of the statutory requirement |
| **Frequency** | Interval in days between inspections |
| **Last done** | Date of last completed inspection |
| **Due date** | When the next inspection is due (auto-advances on completion) |

---

### 5.11 Condition-Based Maintenance

Facilix monitors asset health through meter readings and automatically recommends maintenance when thresholds are breached or anomalous patterns are detected.

#### Recording Meter Readings

1. Open an asset detail.
2. Click **Record Reading**.
3. Enter the current value and unit (hours, litres, PSI, etc.).
4. The system validates the reading is **monotonic** (≥ the previous value) and stores it with a timestamp.

**Bulk ingestion:** `POST /api/meter-readings` accepts multiple readings in a single request.

#### Threshold Alerts

When a meter reading crosses a defined threshold:

- An alert is generated and appears on the **Dashboard → Meter Alerts** panel.
- If a maintenance plan is linked to that threshold, a work order is spawned automatically with an evidence payload describing the breach.
- **Duplicate prevention:** No duplicate open recommendation is spawned if one already exists for the same threshold crossing.

#### Trend & Anomaly Detection

The system calculates:

| Metric | Description |
|---|---|
| **Per-day rate** | Average daily increase in the meter value |
| **Rate-spike anomalies** | Readings that deviate significantly from recent trends |
| **Projected breach date** | When the meter is expected to reach the threshold based on current trends |
| **Days to breach** | Countdown to projected threshold crossing |

These are accessible from the asset detail's meter modal and via `GET /api/meter-readings/assets/:id/trend`.

---

### 5.12 Invoicing

Closing a work order automatically generates an invoice, netting parts consumed against the accepted contractor quote.

#### Invoice Details

| Field | Description |
|---|---|
| **Invoice number** | `INV-<year>-<seq>` (e.g. `INV-2026-0001`) |
| **Status** | `draft` → `issued` → `paid` or `void` |
| **Amount** | Calculated: accepted quote amount minus the value of consumed parts (at last received PO unit cost) |
| **Work order** | Linked to the originating work order |
| **Supplier** | The assigned contractor (or null for in-house work) |
| **Tenant** | The reporter (for tenant-requested work) |

#### Invoice Lifecycle

- **Draft** — auto-created on closeout. Can be edited (voided if incorrect).
- **Issued** — sent to the relevant party (admin/manager action).
- **Paid** — payment received and recorded.
- **Void** — cancelled/voided invoice (kept for audit).

The **Invoices** screen shows outstanding vs collected totals and allows one-click status transitions.

> **Idempotency:** Replaying a closeout (online or offline) never generates a duplicate invoice.

---

### 5.13 Notifications

Facilix maintains an **in-app notification feed** for every user, persisted in the database.

#### Notification Types

| Type | Trigger | Recipient |
|---|---|---|
| `work_order_created` | New work order opened | Reporter |
| `work_order_assigned` | Assigned to a user or supplier | Assignee / supplier team |
| `work_order_completed` | Closed (done or verified) | Reporter |
| `work_order_cancelled` | Cancelled by admin/manager | Reporter |
| `work_order_withdrawn` | Withdrawn by tenant | All active admins and managers |
| `contract_expiring` | Contract enters renewal window | All active admins and managers |
| `contract_expired` | Contract end date passed | All active admins and managers |

#### Viewing Notifications

- A **notification bell** icon in the header shows the unread count.
- Click to open the notification feed — a scrollable list with type, title, body, and timestamp.
- Notifications link to the relevant entity (work order, contract).

> Email and SMS notification channels are wired in but currently stub to `console.log`. The architecture is ready for provider integration (SendGrid, Twilio, etc.).

---

### 5.14 Integrations & Event Bus

#### Webhooks

Administrators can configure webhook endpoints in **Settings → Webhooks**:

1. Enter the target URL and an optional HMAC-SHA256 secret.
2. Save — the webhook receives signed POST requests for events like `work_order.created`, `work_order.assigned`, `work_order.closed`, `inventory.low_stock`, `asset.threshold_crossed`, `compliance.permit_issued`.

Each delivery includes:
- `X-Facilix-Signature` header — HMAC-SHA256 of the payload body.
- `X-Facilix-Event` header — the event type.
- Deduplication via `event_id`.

Failed deliveries are retried with exponential backoff. `POST /api/webhooks/flush` forces an immediate retry pass.

#### CSV Import/Export

**Export** (Settings → Integrations):
- Properties, assets, inventory items, work orders, and purchase orders can be exported as CSV files.

**Import** (Settings → Integrations):
- Upload a CSV to bulk-import assets, inventory items, or properties.
- The system validates rows and reports successes/failures.

#### Connector Registry

Facilix ships with stub adapters for:
- Microsoft 365 (SharePoint, Outlook)
- Google Workspace (Drive, Calendar)
- ERP systems (SAP, Oracle)
- Building Management Systems (BMS)

These are registered in the connector registry and ready for real provider credentials.

#### Public Data Dictionary

`GET /api/integrations/data-dictionary` exposes the complete schema as a JSON document — useful for external systems, BI tools, or documentation generators.

---

## 6. Advanced Usage

### 6.1 Dashboard Customisation

Each user has an independent dashboard layout:

1. Click **Customize** on the Dashboard.
2. Toggle panels on/off and reorder them.
3. Changes persist to `users.dashboard_prefs` — only visible panels are fetched, saving bandwidth for mobile users.

**Available panels:** Open Work Orders, Overdue SLAs, Completion Rate, MTBF/MTTR, PM Effectiveness, Low-Stock Alerts, Contract Renewals, Meter Alerts, Recent Notifications, Unpaid Invoices.

### 6.2 Offline Mode (Field Screen)

The **Field** screen is a Progressive Web App designed for technicians working in the field, including areas with poor or no connectivity.

**Setup:**
1. Visit the Field screen while online — the app caches job data, asset details, and checklists in IndexedDB.
2. The service worker precaches the application shell for offline access.

**Working offline:**
- View your assigned jobs and their details from the local cache.
- **Report a problem** — fills in the form offline; the work order is queued locally.
- **Close out work** — capture closeout data, meter readings, parts consumed — all queued.
- **Capture evidence** — take photos or videos that attach to the work order via a queued `document.create` operation.

**When connectivity returns:**
1. The Field screen detects the connection.
2. Click **Sync now** (or it syncs automatically).
3. The app replays queued operations via `POST /api/sync/ops`.
4. It pulls incremental server changes via `GET /api/sync/changes`.
5. A summary shows applied / stale / rejected / pulled counts.

**Conflict resolution:** If the server received a newer edit for the same work order (last-write-wins), the device shows a conflict banner. You can choose to **keep mine** (requeues the edit) or **accept server** (drops the local version).

### 6.3 QR/NFC Site Tags

For quick access to location information in the field:

1. Print QR codes or NFC tags with payloads like:
   - `facilix://trade/plumbing` — pre-fills the trade field.
   - `facilix://location/A101` — pre-fills the location.
2. A tenant or technician can scan the tag with their phone camera or NFC reader.
3. The scan pre-fills the report form with the trade and/or location data.

### 6.4 AI Triage Suggestions

When a tenant types a problem description in the Resident Portal:

1. The text is sent to `POST /api/triage` on each keystroke (debounced).
2. The keyword/hazard classifier suggests relevant trades based on the description.
3. Suggestions only include trades the organisation has configured in its lookup table.
4. Clicking a suggestion auto-fills the trade field.

### 6.5 Webhook Integration

For developers integrating Facilix with external systems:

```bash
# Register a webhook (admin only):
curl -X POST http://localhost:4000/api/webhooks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-system.com/facilix-events", "secret": "your-hmac-secret"}'

# Events are delivered as signed POSTs:
# POST https://your-system.com/facilix-events
# X-Facilix-Event: work_order.closed
# X-Facilix-Signature: <hmac-sha256-hex>
# Body: { "event_id": "...", "event": "work_order.closed", "payload": { ... } }
```

### 6.6 API Access

All screens are backed by a documented REST API. Every list endpoint returns:

```json
{
  "data": [...],
  "meta": { "total": 42, "limit": 50, "offset": 0 }
}
```

Pagination: `?limit=` (default 50, max 200) and `?offset=`.

See [Appendix E: API Reference](#appendix-e-api-reference) for the full route table.

---

## 7. Administration

### 7.1 User Management

Navigate to **Team** to manage your organisation's users.

#### User Roles

| Role | Permissions | Typical Users |
|---|---|---|
| **Admin** | Full access: all CRUD, config, archive, delete, user management | Organisation owner, lead administrator |
| **Manager** | Operational: create/assign/advance/close/cancel work orders, manage suppliers/contracts, view all data | Property managers, operations leads |
| **Technician** | Scoped: work only on assigned orders, record readings, consume parts | Maintenance staff, field workers |
| **Tenant** | Resident portal only: report problems, track own requests, withdraw open requests | Residents, shop owners |
| **Supplier** | Contractor portal only: view assigned jobs, submit quotes, close out work | External contractors, in-house crew leads |

#### Adding Users

1. Navigate to **Team**.
2. Click **Add Member**.
3. Enter name, email, password, role, phone, and (for technicians) trade.
4. **Role rules:**
   - An **admin** can create any role.
   - A **manager** can create managers, technicians, tenants, and suppliers — but **not** other admins.
5. Click **Save** — the new user can log in immediately.

#### Deactivating / Restoring Users

1. In the Team screen, click the user's row.
2. Click **Deactivate** — the user can no longer log in, but their work-order history, competencies, and other records are preserved.
3. Click **Restore** to reactivate.

**Guards:**
- You cannot deactivate yourself.
- You cannot deactivate the last active admin.
- Permanent deletion (`DELETE /api/users/:id`) is admin-only and irreversible.

### 7.2 Organisation Configuration

Navigate to **Settings** to configure organisation-level settings.

#### Trades & Asset Types

1. Under **Trades**, view the active trade list.
2. Click **Add** to create a new trade (e.g. "welding", "fire safety").
3. Toggle any trade **on/off** to activate or deactivate it.
4. Deactivated trades cannot be used on new work orders or assets, but existing records are preserved.

> Every trade and asset-type reference across the app validates against this list — unknown values are rejected with a 400 error.

#### Auto-Assignment

Toggle **Auto-assign suppliers** in Settings. When enabled:
- Urgent and high-priority breakdown work orders are automatically routed to the least-loaded supplier of the correct trade.
- Normal and low-priority work orders remain in the `open` state for manual assignment.

### 7.3 Security Settings

- **JWT authentication** — tokens expire after 7 days; the API enforces `Authorization: Bearer` header on all authenticated routes.
- **Multi-tenancy** — every database query is scoped to `req.orgId` extracted from the JWT. Cross-tenant access is impossible.
- **Role enforcement** — `requireRole()` middleware gates every route to the appropriate roles.
- **Password hashing** — bcrypt with cost factor 10.
- **Rate limiting** — API-wide rate limiter plus a stricter brute-force limiter on authentication endpoints.
- **Production secret** — the API refuses to boot in production if `JWT_SECRET` is not set to a custom value.

### 7.4 Backup & Recovery

Facilix stores all data in PostgreSQL. Standard PostgreSQL backup procedures apply:

```bash
# Full backup:
pg_dump postgres://facilix_user:facilix_password@localhost:5432/facilix > facilix_backup.sql

# Restore:
psql postgres://facilix_user:facilix_password@localhost:5432/facilix < facilix_backup.sql
```

**Document storage:** If using local disk storage (default), back up the storage directory. If using S3/MinIO, ensure bucket versioning or snapshots are enabled.

### 7.5 Deployment at Scale

For multi-site or multi-organisation deployments:

- Use Docker Compose for consistent deployments.
- Place a reverse proxy (nginx, Caddy, Traefik) in front of the web container for TLS termination.
- Use a managed PostgreSQL service (AWS RDS, Google Cloud SQL) for production databases.
- MinIO or AWS S3 for document storage.
- Configure webhook integrations for event-driven architectures.

---

## 8. Troubleshooting

### Common Issues and Solutions

| Issue | Cause | Solution |
|---|---|---|
| API returns 401 on every request | JWT expired or missing | Log out and log in again; check the `Authorization: Bearer` header |
| API returns 403 "Insufficient permissions" | Your role lacks access to the endpoint | Check your role; contact an admin to adjust permissions |
| Work order won't close | Missing closeout fields (failure code, root cause, remedy) or missing required permit | Fill in all required closeout fields; issue a permit if the order requires one |
| Auto-assign didn't fire | Priority is not urgent/high, or no suppliers match the trade, or auto-assign is disabled | Check priority; ensure a supplier exists for the trade; enable auto-assign in Settings |
| Trade or asset type rejected with 400 | Value is not in the org's lookup table, or is deactivated | Add or reactivate the value in Settings → Trades / Asset Types |
| Tenant can't see their request | Wrong login or the request wasn't filed as `tenant_request` | Ensure the tenant logs in with their own email; ensure the request was made through the Resident Portal |
| Technician can't see any work orders | No work orders are assigned to them | Assign a work order to the technician; they see only their own |
| Offline sync shows rejected items | Server received a newer edit (LWW conflict) | Open the conflict review modal; choose "Keep mine" to requeue or "Accept server" to drop |
| Meter reading rejected | Value is less than the previous reading | Meter readings must be monotonically increasing; enter a value ≥ the last recorded reading |
| Can't delete a property | Open work orders still reference it | Close or reassign all open work orders for the property first |
| Invoice not created on closeout | The work order has no accepted quote and no consumed parts (zero-value invoice is skipped) | Accept a supplier quote before closing, or consume parts with a cost |

### Diagnostic Tools

- **Health check:** `GET http://localhost:4000/health` → `{ "status": "ok" }`
- **API logs:** Console output from the backend process (Node.js stdout).
- **Database inspection:** Connect directly with `psql` using the credentials from `.env`.
- **Sync status:** The Field screen's Sync button shows applied/stale/rejected/pulled counts.

### How to Reset or Repair

**Reset demo data:**
```bash
cd backend && npm run seed
```

**Rebuild from scratch:**
```bash
# Drop and recreate the database:
dropdb -U facilix_user facilix
createdb -U facilix_user facilix
psql -U facilix_user -d facilix -f db/schema.sql

# Reload demo data:
npm run seed
```

**Clear offline cache:** In the browser, open DevTools → Application → Storage → Clear site data.

---

## 9. FAQ

**Q: Can I run Facilix without PostGIS?**
A: Yes. PostGIS is optional. The property lat/lng coordinates work with plain `NUMERIC` columns. Spatial queries (map rendering) work without PostGIS; the `geom` column stays in sync whenever PostGIS is installed.

**Q: What happens if two technicians try to close the same work order offline?**
A: Last-write-wins. The first device's closeout succeeds; the second device's closeout is flagged as stale during sync. The technician can choose to accept the server state or requeue.

**Q: Can I customise the failure codes?**
A: The 14 failure codes are a standardised enum defined in the database schema (wear_and_tear, corrosion, lubrication, blockage, leak, electrical_fault, overload, foreign_object, operator_error, installation_error, manufacturer_defect, water_damage, no_fault_found, other). They are intentionally fixed to ensure consistent reliability analytics. The free-text `root_cause` and `remedy` fields provide flexibility.

**Q: How do I add a new trade (e.g. "fire safety")?**
A: Navigate to Settings → Trades → Add. Enter the value (e.g. `fire_safety`) and label (e.g. "Fire Safety"). It will be available for selection on new work orders and assets immediately.

**Q: Can suppliers see each other's quotes?**
A: No. Each supplier sees only their own quotes in the Contractor Portal. Admins and managers see all quotes for comparison.

**Q: What currencies are supported?**
A: Invoices default to KES (Kenyan Shilling). The currency field on quotes and invoices is a free-text string, so other currencies can be entered manually.

**Q: Is there a mobile app?**
A: Facilix is a Progressive Web App (PWA). The offline-capable Field screen and Resident Portal work like native apps when added to a phone's home screen — no app store installation required.

**Q: How do I enable email or SMS notifications?**
A: The notification architecture supports email and SMS channels via pluggable providers. Currently these stub to `console.log`. To enable real delivery, implement the provider functions in `backend/src/notifications.js` (e.g. SendGrid for email, Twilio for SMS).

**Q: Can I import data from another system?**
A: Yes. Navigate to Settings → Integrations → CSV Import. Assets, inventory items, and properties can be bulk-imported from CSV files. Use the data dictionary endpoint (`GET /api/integrations/data-dictionary`) for column specifications.

---

## 10. Support & Resources

### Getting Help

| Channel | Details |
|---|---|
| **Documentation** | This manual (Facilix_Software_Manual.md) |
| **Data dictionary** | `GET /api/integrations/data-dictionary` — machine-readable schema reference |
| **API health check** | `GET /health` |

### Reporting Bugs / Requesting Features

1. Open an issue in the project's GitHub repository.
2. Include: steps to reproduce, expected behaviour, actual behaviour, and browser/OS details.
3. For feature requests, describe the use case and the expected workflow.

### Community & Knowledge Base

Facilix is currently in internal deployment. Community forums and a public knowledge base are planned for a future release.

---

## 11. Reference Appendices

### Appendix A: Demo Logins

All demo logins use password: **`facilix-demo`**

| Email | Role | Scope |
|---|---|---|
| `eric.newborn@denvic.co.ke` | Admin (overall) | Full access |
| `dennis.mafuta@denvic.co.ke` | Admin | Full access |
| `victor.odero@denvic.co.ke` | Admin | Full access |
| `barbara.noel@denvic.co.ke` | Manager | Operational powers |
| `zablon.ochola@denvic.co.ke` | Manager | Operational powers |
| `michael.aketch@denvic.co.ke` | Manager | Operational powers |
| `wilfred.rumoine@denvic.co.ke` | Technician (plumbing) | Sees only assigned jobs |
| `james.munene@denvic.co.ke` | Technician (electrical) | Sees only assigned jobs |
| `peter.tindi@denvic.co.ke` | Technician (gardening) | Sees only assigned jobs |
| `petronilah@denvic.co.ke` | Technician (janitorial) | Sees only assigned jobs |
| `fred.muka@gmail.com` | Tenant (Unit A101) | Own requests only |
| `charles.mbugua@yahoo.com` | Tenant (Unit C622) | Own requests only |
| `rachael.mwangi@gmail.com` | Tenant (Unit E832) | Own requests only |
| `doreen.achieng@gmail.com` | Tenant (Unit A102) | Own requests only |
| `sammy.omondi@outlook.com` | Tenant (Unit 1601) | Own requests only |
| `grace.njeri@gmail.com` | Tenant (Unit 1846) | Own requests only |
| `kipchoge.bett@gmail.com` | Tenant (Unit 3032) | Own requests only |
| `alex.muthoka@gmail.com` | Tenant (Shop S203, Greatwall Gardens Mall) | Own requests only |
| `joseph.muriuki@gmail.com` | Supplier portal (in-house plumbing crew) | Assigned jobs + open jobs |

### Appendix B: Failure Codes

| Code | Meaning |
|---|---|
| `wear_and_tear` | Normal degradation over time |
| `corrosion` | Rust or chemical degradation |
| `lubrication` | Insufficient or degraded lubrication |
| `blockage` | Obstruction in pipes, drains, or vents |
| `leak` | Water, fuel, or fluid leak |
| `electrical_fault` | Wiring, connection, or component electrical issue |
| `overload` | Exceeded designed capacity |
| `foreign_object` | External item causing damage or obstruction |
| `operator_error` | Misuse or incorrect operation |
| `installation_error` | Defect from original or subsequent installation |
| `manufacturer_defect` | Fault in the original manufacture |
| `water_damage` | Damage from water ingress or flooding |
| `no_fault_found` | Issue could not be replicated or identified |
| `other` | Requires manual description in root_cause |

### Appendix C: Work-Order Status Lifecycle

```
                    ┌──────────┐
                    │   OPEN   │
                    └────┬─────┘
                         │ assigned
                    ┌────▼─────┐
                    │ ASSIGNED │
                    └────┬─────┘
                         │ start work
                    ┌────▼──────────┐
                    │  IN PROGRESS  │
                    └────┬────┬─────┘
                         │    │
                closeout │    │ cancel
                         │    │
              ┌──────────▼┐  ┌▼────────────┐
              │    DONE    │  │  CANCELLED   │
              └──────┬─────┘  └──────────────┘
                     │ verify              (terminal)
              ┌──────▼──────┐
              │  VERIFIED   │
              └─────────────┘
                   (terminal)
```

**Terminal states** (done, verified, cancelled) are frozen — no further status changes are allowed.

### Appendix D: Keyboard Shortcuts

Facilix is primarily a point-and-click interface. The following browser-native shortcuts are useful:

| Action | Shortcut |
|---|---|
| Navigate between tabs | `Ctrl` + `1`–`9` (browser tab switching) |
| Search/filter the board | Click the filter input or use the status tabs |
| Open a work order detail | Click the card title |
| Close a modal | `Esc` |

> Custom keyboard shortcuts are not yet implemented. They are planned for a future release focused on power-user workflows.

### Appendix E: API Reference

#### Authentication

| Method | Path | Description | Auth |
|---|---|---|---|
| `POST` | `/api/auth/signup` | Create workspace + first admin | None |
| `POST` | `/api/auth/login` | Log in, receive JWT | None |

#### Work Orders

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/work-orders` | List (role-scoped) | All |
| `POST` | `/api/work-orders` | Create | All |
| `PATCH` | `/api/work-orders/:id` | Update status/assignment/closeout | All (scoped) |
| `DELETE` | `/api/work-orders/:id` | Permanent delete (archived only) | admin |
| `POST` | `/api/work-orders/archive` | Bulk archive by status | admin |

#### Properties & Assets

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/properties` | List with spatial aggregates | All |
| `POST` | `/api/properties` | Create | admin, manager |
| `PATCH` | `/api/properties/:id` | Update (incl. coordinates) | admin, manager |
| `DELETE` | `/api/properties/:id` | Delete (cascades) | admin, manager |
| `GET` | `/api/properties/geocode?q=` | Address → coordinates | All |
| `GET` | `/api/assets` | List with filters | All |
| `POST` | `/api/assets` | Create | admin, manager |
| `PATCH` | `/api/assets/:id` | Update | admin, manager |
| `DELETE` | `/api/assets/:id` | Delete | admin, manager |

#### Maintenance Plans

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/maintenance-plans` | List | admin, manager |
| `POST` | `/api/maintenance-plans` | Create | admin, manager |
| `PATCH` | `/api/maintenance-plans/:id` | Update | admin, manager |
| `DELETE` | `/api/maintenance-plans/:id` | Delete | admin, manager |
| `POST` | `/api/maintenance-plans/:id/run` | Run a single plan now | admin, manager |
| `POST` | `/api/maintenance-plans/run` | Run all due plans | admin, manager |

#### Suppliers & Quotes

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/suppliers` | List | admin, manager |
| `POST` | `/api/suppliers` | Create | admin, manager |
| `GET` | `/api/work-orders/:id/quotes` | List quotes for a WO | admin, manager, assigned supplier |
| `POST` | `/api/work-orders/:id/quotes` | Submit a quote | supplier |
| `PATCH` | `/api/work-orders/:id/quotes/:quoteId` | Accept/reject | admin, manager |

#### Contracts

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/contracts` | List | admin, manager |
| `POST` | `/api/contracts` | Create | admin, manager |
| `PATCH` | `/api/contracts/:id` | Update | admin, manager |
| `DELETE` | `/api/contracts/:id` | Terminate | admin, manager |
| `POST` | `/api/contracts/check-expiry` | Re-check expiry status | admin, manager |

#### Inventory & Procurement

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/inventory` | List items | All staff |
| `POST` | `/api/inventory` | Create item | admin, manager |
| `PATCH` | `/api/inventory/:id` | Update item | admin, manager |
| `POST` | `/api/inventory/:id/movements` | Record a stock movement | All staff |
| `GET` | `/api/inventory/reorder-recommendations` | Items needing reorder | admin, manager |
| `GET` | `/api/inventory/:id/price-history` | Price trend for an item | admin, manager |
| `GET` | `/api/purchase-orders` | List POs | admin, manager |
| `POST` | `/api/purchase-orders` | Create PO (draft) | admin, manager |
| `PATCH` | `/api/purchase-orders/:id` | Update / transition | admin, manager (approve gated) |

#### Compliance

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/compliance` | Summary (permits, competencies, inspections) | All staff |
| `POST` | `/api/compliance/permits` | Issue a permit | admin, manager |
| `PATCH` | `/api/compliance/permits/:id` | Close/cancel permit | admin, manager |
| `POST` | `/api/compliance/permits/:id/evidence` | Attach evidence to permit | admin, manager |

#### Invoices

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/invoices` | List (role-scoped) | All |
| `PATCH` | `/api/invoices/:id` | Transition status | admin, manager |

#### Meter Readings & Condition-Based Maintenance

| Method | Path | Description | Roles |
|---|---|---|---|
| `POST` | `/api/assets/:id/readings` | Record a meter reading | All staff |
| `POST` | `/api/meter-readings` | Bulk ingest readings | admin, manager |
| `GET` | `/api/meter-readings/alerts` | Threshold breach alerts | admin, manager |
| `GET` | `/api/meter-readings/assets/:id/trend` | Trend + anomaly data | admin, manager |

#### Users & Configuration

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/users` | List users | All staff |
| `POST` | `/api/users` | Create user | admin, manager (admin-only for admins) |
| `PATCH` | `/api/users/:id` | Deactivate/restore | admin |
| `DELETE` | `/api/users/:id` | Permanent delete | admin |
| `GET` | `/api/users/me/prefs` | Get dashboard preferences | All staff |
| `PUT` | `/api/users/me/prefs` | Save dashboard preferences | All staff |
| `GET` | `/api/config` | Org vocabulary (trades, asset types) | All staff |
| `POST` | `/api/config/:kind` | Add trade or asset type | admin |
| `PATCH` | `/api/config/:kind/:value` | Activate/deactivate | admin |
| `PATCH` | `/api/config/auto-assign` | Toggle auto-assignment | admin |

#### Integrations

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/webhooks` | List webhooks | admin |
| `POST` | `/api/webhooks` | Create webhook | admin |
| `DELETE` | `/api/webhooks/:id` | Delete webhook | admin |
| `POST` | `/api/webhooks/flush` | Retry failed deliveries | admin |
| `GET` | `/api/integrations/export/:kind` | CSV export | admin |
| `POST` | `/api/integrations/import/:kind` | CSV import | admin |
| `GET` | `/api/integrations/data-dictionary` | Schema documentation | Public |

#### Sync (Offline)

| Method | Path | Description | Roles |
|---|---|---|---|
| `GET` | `/api/sync/changes?since=&limit=` | Incremental change stream | admin, manager, technician |
| `POST` | `/api/sync/ops` | Replay offline mutations | admin, manager, technician |

### Appendix F: Glossary

| Term | Definition |
|---|---|
| **Asset** | A tracked piece of equipment within a property hierarchy |
| **Board** | The kanban-style work-order display with draggable cards by status |
| **Closeout** | The process of closing a work order with structured data (failure code, root cause, remedy, parts, meter) |
| **Contract** | A formal agreement with a supplier tracking value, spend, and renewal dates |
| **Cursor** | A server-side pointer for paginated change-stream queries |
| **Field** | The offline-first screen for mobile technicians |
| **JWT** | JSON Web Token — the authentication mechanism |
| **LWW** | Last-write-wins — conflict resolution strategy used in offline sync |
| **MTBF** | Mean Time Between Failures — average time between equipment failures |
| **MTTR** | Mean Time To Repair — average time from breakdown to resolution |
| **Permit** | A permit-to-work authorising specific hazardous work |
| **PM** | Preventive Maintenance — scheduled or meter-based recurring work |
| **PO** | Purchase Order — a procurement record |
| **RBAC** | Role-Based Access Control |
| **SLA** | Service Level Agreement — time-based service commitment |
| **Sync** | The process of reconciling offline changes with the server |
| **Tombstone** | A deletion record in the sync change stream |
| **WO** | Work Order — the central operational entity |
