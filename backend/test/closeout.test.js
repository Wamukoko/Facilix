import { test } from "node:test";
import assert from "node:assert/strict";
import { isVagueCloseout, normalizeText, closeoutProblems } from "../src/closeout.js";

test("normalizeText strips punctuation, collapses whitespace, lowercases", () => {
  assert.equal(normalizeText("  Seal  Worn - REPLACED. "), "seal worn replaced");
});

test("isVagueCloseout flags empty and blank answers", () => {
  assert.equal(isVagueCloseout(""), true);
  assert.equal(isVagueCloseout("   "), true);
  assert.equal(isVagueCloseout(null), true);
  assert.equal(isVagueCloseout(undefined), true);
});

test("isVagueCloseout rejects throwaway phrases regardless of case/punctuation", () => {
  for (const phrase of ["fixed", "Fixed.", "all fixed", "repaired", "done", "n/a", "none", "nothing", "no fault found", "other", "as above"]) {
    assert.equal(isVagueCloseout(phrase), true, `expected "${phrase}" to be vague`);
  }
});

test("isVagueCloseout accepts concrete answers", () => {
  assert.equal(isVagueCloseout("Seal worn through — replaced 20mm washer and retightened union"), false);
  assert.equal(isVagueCloseout("Overheated pump, bearings gone, installed new bearing set"), false);
  assert.equal(isVagueCloseout("Clogged drain cleared with auger; flushed hot water"), false);
});

test("closeoutProblems requires a failure code when closing", () => {
  const problems = closeoutProblems({ root_cause: "Seal worn through", remedy: "Replaced washer" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /failure code/);
});

test("closeoutProblems flags vague root_cause and remedy", () => {
  const problems = closeoutProblems({ failure_code: "leak", root_cause: "fixed", remedy: "done" });
  assert.equal(problems.length, 2);
});

test("closeoutProblems returns no problems for a structured closeout", () => {
  const problems = closeoutProblems({
    failure_code: "leak",
    root_cause: "Seal worn through at the union joint",
    remedy: "Replaced the 20mm washer and retightened the union",
  });
  assert.deepEqual(problems, []);
});

test("closeoutProblems is tolerant of a missing failure_code message mentioning status", () => {
  const problems = closeoutProblems({}, "verified");
  assert.match(problems[0], /verified/);
});
