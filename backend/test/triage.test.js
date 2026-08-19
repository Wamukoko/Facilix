import { test } from "node:test";
import assert from "node:assert/strict";
import { triageRequest, TRIAGE_TRADES } from "../src/triage.js";

test("triage: empty input returns nulls", () => {
  const r = triageRequest({});
  assert.equal(r.trade, null);
  assert.equal(r.priority, null);
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.matched, []);
});

test("triage: plumbing keywords map to plumbing", () => {
  const r = triageRequest({ title: "Bathroom tap won't stop dripping", description: "water leaking under the sink since yesterday" });
  assert.equal(r.trade, "plumbing");
  assert.ok(r.confidence >= 0.5, `confidence ${r.confidence}`);
  assert.ok(r.matched.includes("dripping"));
});

test("triage: electrical keywords map to electrical", () => {
  const r = triageRequest({ title: "No power in unit 4B", description: "breaker keeps tripping, socket sparked" });
  assert.equal(r.trade, "electrical");
});

test("triage: security keywords map to security", () => {
  const r = triageRequest({ title: "Gate keypad broken", description: "can't get in, intercom dead" });
  assert.equal(r.trade, "security");
});

test("triage: hvac maps to hvac", () => {
  const r = triageRequest({ title: "Air conditioning not cooling", description: "compressor fan is dead" });
  assert.equal(r.trade, "hvac");
});

test("triage: hazard text escalates urgency", () => {
  const flood = triageRequest({ title: "Burst pipe flooding the corridor" });
  assert.equal(flood.priority, "urgent");
  const leak = triageRequest({ title: "Slow dripping tap" });
  assert.equal(leak.priority, "high");
  const cosmetic = triageRequest({ title: "Peeling paint looks cosmetic" });
  assert.equal(cosmetic.priority, "low");
});

test("triage: unrelated text returns nulls", () => {
  const r = triageRequest({ title: "hello there", description: "just checking" });
  assert.equal(r.trade, null);
  assert.equal(r.priority, null);
});

test("triage: suggestions only ever use known trades", () => {
  for (const text of ["leak pipe", "socket spark", "grass overgrown", "rubbish spill", "door lock"]) {
    const r = triageRequest({ title: text });
    assert.ok(r.trade === null || TRIAGE_TRADES.includes(r.trade), `trade ${r.trade} from "${text}"`);
  }
});

test("triage: strongest trade wins on ambiguity", () => {
  const r = triageRequest({ title: "Water dripping from the ceiling by the light fixture" });
  assert.equal(r.trade, "plumbing");
});

test("triage: no single word is required to be present", () => {
  const r = triageRequest({ title: "The ensuite shower drains slowly" });
  assert.equal(r.trade, "plumbing");
});
