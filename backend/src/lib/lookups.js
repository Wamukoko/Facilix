import { query } from "../db.js";
import { ApiError } from "../middleware/errors.js";

// Org-scoped lookup tables for the configurable vocabulary (trades, asset
// types). Values stored as TEXT are validated against these before use, so an
// org can add its own vocabulary at runtime without a schema migration.

export const TABLE_NAME = { trade: "trades", asset_type: "asset_types" };

// Fails with a 400 if `value` is not an active entry in the org's lookup table.
export async function assertLookup(orgId, table, value, label) {
  if (!value) return;
  const { rows } = await query(
    `SELECT 1 FROM ${table} WHERE organization_id = $1 AND value = $2 AND active = true`,
    [orgId, value]
  );
  if (rows.length === 0) {
    throw new ApiError(400, `${label} "${value}" is not a configured option`);
  }
}

export async function assertTrade(orgId, value) {
  await assertLookup(orgId, "trades", value, "Trade");
}

export async function assertAssetType(orgId, value) {
  await assertLookup(orgId, "asset_types", value, "Asset type");
}

// Seeds the default vocabulary for a brand-new organization (used at signup).
export async function seedDefaultLookups(client, orgId) {
  const defaults = {
    trades: [
      ["plumbing", "Plumbing"],
      ["electrical", "Electrical"],
      ["gardening", "Gardening"],
      ["janitorial", "Janitorial"],
      ["hvac", "HVAC"],
      ["carpentry", "Carpentry"],
      ["masonry", "Masonry"],
      ["painting", "Painting"],
      ["security", "Security"],
      ["general", "General"],
    ],
    asset_types: [
      ["electrical", "Electrical"],
      ["plumbing", "Plumbing"],
      ["hvac", "HVAC"],
      ["safety", "Safety"],
      ["telecom", "Telecom"],
      ["it", "IT"],
      ["conveyor", "Conveyor"],
      ["green_area", "Green area"],
      ["furniture", "Furniture"],
      ["janitorial_equipment", "Janitorial equipment"],
      ["external_infrastructure", "External infrastructure"],
      ["other", "Other"],
    ],
  };

  for (const [table, entries] of Object.entries(defaults)) {
    for (const [value, label] of entries) {
      await client.query(
        `INSERT INTO ${table} (organization_id, value, label)
         VALUES ($1, $2, $3) ON CONFLICT (organization_id, value) DO NOTHING`,
        [orgId, value, label]
      );
    }
  }
}
