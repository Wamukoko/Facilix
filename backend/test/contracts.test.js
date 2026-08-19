import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveContractStatus, daysToExpiry, nextContractNumber } from "../src/lib/contracts.js";

// Fixed "today" so the date-relative assertions stay deterministic.
const TODAY = new Date("2026-08-15T12:00:00Z");

test("effectiveContractStatus stays active inside the term, outside the notice window", () => {
  const c = { status: "active", end_date: "2026-12-31", renewal_notice_days: 30 };
  assert.equal(effectiveContractStatus(c, TODAY), "active");
});

test("effectiveContractStatus flags contracts inside the renewal window", () => {
  const c = { status: "active", end_date: "2026-08-25", renewal_notice_days: 30 };
  assert.equal(effectiveContractStatus(c, TODAY), "expiring");
});

test("effectiveContractStatus treats the notice-day boundary as expiring", () => {
  const c = { status: "active", end_date: "2026-09-14", renewal_notice_days: 30 };
  assert.equal(effectiveContractStatus(c, TODAY), "expiring");
});

test("effectiveContractStatus flags contracts past their end date", () => {
  const c = { status: "active", end_date: "2026-08-14", renewal_notice_days: 30 };
  assert.equal(effectiveContractStatus(c, TODAY), "expired");
});

test("effectiveContractStatus stays active for open-ended contracts", () => {
  const c = { status: "active", end_date: null, renewal_notice_days: 30 };
  assert.equal(effectiveContractStatus(c, TODAY), "active");
});

test("effectiveContractStatus is terminal once terminated", () => {
  const c = { status: "terminated", end_date: "2025-01-01", renewal_notice_days: 30 };
  assert.equal(effectiveContractStatus(c, TODAY), "terminated");
});

test("effectiveContractStatus defaults the notice window when unset", () => {
  const c = { status: "active", end_date: "2026-08-25" };
  assert.equal(effectiveContractStatus(c, TODAY), "expiring");
});

test("effectiveContractStatus accepts Date objects for end_date", () => {
  const c = { status: "active", end_date: new Date("2026-08-14T00:00:00Z"), renewal_notice_days: 30 };
  assert.equal(effectiveContractStatus(c, TODAY), "expired");
});

test("daysToExpiry is the whole-day distance to end_date", () => {
  assert.equal(daysToExpiry({ end_date: "2026-08-25" }, TODAY), 10);
  assert.equal(daysToExpiry({ end_date: "2026-08-14" }, TODAY), -1);
  assert.equal(daysToExpiry({ end_date: null }, TODAY), null);
});

test("nextContractNumber continues the sequence for the current year", () => {
  const rows = [
    { contract_number: "CTR-2026-0001" },
    { contract_number: "CTR-2026-0007" },
    { contract_number: "CTR-2025-0099" },
  ];
  assert.equal(nextContractNumber(rows), `CTR-${new Date().getFullYear()}-0100`);
});

test("nextContractNumber starts at 0001 with no existing contracts", () => {
  assert.equal(nextContractNumber([]), `CTR-${new Date().getFullYear()}-0001`);
});

test("nextContractNumber ignores malformed numbers", () => {
  const rows = [{ contract_number: "PO-2026-0001" }, { contract_number: null }];
  assert.equal(nextContractNumber(rows), `CTR-${new Date().getFullYear()}-0001`);
});
