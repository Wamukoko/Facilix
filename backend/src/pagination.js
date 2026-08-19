// Shared pagination helpers for list endpoints.
// Routes use `LIMIT $n OFFSET $m` plus `count(*) OVER() AS total` so the
// total row count comes back in the same query as the page.

export function parsePaging(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limitRaw = Number(query.limit);
  const offsetRaw = Number(query.offset);

  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, maxLimit) : defaultLimit;
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  return { limit, offset };
}

// Envelope: { data: [...rows], meta: { total, limit, offset } }
// total is read from the window function on the first row (0 when no rows).
export function pagedResponse(rows, { limit, offset }) {
  const total = rows.length ? Number(rows[0].total) : 0;
  const data = rows.map(({ total: _total, ...row }) => row);
  return { data, meta: { total, limit, offset } };
}
