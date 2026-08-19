// Phase 8 — closeout discipline. Pure helpers that keep work-order closeouts
// structured instead of "fixed". Extracted so the vague-text rules are unit
// testable without a database.

// Normalize a free-text answer for comparison: lowercase, collapse whitespace,
// and drop punctuation so "Fixed." and "fixed" compare equal.
export function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Entries that count as "no real answer" — the maintenance-wide problem the
// gap analysis calls out (UpKeep's own research: skipped documentation,
// untrusted reporting). Matching is on the normalized string.
const VAGUE_ENTRIES = new Set([
  "fixed",
  "fixed it",
  "all fixed",
  "repaired",
  "resolved",
  "solved",
  "done",
  "done it",
  "n a",
  "none",
  "nothing",
  "nothing to do",
  "no issue",
  "no issue found",
  "no fault",
  "no fault found",
  "other",
  "misc",
  "as above",
  "same as above",
]);

// A closeout answer is "vague" when it's empty or collapses to one of the
// throwaway phrases above.
export function isVagueCloseout(value) {
  if (typeof value !== "string" || value.trim() === "") return true;
  return VAGUE_ENTRIES.has(normalizeText(value));
}

// Returns a list of human-readable problems (empty when the closeout is valid).
// `fields` may contain failure_code / root_cause / remedy — each is checked.
// `closingStatus` names the transition for the error message.
export function closeoutProblems(fields = {}, closingStatus = "done") {
  const problems = [];
  if (!fields.failure_code) {
    problems.push(`a failure code is required to close a work order (status: ${closingStatus})`);
  }
  if (isVagueCloseout(fields.root_cause)) {
    problems.push('root_cause: describe what actually failed (e.g. "seal worn through — replaced")');
  }
  if (isVagueCloseout(fields.remedy)) {
    problems.push('remedy: describe the fix performed (e.g. "replaced 20mm washer, tightened union")');
  }
  return problems;
}

// Same discipline applied to cancellations: "cancel" / "no reason" is rejected
// so the audit trail records why the work was pulled, not just that it was.
export function cancellationProblems(reason) {
  if (isVagueCloseout(reason)) {
    return ['cancellation_reason: describe why this work order is being cancelled (e.g. "tenant no longer wants the work" or "duplicate of WO-1042")'];
  }
  return [];
}
