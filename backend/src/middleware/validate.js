import { z } from "zod";

// Middleware factory: validate an incoming request against a zod schema and
// replace the raw value with the parsed (stripped/coerced) result. On failure
// it throws a ZodError, which the errorHandler middleware turns into a 400.
// Defaults to validating req.body — pass "query" or "params" to validate those.
export function validate(schema, source = "body") {
  return (req, res, next) => {
    try {
      req[source] = schema.parse(req[source]);
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Field helpers reused across route schemas.

export const uuid = z.string().uuid("expected a valid UUID");

// Trades and asset types are runtime-configurable per org (see /api/config),
// so these only check shape; membership in the org's vocabulary is enforced by
// assertTrade/assertAssetType in lib/lookups.js.
export const trade = z.string().trim().min(1, "trade is required").max(40);

export const assetType = z.string().trim().min(1, "type is required").max(40);

export const assetStatus = z.enum(["active", "retired", "under_repair"]);

export const woStatus = z.enum([
  "open", "assigned", "in_progress", "done", "verified", "cancelled",
]);

export const woPriority = z.enum(["low", "normal", "high", "urgent"]);

export const woSource = z.enum(["plan", "breakdown", "tenant_request"]);

export const failureCode = z.enum([
  "wear_and_tear", "corrosion", "lubrication", "blockage", "leak",
  "electrical_fault", "overload", "foreign_object", "operator_error",
  "installation_error", "manufacturer_defect", "water_damage",
  "no_fault_found", "other",
]);

export const triggerType = z.enum(["scheduled", "meter_based", "on_demand"]);

export const userRole = z.enum(["admin", "manager", "technician", "tenant"]);
