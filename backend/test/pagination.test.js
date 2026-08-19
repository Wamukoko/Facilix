import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePaging, pagedResponse } from "../src/pagination.js";

test("parsePaging defaults when nothing is provided", () => {
  assert.deepEqual(parsePaging({}), { limit: 50, offset: 0 });
});

test("parsePaging caps the limit at the configured maximum", () => {
  assert.deepEqual(parsePaging({ limit: "9999" }), { limit: 200, offset: 0 });
});

test("parsePaging ignores garbage / negative input", () => {
  assert.deepEqual(parsePaging({ limit: "abc", offset: "-3" }), { limit: 50, offset: 0 });
});

test("parsePaging honors valid limit/offset", () => {
  assert.deepEqual(parsePaging({ limit: "10", offset: "40" }), { limit: 10, offset: 40 });
});

test("parsePaging accepts custom defaults", () => {
  assert.deepEqual(parsePaging({}, { defaultLimit: 25, maxLimit: 100 }), { limit: 25, offset: 0 });
});

test("pagedResponse strips the total column and reports meta", () => {
  const rows = [{ id: 1, total: "42" }, { id: 2, total: "42" }];
  assert.deepEqual(pagedResponse(rows, { limit: 10, offset: 0 }), {
    data: [{ id: 1 }, { id: 2 }],
    meta: { total: 42, limit: 10, offset: 0 },
  });
});

test("pagedResponse handles an empty page", () => {
  assert.deepEqual(pagedResponse([], { limit: 10, offset: 0 }), {
    data: [],
    meta: { total: 0, limit: 10, offset: 0 },
  });
});
