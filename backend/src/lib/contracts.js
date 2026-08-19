// Pure helpers for supplier contracts — status derivation, expiry math, and
// the org-scoped numbering scheme. Kept framework-free so they can be unit
// tested in isolation and shared by the API routes, the daily scheduler, and
// the notifications layer without import cycles.

export const CONTRACT_TYPES = ["utility", "rental", "sale", "service"];

const DAY_MS = 86_400_000;

function dateKey(value) {
  const d = value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Whole days from `today` until end_date (positive = still in the future,
// negative = already past). null when the contract has no end date.
export function daysToExpiry(contract, today = new Date()) {
  if (!contract.end_date) return null;
  return Math.round((dateKey(contract.end_date) - dateKey(today)) / DAY_MS);
}

// The live status for a contract:
//   terminated  — admin closed it out; terminal state, never re-derived
//   expired     — end_date is behind today
//   expiring    — within the renewal_notice_days window of end_date
//   active      — everything else (including open-ended contracts)
export function effectiveContractStatus(contract, today = new Date()) {
  if (contract.status === "terminated") return "terminated";
  const days = daysToExpiry(contract, today);
  if (days === null) return "active";
  if (days < 0) return "expired";
  if (days <= (contract.renewal_notice_days ?? 30)) return "expiring";
  return "active";
}

// Next contract number for the org: 'CTR-<year>-<next>' where <next> never
// reuses a number (max suffix + 1), mirroring the PO numbering scheme.
export function nextContractNumber(rows) {
  const year = new Date().getFullYear();
  const maxSeq = rows.length
    ? Math.max(
        ...rows.map((r) => {
          const m = /^CTR-\d{4}-(\d+)$/.exec(r.contract_number ?? "");
          return m ? Number(m[1]) : 0;
        })
      )
    : 0;
  return `CTR-${year}-${String(maxSeq + 1).padStart(4, "0")}`;
}
