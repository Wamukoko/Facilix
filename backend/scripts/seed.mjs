// Dev-only seed: wipes the database and creates a demo organization with a
// realistic facility hierarchy, assets, suppliers, maintenance plans, work
// orders (including Phase 8 closeout data) and meter history so the app is
// demonstrable out of the box. Localized to a Kenyan facilities-management
// context. Re-running clears and rebuilds the demo workspace.
//
//   npm run seed
//
// Denvic Property Managers operates Greatwall Gardens Estate (Phase 1 & 2) on
// Shanghai Road, Pridelands, Athi River, plus supporting sites around Nairobi
// and Syokimau. Unit numbers follow the estate's own scheme: A101/A102/A351,
// C622/E832, and 4-digit maisonettes 1601/1846/3032. All logins share the
// password below. Staff get Denvic's own domain (<first.last>@denvic.co.ke);
// residents and contractors are not staff, so they use personal / company
// emails instead (e.g. fred.muka@gmail.com, faith@athipower.co.ke).

import bcrypt from "bcryptjs";
import { pool, query } from "../src/db.js";
import { seedDefaultLookups } from "../src/lib/lookups.js";
import { effectiveContractStatus } from "../src/lib/contracts.js";

const ORG_NAME = "Denvic Property Managers";
const DEMO_PASSWORD = "facilix-demo";

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const daysFromNow = (n) => new Date(Date.now() + n * DAY).toISOString();

async function seed() {
  console.log("Seeding…");

  // Clear the database — every table is keyed on organization_id with
  // ON DELETE CASCADE, so removing all orgs removes everything else too.
  const { rowCount } = await query(`DELETE FROM organizations`);
  if (rowCount > 0) console.log(`  cleared ${rowCount} existing workspace(s)`);

  const org = (await query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id, name`, [ORG_NAME])).rows[0];
  const orgId = org.id;

  // Demo the Fixflo-inspired auto-assignment routing: urgent/high breakdowns
  // are routed straight to the least-loaded supplier for the trade.
  await query(`UPDATE organizations SET auto_assign_suppliers = true WHERE id = $1`, [orgId]);

  // Default vocabulary, plus demo-specific extras to show runtime configurability.
  await seedDefaultLookups({ query }, orgId);
  await query(
    `INSERT INTO asset_types (organization_id, value, label)
     VALUES ($1,'solar','Solar PV') ON CONFLICT (organization_id, value) DO NOTHING`,
    [orgId]
  );
  await query(
    `INSERT INTO trades (organization_id, value, label)
     VALUES ($1,'welding','Welding') ON CONFLICT (organization_id, value) DO NOTHING`,
    [orgId]
  );

  const pw = await bcrypt.hash(DEMO_PASSWORD, 10);

  const addUser = async (email, fullName, role, trade = null, phone = null, supplierId = null) =>
    (
      await query(
        `INSERT INTO users (organization_id, email, password_hash, full_name, role, trade, phone, supplier_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [orgId, email, pw, fullName, role, trade, phone, supplierId]
      )
    ).rows[0];

  const addProperty = async (name, address, latitude, longitude) =>
    (
      await query(
        `INSERT INTO properties (organization_id, name, address, latitude, longitude)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [orgId, name, address, latitude, longitude]
      )
    ).rows[0];

  const addBuilding = async (propertyId, name, yearBuilt, floorCount) =>
    (
      await query(
        `INSERT INTO buildings (property_id, name, year_built, floor_count)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [propertyId, name, yearBuilt, floorCount]
      )
    ).rows[0];

  const addFloor = async (buildingId, label) =>
    (
      await query(`INSERT INTO floors (building_id, label) VALUES ($1,$2) RETURNING id`, [buildingId, label])
    ).rows[0];

  const addRoom = async (floorId, name, roomType = "unit", areaSqm = 58) =>
    (
      await query(
        `INSERT INTO rooms (floor_id, name, room_type, area_sqm) VALUES ($1,$2,$3,$4) RETURNING id`,
        [floorId, name, roomType, areaSqm]
      )
    ).rows[0];

  const addAsset = async (name, type, opts = {}) =>
    (
      await query(
        `INSERT INTO assets (organization_id, room_id, building_id, property_id, name, type, attributes, install_date, warranty_end, status, meter_value, meter_unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [orgId, opts.room ?? null, opts.building ?? null, opts.property ?? null, name, type,
         JSON.stringify(opts.attrs ?? {}), opts.install ?? null, opts.warranty ?? null,
         opts.status ?? "active", opts.meter ?? null, opts.meterUnit ?? null]
      )
    ).rows[0];

  const addSupplier = async (name, trade, contactName, contactEmail, contactPhone, isInternal) =>
    (
      await query(
        `INSERT INTO suppliers (organization_id, name, trade, contact_name, contact_email, contact_phone, is_internal)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [orgId, name, trade, contactName, contactEmail, contactPhone, isInternal]
      )
    ).rows[0];

  const addPlan = async (name, assetType, assetId, trigger, frequencyDays, meterThreshold, checklist, supplierId, active = true) =>
    (
      await query(
        `INSERT INTO maintenance_plans (organization_id, name, asset_type, asset_id, trigger, frequency_days, meter_threshold, checklist, default_supplier_id, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [orgId, name, assetType, assetId ?? null, trigger, frequencyDays ?? null, meterThreshold ?? null,
         JSON.stringify(checklist), supplierId ?? null, active]
      )
    ).rows[0];

  // Work-order helper — closeout fields optional, created/completed as ISO so
  // created_at always precedes completed_at (keeps MTTR/MTBF sane).
  const addWorkOrder = async (o) => {
    const { rows } = await query(
      `INSERT INTO work_orders (organization_id, asset_id, room_id, maintenance_plan_id, source, trade, title, description, status, priority,
         assigned_supplier_id, assigned_user_id, reported_by_user_id, cost, due_date, failure_code, root_cause, remedy, parts_used,
         meter_value_at_closeout, sla_due_at, requires_permit, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [orgId, o.asset ?? null, o.room ?? null, o.plan ?? null, o.source, o.trade, o.title, o.description ?? null, o.status, o.priority,
       o.supplier ?? null, o.user ?? null, o.reporter ?? null, o.cost ?? null, o.due ?? null, o.failure_code ?? null,
       o.root_cause ?? null, o.remedy ?? null, o.parts_used ?? null, o.meterAtCloseout ?? null, o.slaDue ?? null,
       o.requiresPermit ?? false, o.created ?? daysAgo(0), o.completed ?? null]
    );
    return rows[0];
  };

  const notify = (userId, type, title, body, refType, refId) =>
    query(
      `INSERT INTO notifications (organization_id, user_id, channel, type, title, body, ref_type, ref_id)
       VALUES ($1,$2,'in_app',$3,$4,$5,$6,$7)`,
      [orgId, userId, type, title, body, refType, refId]
    );

  // ------------------------------------------------------------------
  // Staff — three admins, three managers, four trade technicians.
  // ------------------------------------------------------------------
  const eric = await addUser("eric.newborn@denvic.co.ke", "Eric Newborn", "admin", "general", "+254 712 100 001");
  const dennis = await addUser("dennis.mafuta@denvic.co.ke", "Dennis Mafuta", "admin", "general", "+254 712 100 002");
  const victor = await addUser("victor.odero@denvic.co.ke", "Victor Odero", "admin", "general", "+254 712 100 003");
  const barbara = await addUser("barbara.noel@denvic.co.ke", "Barbara Noel", "manager", "general", "+254 712 100 004");
  const zablon = await addUser("zablon.ochola@denvic.co.ke", "Zablon Ochola", "manager", "general", "+254 712 100 005");
  const michael = await addUser("michael.aketch@denvic.co.ke", "Michael Aketch", "manager", "general", "+254 712 100 006");
  const wilfred = await addUser("wilfred.rumoine@denvic.co.ke", "Wilfred Rumoine", "technician", "plumbing", "+254 733 200 001");
  const james = await addUser("james.munene@denvic.co.ke", "James Munene", "technician", "electrical", "+254 733 200 002");
  const peter = await addUser("peter.tindi@denvic.co.ke", "Peter Tindi", "technician", "gardening", "+254 733 200 003");
  const petronilah = await addUser("petronilah@denvic.co.ke", "Petronilah", "technician", "janitorial", "+254 733 200 004");

  // ------------------------------------------------------------------
  // Properties — Greatwall Gardens Estate (flagship), plus Syokimau and
  // a Nairobi office site so the map and portfolio have depth.
  // ------------------------------------------------------------------
  const greatwall = await addProperty(
    "Greatwall Gardens Estate",
    "Shanghai Road, Pridelands, Athi River",
    -1.4448, 36.9809
  );
  const acacia = await addProperty(
    "Acacia Court",
    "Katani Road, Syokimau, Machakos County",
    -1.3525, 36.9488
  );
  const corporate = await addProperty(
    "Denvic Corporate Centre",
    "Hospital Road, Upper Hill, Nairobi",
    -1.2994, 36.8112
  );

  // --- Greatwall Gardens: Phase 1 (Blocks A, B, C) + Phase 2 (Block E) ---
  const phase1A = await addBuilding(greatwall.id, "Phase 1 · Block A", 2015, 3);
  const phase1C = await addBuilding(greatwall.id, "Phase 1 · Block C", 2015, 3);
  const phase2E = await addBuilding(greatwall.id, "Phase 2 · Block E", 2019, 4);
  const phase2M = await addBuilding(greatwall.id, "Phase 2 · Maisonettes", 2021, 1);
  const gwMall = await addBuilding(greatwall.id, "Greatwall Gardens Mall", 2016, 2);

  const a1 = await addFloor(phase1A.id, "1st Floor");
  const a3 = await addFloor(phase1A.id, "3rd Floor");
  const c2 = await addFloor(phase1C.id, "2nd Floor");
  const e3 = await addFloor(phase2E.id, "3rd Floor");
  const mz = await addFloor(phase2M.id, "Maisonette");

  // Unit numbering: <block><floor><unit> (A101, C622, E832) and 4-digit maisonettes.
  const a101 = await addRoom(a1.id, "Unit A101");
  const a102 = await addRoom(a1.id, "Unit A102");
  const a351 = await addRoom(a3.id, "Unit A351");
  const c622 = await addRoom(c2.id, "Unit C622");
  const e832 = await addRoom(e3.id, "Unit E832");
  const u1601 = await addRoom(mz.id, "Unit 1601", "unit", 92);
  const u1846 = await addRoom(mz.id, "Unit 1846", "unit", 104);
  const u3032 = await addRoom(mz.id, "Unit 3032", "unit", 110);

  // The mall's retail galleria — Shop S203 is Alex Muthoka's storefront.
  const mallGalleria = await addFloor(gwMall.id, "Retail Galleria");
  const shopS203 = await addRoom(mallGalleria.id, "Shop S203", "retail", 64);

  // Communal & utility rooms.
  const gwGround = await addFloor(phase1A.id, "Ground Floor");
  const gwLobby = await addRoom(gwGround.id, "Block A lobby", "common_area", 120);
  const pumpHouse = await addRoom(gwGround.id, "Pump house", "utility", 24);
  const gensetRoom = await addRoom(gwGround.id, "Generator room", "utility", 30);
  const gatehouse = await addRoom(gwGround.id, "Gatehouse", "utility", 16);

  // --- Acacia Court, Syokimau (compact) ---
  const acaciaB = await addBuilding(acacia.id, "Syokimau Court", 2018, 4);
  const acaciaF = await addFloor(acaciaB.id, "1st Floor");
  const acaciaUnit = await addRoom(acaciaF.id, "Unit S-104");
  const acaciaGround = await addFloor(acaciaB.id, "Ground Floor");
  const acaciaPump = await addRoom(acaciaGround.id, "Borehole shed", "utility", 12);

  // --- Denvic Corporate Centre, Upper Hill ---
  const corpB = await addBuilding(corporate.id, "Office Tower", 2012, 8);
  const corpPlant = await addFloor(corpB.id, "Plant Room");
  const corpServer = await addFloor(corpB.id, "Server Room");
  const corpLobby = await addFloor(corpB.id, "Lobby");
  const plantRoom = await addRoom(corpPlant.id, "Central plant", "utility", 90);
  const serverRoom = await addRoom(corpServer.id, "Server room", "utility", 24);
  const corpLobbyRoom = await addRoom(corpLobby.id, "Main lobby", "common_area", 160);

  // ------------------------------------------------------------------
  // Assets — Greatwall is borehole + backup-generator country (Athi River
  // suffers frequent outages), so the meter-driven maintenance story lives
  // on the borehole pump.
  // ------------------------------------------------------------------
  const borehole = await addAsset("Borehole pump BP-1", "plumbing", {
    room: pumpHouse.id, building: phase1A.id, property: greatwall.id,
    attrs: { capacity_lpm: 300 }, install: "2019-03-12", warranty: "2024-03-12",
    meter: 48250, meterUnit: "hours",
  });
  await addAsset("Water booster pump WP-2", "plumbing", {
    building: phase2E.id, property: greatwall.id,
    attrs: { flow_m3h: 12 }, install: "2020-06-01", warranty: "2025-06-01",
  });
  const genset = await addAsset("Standby generator G-1", "electrical", {
    room: gensetRoom.id, building: phase1A.id, property: greatwall.id,
    attrs: { kva: 750, fuel: "diesel" }, install: "2018-11-20", warranty: "2028-11-20",
    meter: 1280, meterUnit: "hours",
  });
  await addAsset("Main distribution board MDB-1", "electrical", {
    building: phase1A.id, property: greatwall.id, attrs: { rating_amps: 400 }, install: "2016-07-01", warranty: "2026-07-01",
  });
  await addAsset("Gatehouse solar array PV-1", "solar", {
    room: gatehouse.id, property: greatwall.id,
    attrs: { panels: 48, kwp: 12.6 }, install: "2023-08-01", warranty: "2033-08-01",
  });
  await addAsset("CCTV head-end NVR-1", "telecom", {
    building: phase1A.id, property: greatwall.id, attrs: { cameras: 24 }, install: "2021-05-10", warranty: "2026-05-10",
  });
  await addAsset("Estate irrigation controller", "green_area", {
    property: greatwall.id, attrs: { zones: 6 }, install: "2021-04-05", meter: 0, meterUnit: "liters",
  });
  await addAsset("Ride-on scrubber S-2", "janitorial_equipment", {
    room: gwLobby.id, attrs: { battery: "24V" }, install: "2022-02-14", warranty: "2027-02-14", status: "under_repair",
  });
  await addAsset("Lawn mower M-1", "green_area", {
    property: greatwall.id, attrs: { deck: "46in" }, install: "2020-09-01",
  });

  // Corporate + Syokimau assets.
  await addAsset("Office generator G-2", "electrical", {
    room: plantRoom.id, building: corpB.id, property: corporate.id,
    attrs: { kva: 250, fuel: "diesel" }, install: "2013-01-15", warranty: "2023-01-15",
  });
  await addAsset("AHU-1 central unit", "hvac", {
    room: plantRoom.id, building: corpB.id, property: corporate.id,
    attrs: { tonnage: 40 }, install: "2015-04-01",
  });
  await addAsset("Server UPS-1", "it", {
    room: serverRoom.id, building: corpB.id, property: corporate.id, attrs: { kva: 30 }, install: "2020-03-01", warranty: "2025-03-01",
  });
  const acaciaBorehole = await addAsset("Borehole pump BP-2", "plumbing", {
    room: acaciaPump.id, building: acaciaB.id, property: acacia.id,
    attrs: { capacity_lpm: 180 }, install: "2019-09-01", warranty: "2024-09-01", meter: 21900, meterUnit: "hours",
  });

  // ------------------------------------------------------------------
  // Suppliers — in-house crews plus subcontracted trade companies. The
  // in-house plumbing crew doubles as the contractor-portal demo login.
  // ------------------------------------------------------------------
  const inHousePlumbing = await addSupplier(
    "Denvic In-house Plumbing Crew", "plumbing", "Joseph Muriuki",
    "joseph.muriuki@gmail.com", "+254 722 300 001", true
  );
  const athiPower = await addSupplier(
    "Athi Power Electricals", "electrical", "Faith Wambui",
    "faith@athipower.co.ke", "+254 733 444 555", false
  );
  await addSupplier(
    "DrainPro Plumbing & Drainage", "plumbing", "Samuel Kinyua",
    "samuel@drainpro.co.ke", "+254 711 555 666", false
  );
  const greenScape = await addSupplier(
    "GreenScape Landscaping", "gardening", "Brian Kariuki",
    "brian@greenscape.co.ke", "+254 711 777 888", false
  );
  await addSupplier(
    "Supreme Janitorial Services", "janitorial", "Lucy Adhiambo",
    "lucy@supremejanitorial.co.ke", "+254 722 888 999", false
  );

  // Contractor portal demo login — the plumbing crew lead, scoped to the
  // supplier's own jobs only.
  await addUser("joseph.muriuki@gmail.com", "Joseph Muriuki", "supplier", "plumbing", "+254 722 300 001", inHousePlumbing.id);

  // ------------------------------------------------------------------
  // Residents & shop owners — Greatwall units plus the mall, with extra
  // families so the resident portal and request board have life. None of
  // them are staff, so they use personal emails, never the Denvic domain.
  // ------------------------------------------------------------------
  const fred = await addUser("fred.muka@gmail.com", "Fred Muka", "tenant", null, "+254 701 300 001");
  const charles = await addUser("charles.mbugua@yahoo.com", "Charles Mbugua", "tenant", null, "+254 701 300 002");
  const rachael = await addUser("rachael.mwangi@gmail.com", "Rachael Mwangi", "tenant", null, "+254 701 300 003");
  const doreen = await addUser("doreen.achieng@gmail.com", "Doreen Achieng", "tenant", null, "+254 701 300 004");
  const sammy = await addUser("sammy.omondi@outlook.com", "Sammy Omondi", "tenant", null, "+254 701 300 005");
  const grace = await addUser("grace.njeri@gmail.com", "Grace Njeri", "tenant", null, "+254 701 300 006");
  const kipchoge = await addUser("kipchoge.bett@gmail.com", "Kipchoge Bett", "tenant", null, "+254 701 300 007");
  const alex = await addUser("alex.muthoka@gmail.com", "Alex Muthoka", "tenant", null, "+254 701 300 008");

  // ------------------------------------------------------------------
  // Maintenance plans
  // ------------------------------------------------------------------
  const pumpPlan = await addPlan("Borehole pump quarterly service", "plumbing", null, "scheduled", 90, null,
    ["Inspect visible pipes for corrosion", "Check seals and washers", "Verify pump pressure", "Record meter reading"],
    inHousePlumbing.id);
  const gensetPlan = await addPlan("Generator monthly inspection", "electrical", null, "scheduled", 30, null,
    ["Test auto-start", "Check coolant and oil", "Inspect battery", "Log running hours"], athiPower.id);
  await addPlan("Gate solar array cleaning", "solar", null, "scheduled", 30, null,
    ["Wipe panels", "Check mounts and cabling", "Inspect inverter vents"], null);
  await addPlan("Garden weekly upkeep", "green_area", null, "scheduled", 7, null,
    ["Mow lawns", "Trim hedges", "Check irrigation timers"], greenScape.id);
  await addPlan("Common areas deep clean", "janitorial", null, "scheduled", 30, null,
    ["Scrub lobby floors", "Detail washrooms", "Buff and seal high-traffic zones"], null);
  const overhaulPlan = await addPlan("Borehole pump major overhaul", "plumbing", borehole.id, "meter_based", null, 50000,
    [{ step: "Inspect impeller wear" }, { step: "Replace bearings" }, { step: "Test flow rate" }], inHousePlumbing.id);

  // ------------------------------------------------------------------
  // Work orders — spread across the lifecycle with Phase 8 closeout data.
  // ------------------------------------------------------------------
  const leakingTap = await addWorkOrder({
    room: a101.id, source: "tenant_request", trade: "plumbing",
    title: "Leaking tap — Unit A101",
    description: "Kitchen tap drips constantly; cabinet under the sink is damp.",
    status: "open", priority: "high", reporter: fred.id, created: daysAgo(4),
  });
  const gensetWo = await addWorkOrder({
    asset: genset.id, source: "breakdown", trade: "electrical",
    title: "Standby generator G-1 not starting",
    description: "Genset cranks but will not catch; estate outage expected this evening.",
    status: "assigned", priority: "normal", supplier: athiPower.id, reporter: eric.id, created: daysAgo(3),
  });
  const pumpCheck = await addWorkOrder({
    asset: borehole.id, room: pumpHouse.id, plan: pumpPlan.id, source: "plan", trade: "plumbing",
    title: "Borehole pump pressure check",
    description: "Part of the quarterly borehole pump service.",
    status: "in_progress", priority: "normal", user: wilfred.id, created: daysAgo(2),
  });
  const drainWo = await addWorkOrder({
    room: a102.id, source: "tenant_request", trade: "plumbing",
    title: "Blocked kitchen drain — Unit A102",
    description: "Sink drains very slowly; water pooling in the P-trap area.",
    status: "done", priority: "normal", supplier: inHousePlumbing.id, user: wilfred.id, reporter: doreen.id,
    cost: 4500, failure_code: "wear_and_tear", root_cause: "Grease buildup in the P-trap",
    remedy: "Cleared the trap and flushed the line with degreaser", parts_used: "Drain auger, degreaser",
    created: daysAgo(5), completed: daysAgo(2),
  });
  const gensetService = await addWorkOrder({
    asset: genset.id, room: gensetRoom.id, plan: gensetPlan.id, source: "plan", trade: "electrical",
    title: "Generator service — lubrication",
    description: "Bearings running dry, high vibration reported.",
    status: "done", priority: "high", supplier: athiPower.id, user: james.id,
    cost: 18000, failure_code: "lubrication", root_cause: "Bearings dry from missed service",
    remedy: "Regreased bearings and tested auto-start", parts_used: "Grease 500g",
    meterAtCloseout: 1280, created: daysAgo(10), completed: daysAgo(1),
  });
  const socketWo = await addWorkOrder({
    room: a101.id, source: "tenant_request", trade: "electrical",
    title: "Bedroom socket sparks when plugging in",
    description: "Tenant reported a spark at the bedside socket — worried about safety.",
    status: "assigned", priority: "high", user: james.id, reporter: fred.id,
    slaDue: daysFromNow(0), created: daysAgo(0),
  });
  const mallLightsWo = await addWorkOrder({
    room: shopS203.id, source: "tenant_request", trade: "electrical",
    title: "Shop S203 strip lights flickering on generator",
    description: "Storefront LED strips flicker whenever the mall runs on the estate generator; Alex asked for it to be looked at.",
    status: "assigned", priority: "high", user: james.id, reporter: alex.id, created: daysAgo(1),
  });
  await addWorkOrder({
    property: greatwall.id, source: "breakdown", trade: "gardening",
    title: "Irrigation controller not cycling",
    description: "Shrub beds near the gatehouse are drying out; controller shows a fault.",
    status: "assigned", priority: "normal", user: peter.id, reporter: eric.id, created: daysAgo(1),
  });
  const lobbyWo = await addWorkOrder({
    room: gwLobby.id, source: "tenant_request", trade: "janitorial",
    title: "Block A lobby floor grout staining",
    description: "High-traffic grout lines have darkened; reseal requested.",
    status: "done", priority: "low", user: petronilah.id, reporter: charles.id,
    cost: 2500, failure_code: "other", root_cause: "Grout wear in high-traffic lobby",
    remedy: "Deep-scrubbed and resealed the grout lines",
    created: daysAgo(7), completed: daysAgo(3),
  });
  const gutterWo = await addWorkOrder({
    building: phase1C.id, source: "breakdown", trade: "general",
    title: "Block C roof gutter replacement",
    description: "Downpipes detached on the 3rd-floor run; water sheeting over the stairwell.",
    status: "assigned", priority: "high", reporter: barbara.id, requiresPermit: true, created: daysAgo(1),
  });

  // ------------------------------------------------------------------
  // Notifications — populated feed for the demo staff + a tenant.
  // ------------------------------------------------------------------
  await notify(eric.id, "work_order_created", "Work order opened: Standby generator G-1 not starting",
    "electrical · priority normal", "work_order", gensetWo.id);
  await notify(wilfred.id, "work_order_assigned", "Assigned to you: Borehole pump pressure check",
    "plumbing · priority normal", "work_order", pumpCheck.id);
  await notify(doreen.id, "work_order_completed", "Completed: Blocked kitchen drain — Unit A102",
    "Closed as done", "work_order", drainWo.id);
  await notify(fred.id, "work_order_created", "Work order opened: Leaking tap — Unit A101",
    "plumbing · priority high", "work_order", leakingTap.id);
  await notify(alex.id, "work_order_created", "Work order opened: Shop S203 strip lights flickering on generator",
    "electrical · priority high", "work_order", mallLightsWo.id);

  // ------------------------------------------------------------------
  // Quotes on the open leaking-tap job — in-house crew wins.
  // ------------------------------------------------------------------
  await query(
    `INSERT INTO quotes (organization_id, supplier_id, work_order_id, amount, currency, note, status)
     VALUES ($1,$2,$3,4500,'KES','Labour + washer kit','submitted')`,
    [orgId, inHousePlumbing.id, leakingTap.id]
  );
  await query(
    `INSERT INTO quotes (organization_id, supplier_id, work_order_id, amount, currency, note, status)
     VALUES ($1,$2,$3,6200,'KES','Includes call-out','submitted')`,
    [orgId, (await query(`SELECT id FROM suppliers WHERE organization_id = $1 AND name = 'DrainPro Plumbing & Drainage'`, [orgId])).rows[0].id, leakingTap.id]
  );
  await query(
    `UPDATE quotes SET status = 'accepted'
     WHERE organization_id = $1 AND supplier_id = $2 AND work_order_id = $3`,
    [orgId, inHousePlumbing.id, leakingTap.id]
  );
  await query(
    `UPDATE work_orders SET assigned_supplier_id = $1 WHERE id = $2`,
    [inHousePlumbing.id, leakingTap.id]
  );

  // ------------------------------------------------------------------
  // Compliance & safety — one live permit (the roof job really is at
  // height), an expired competency, an overdue statutory inspection.
  // ------------------------------------------------------------------
  await query(
    `INSERT INTO permits (organization_id, work_order_id, type, status, issued_by, issued_at, expires_at, notes)
     VALUES ($1,$2,'working_at_height','issued',$3,now() - interval '1 day', now() + interval '5 days',
             'Roof works on 3rd-floor Block C — safety harness + guardrail required')`,
    [orgId, gutterWo.id, eric.id]
  );
  await query(
    `INSERT INTO competencies (organization_id, user_id, name, trade, expires_at, issued_by)
     VALUES ($1,$2,'Electrical LV (authorised)','electrical',now() - interval '30 days',$3)`,
    [orgId, james.id, eric.id]
  );
  await query(
    `INSERT INTO competencies (organization_id, user_id, name, trade, expires_at, issued_by)
     VALUES ($1,$2,'Working at height','general',now() + interval '6 months',$3)`,
    [orgId, james.id, eric.id]
  );
  await query(
    `INSERT INTO competencies (organization_id, user_id, name, trade, expires_at, issued_by)
     VALUES ($1,$2,'Chemical handling (COSHH)','janitorial',now() + interval '4 months',$3)`,
    [orgId, petronilah.id, barbara.id]
  );
  await query(
    `INSERT INTO statutory_inspections (organization_id, asset_id, requirement, frequency_days, last_done_at, due_date, notes)
     VALUES ($1,$2,'Generator annual inspection (NEMA / noise compliance)',365,now() - interval '400 days',now() - interval '35 days',
             'Inspection overdue — certificate expired')`,
    [orgId, genset.id]
  );
  await query(
    `INSERT INTO statutory_inspections (organization_id, requirement, frequency_days, due_date, notes)
     VALUES ($1,'Fire extinguisher annual inspection',365,now() + interval '200 days',
             'All 24 units across Phases 1 and 2 must be checked')`,
    [orgId]
  );

  // ------------------------------------------------------------------
  // Meter history for the borehole pump — readings grow forward so the
  // trend engine projects the 50,000-hour overhaul threshold.
  // ------------------------------------------------------------------
  await query(
    `INSERT INTO meter_readings (asset_id, reading_value, reading_unit, recorded_at, cost)
     SELECT $1, v, 'hours', now() - ((50000 - v) / 100) * interval '1 day', NULL
     FROM (VALUES (47500),(47800),(48000),(48250),(48650)) AS t(v)`,
    [borehole.id]
  );
  await query(
    `INSERT INTO meter_readings (asset_id, reading_value, reading_unit, recorded_at, cost)
     SELECT $1, v, 'hours', now() - ((22000 - v) / 50) * interval '1 day', NULL
     FROM (VALUES (21700),(21800),(21850),(21900)) AS t(v)`,
    [acaciaBorehole.id]
  );

  // ------------------------------------------------------------------
  // Inventory — spares for the Greatwall estate store. Two items sit at
  // or below their reorder point so low-stock views have signal.
  // ------------------------------------------------------------------
  const valveItem = (await query(
    `INSERT INTO inventory_items (organization_id, name, trade, unit, quantity_on_hand, reorder_threshold, warehouse_location)
     VALUES ($1,'Flapper valve 20mm','plumbing','pcs',6,3,'Rack 1, Greatwall store') RETURNING id`,
    [orgId]
  )).rows[0];
  await query(
    `INSERT INTO inventory_items (organization_id, name, trade, unit, quantity_on_hand, reorder_threshold, warehouse_location)
     VALUES ($1,'Tap washer 20mm','plumbing','pcs',20,10,'Rack 1, Greatwall store')`,
    [orgId]
  );
  await query(
    `INSERT INTO inventory_items (organization_id, name, trade, unit, quantity_on_hand, reorder_threshold, warehouse_location)
     VALUES ($1,'Grease NLGI-2 500g','general','pcs',2,5,'Rack 2, Greatwall store')`,
    [orgId]
  );
  await query(
    `INSERT INTO inventory_items (organization_id, name, trade, unit, quantity_on_hand, reorder_threshold, warehouse_location)
     VALUES ($1,'Engine oil 5L','general','pcs',3,4,'Rack 2, Greatwall store')`,
    [orgId]
  );
  await query(
    `INSERT INTO inventory_items (organization_id, name, trade, unit, quantity_on_hand, reorder_threshold, warehouse_location)
     VALUES ($1,'Diesel 5L jerrycan','electrical','pcs',8,4,'Genset room, Phase 1')`,
    [orgId]
  );
  await query(
    `INSERT INTO inventory_items (organization_id, name, trade, unit, quantity_on_hand, reorder_threshold, warehouse_location)
     VALUES ($1,'Weed killer 1L','gardening','pcs',10,5,'Rack 3, Greatwall store')`,
    [orgId]
  );

  // Movement history so the activity trail has context.
  await query(
    `INSERT INTO inventory_movements (inventory_item_id, work_order_id, quantity_change, reason)
     SELECT $1, id, -1, 'Consumed on "' || title || '"' FROM work_orders
     WHERE organization_id = $2 AND title = 'Blocked kitchen drain — Unit A102'`,
    [valveItem.id, orgId]
  );

  // ------------------------------------------------------------------
  // Contracts — Athi Power sits inside its renewal window so the
  // dashboard's contract alert fires; linked POs drive spend tracking.
  // ------------------------------------------------------------------
  const contractEnd = daysFromNow(10).slice(0, 10);
  const athiContract = (await query(
    `INSERT INTO contracts (organization_id, contract_number, supplier_id, property_id, contract_type, status, start_date, end_date, annual_value, renewal_notice_days, notes)
     VALUES ($1,'CTR-2026-0001',$2,$3,'service',$4,'2025-03-01',$5,1200000,30,
             'Electrical maintenance, emergency callouts and switchboard works for Greatwall Gardens Estate.')
     RETURNING id`,
    [orgId, athiPower.id, greatwall.id,
     effectiveContractStatus({ end_date: contractEnd, renewal_notice_days: 30, status: "active" }),
     contractEnd]
  )).rows[0];
  await query(
    `INSERT INTO contracts (organization_id, contract_number, supplier_id, property_id, contract_type, status, start_date, end_date, annual_value, renewal_notice_days, notes)
     VALUES ($1,'CTR-2026-0002',$2,NULL,'service','active','2025-01-01','2027-01-01',800000,30,
             'In-house plumbing and drainage maintenance across the portfolio.')
     RETURNING id`,
    [orgId, inHousePlumbing.id]
  );
  await query(
    `INSERT INTO contracts (organization_id, contract_number, supplier_id, property_id, contract_type, status, start_date, end_date, annual_value, renewal_notice_days, notes)
     VALUES ($1,'CTR-2026-0003',$2,$3,'service','active','2026-01-01','2026-12-31',480000,30,
             'Landscaping and irrigation upkeep for Greatwall Gardens common areas.')
     RETURNING id`,
    [orgId, greenScape.id, greatwall.id]
  );

  // ------------------------------------------------------------------
  // Purchase orders committed against the Athi Power contract.
  // ------------------------------------------------------------------
  const engineOil = (await query(`SELECT id FROM inventory_items WHERE organization_id = $1 AND name = 'Engine oil 5L'`, [orgId])).rows[0];
  const grease = (await query(`SELECT id FROM inventory_items WHERE organization_id = $1 AND name = 'Grease NLGI-2 500g'`, [orgId])).rows[0];
  const weedKiller = (await query(`SELECT id FROM inventory_items WHERE organization_id = $1 AND name = 'Weed killer 1L'`, [orgId])).rows[0];
  const po1 = (await query(
    `INSERT INTO purchase_orders (organization_id, po_number, supplier_id, contract_id, status, ordered_by_user_id, approved_by_user_id, approved_at, notes)
     VALUES ($1,'PO-2026-0001',$2,$3,'approved',$4,$4,now(),'Q2 electrical spares under service contract')
     RETURNING id`,
    [orgId, athiPower.id, athiContract.id, eric.id]
  )).rows[0];
  const po2 = (await query(
    `INSERT INTO purchase_orders (organization_id, po_number, supplier_id, contract_id, status, ordered_by_user_id, expected_date, notes)
     VALUES ($1,'PO-2026-0002',$2,$3,'received',$4,CURRENT_DATE - interval '3 days','Contract restock — delivered to Greatwall store')
     RETURNING id`,
    [orgId, athiPower.id, athiContract.id, eric.id]
  )).rows[0];
  const po3 = (await query(
    `INSERT INTO purchase_orders (organization_id, po_number, supplier_id, contract_id, status, ordered_by_user_id, expected_date, notes)
     VALUES ($1,'PO-2026-0003',$2,$3,'submitted',$4,CURRENT_DATE + interval '7 days','Landscaping chemical restock')
     RETURNING id`,
    [orgId, greenScape.id, (await query(`SELECT id FROM contracts WHERE organization_id = $1 AND contract_number = 'CTR-2026-0003'`, [orgId])).rows[0].id, eric.id]
  )).rows[0];
  await query(
    `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, quantity, unit_cost, received_qty)
     VALUES ($1,$2,100,8500,0)`,
    [po1.id, engineOil.id]
  );
  await query(
    `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, quantity, unit_cost, received_qty)
     VALUES ($1,$2,40,5000,40)`,
    [po2.id, grease.id]
  );
  await query(
    `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, quantity, unit_cost, received_qty)
     VALUES ($1,$2,20,1300,0)`,
    [po3.id, weedKiller.id]
  );

  // ------------------------------------------------------------------
  // Invoices — the Fixflo-inspired closeout trail, pre-seeded so the
  // Invoices screen has one paid, one issued and one draft to demo.
  // ------------------------------------------------------------------
  await query(
    `INSERT INTO invoices (organization_id, invoice_number, work_order_id, supplier_id, amount, currency, parts_cost, quote_amount, status, issued_at, paid_at)
     VALUES ($1,'INV-2026-0001',$2,$3,18000,'KES',0,18000,'paid',now() - interval '1 day',now())
     ON CONFLICT DO NOTHING`,
    [orgId, gensetService.id, athiPower.id]
  );
  await query(
    `INSERT INTO invoices (organization_id, invoice_number, work_order_id, supplier_id, amount, currency, parts_cost, quote_amount, status, issued_at)
     VALUES ($1,'INV-2026-0002',$2,$3,4500,'KES',4500,NULL,'issued',now() - interval '2 days')
     ON CONFLICT DO NOTHING`,
    [orgId, drainWo.id, inHousePlumbing.id]
  );
  await query(
    `INSERT INTO invoices (organization_id, invoice_number, work_order_id, supplier_id, amount, currency, parts_cost, quote_amount, status)
     VALUES ($1,'INV-2026-0003',$2,NULL,2500,'KES',2500,NULL,'draft')
     ON CONFLICT DO NOTHING`,
    [orgId, lobbyWo.id]
  );

  // ------------------------------------------------------------------
  // Budgets — annual budget lines per trade, pre-seeded so the Budgets
  // screen has realistic data on first load.
  // ------------------------------------------------------------------
  await query(
    `INSERT INTO budgets (organization_id, name, trade, property_id, fiscal_year, planned_amount, notes)
     VALUES
       ($1,'Greatwall Plumbing Annual','plumbing',(SELECT id FROM properties WHERE organization_id=$1 AND name LIKE '%Greatwall%' LIMIT 1),2026,800000,'Covers borehole, pipes, taps'),
       ($1,'Portfolio Electrical','electrical',NULL,2026,1200000,'All properties - generator, solar, CCTV'),
       ($1,'Acacia HVAC','hvac',(SELECT id FROM properties WHERE organization_id=$1 AND name LIKE '%Acacia%' LIMIT 1),2026,500000,'AHU servicing and refrigerant'),
       ($1,'Greatwall Gardening','gardening',(SELECT id FROM properties WHERE organization_id=$1 AND name LIKE '%Greatwall%' LIMIT 1),2026,350000,'Landscaping and irrigation'),
       ($1,'Portfolio Janitorial','janitorial',NULL,2026,600000,'Deep clean and daily maintenance'),
       ($1,'Corporate Centre Security','security',(SELECT id FROM properties WHERE organization_id=$1 AND name LIKE '%Corporate%' LIMIT 1),2026,400000,'CCTV, access control, guards')
     ON CONFLICT DO NOTHING`,
    [orgId]
  );

  const counts = [];
  for (const [table, where] of [
    ["users", `organization_id = $1`],
    ["properties", `organization_id = $1`],
    ["buildings", `property_id IN (SELECT id FROM properties WHERE organization_id = $1)`],
    ["floors", `building_id IN (SELECT b.id FROM buildings b JOIN properties p ON p.id = b.property_id WHERE p.organization_id = $1)`],
    ["rooms", `floor_id IN (SELECT f.id FROM floors f JOIN buildings b ON b.id = f.building_id JOIN properties p ON p.id = b.property_id WHERE p.organization_id = $1)`],
    ["assets", `organization_id = $1`],
    ["suppliers", `organization_id = $1`],
    ["maintenance_plans", `organization_id = $1`],
    ["work_orders", `organization_id = $1`],
    ["notifications", `organization_id = $1`],
    ["quotes", `organization_id = $1`],
    ["invoices", `organization_id = $1`],
    ["meter_readings", `asset_id IN (SELECT id FROM assets WHERE organization_id = $1)`],
    ["inventory_items", `organization_id = $1`],
    ["inventory_movements", `inventory_item_id IN (SELECT id FROM inventory_items WHERE organization_id = $1)`],
    ["contracts", `organization_id = $1`],
    ["purchase_orders", `organization_id = $1`],
    ["purchase_order_items", `purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id = $1)`],
    ["permits", `organization_id = $1`],
    ["competencies", `organization_id = $1`],
    ["statutory_inspections", `organization_id = $1`],
    ["budgets", `organization_id = $1`],
  ]) {
    const { rows } = await query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, [orgId]);
    counts.push({ table, n: rows[0].n });
  }

  console.log("\nSeeded. Demo login (all share the password below):");
  console.log("  password facilix-demo");
  console.log(`\norg: ${ORG_NAME} (${orgId})`);
  for (const c of counts) console.log(`  ${c.table}: ${c.n}`);

  console.log("\nKey logins (all password facilix-demo):");
  console.log("  eric.newborn@denvic.co.ke   admin  (overall)");
  console.log("  dennis.mafuta@denvic.co.ke  admin");
  console.log("  victor.odero@denvic.co.ke   admin");
  console.log("  barbara.noel@denvic.co.ke   manager");
  console.log("  zablon.ochola@denvic.co.ke  manager");
  console.log("  michael.aketch@denvic.co.ke manager");
  console.log("  wilfred.rumoine@denvic.co.ke technician (plumbing) — sees only his jobs");
  console.log("  james.munene@denvic.co.ke   technician (electrical) — sees only his jobs");
  console.log("  peter.tindi@denvic.co.ke    technician (gardening) — sees only his jobs");
  console.log("  petronilah@denvic.co.ke     technician (janitorial) — sees only her jobs");
  console.log("  fred.muka@gmail.com         tenant (Unit A101)");
  console.log("  charles.mbugua@yahoo.com    tenant (Unit C622)");
  console.log("  rachael.mwangi@gmail.com    tenant (Unit E832)");
  console.log("  alex.muthoka@gmail.com      tenant (Greatwall Gardens Mall, Shop S203)");
  console.log("  joseph.muriuki@gmail.com    supplier portal (in-house plumbing crew)");

  await pool.end();
}

seed().catch(async (err) => {
  console.error("Seed failed:", err);
  await pool.end();
  process.exit(1);
});
