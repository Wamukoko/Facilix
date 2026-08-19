import { query } from "./db.js";

// Runtime feature detection. PostGIS is optional locally (Docker always ships
// it), so routes that touch geography pick their SQL based on this flag.
// The check runs once and is cached for the process lifetime.

let cache = null;

export async function getCapabilities() {
  if (cache) return cache;
  const { rows } = await query(
    `SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') AS available`
  );
  cache = { postgis: Boolean(rows[0]?.available) };
  return cache;
}
