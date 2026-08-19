import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

// Reads DATABASE_URL from .env, e.g.:
// DATABASE_URL=postgres://user:password@localhost:5432/facilix
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err);
  process.exit(1);
});

// Every table has organization_id — enforce it's always in scope.
// req.orgId is set by the auth middleware after verifying the JWT.
export async function query(text, params) {
  return pool.query(text, params);
}

// Runs fn(client) inside a single pooled connection transaction.
// The pool's query() picks a random client per call, so multi-statement
// transactions MUST go through here — BEGIN/COMMIT must share a client.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
