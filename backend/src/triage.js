// Deterministic AI-triage engine for resident requests (Phase 4). A small
// keyword/hazard classifier that suggests a trade and an urgency from free
// text so a "one-minute request" lands on the right board lane. Kept as a
// pure module — no DB, no I/O — so it unit-tests in isolation and can later
// be swapped for a hosted model behind the same `triageRequest()` signature.
//
//   triageRequest({ title, description })
//   → { trade, priority, confidence, matched, label }   (nulls when nothing matches)

// Trades the engine can suggest. Mirrors the default vocabulary; the route
// validates the suggestion against the org's configured options before
// returning it, so a custom vocabulary degrades gracefully.
export const TRIAGE_TRADES = [
  "plumbing",
  "electrical",
  "hvac",
  "security",
  "janitorial",
  "gardening",
  "carpentry",
  "masonry",
  "painting",
];

// Keyword → weight (3 = strongly diagnostic, 1 = weak hint). Phrases are
// matched as substrings; single words with word boundaries.
const RULES = {
  plumbing: {
    "leak": 3, "dripping": 3, "drips": 3, "faucet": 3, "toilet": 3, "cistern": 3,
    "pipe": 3, "pipes": 3, "drain": 2, "drainage": 2, "blocked": 2, "clogged": 2,
    "clog": 2, "plumbing": 3, "plumber": 3, "burst": 3, "sewage": 3, "boiler": 3,
    "sink": 2, "shower": 2, "bath": 1, "tap": 2, "taps": 2, "water": 1, "flush": 2,
    "basin": 2, "gutter": 2, "dripping tap": 3, "running water": 2,
  },
  electrical: {
    "electric": 3, "electrical": 3, "electricity": 3, "socket": 2, "outlet": 2,
    "wiring": 3, "fuse": 3, "breaker": 3, "tripping": 3, "tripped": 3, "spark": 3,
    "sparks": 3, "shock": 3, "short circuit": 3, "circuit": 3, "switch": 2,
    "flickering": 2, "flicker": 2, "power": 1, "lights": 2, "light": 1, "bulb": 2,
    "panel": 2, "charger": 1, "no power": 3, "power cut": 3, "power outage": 3,
  },
  hvac: {
    "air conditioning": 3, "ac ": 3, "hvac": 3, "heating": 3, "heater": 3,
    "cooling": 3, "aircon": 3, "thermostat": 3, "compressor": 3, "ventilation": 2,
    "air vent": 2, "fan": 2, "warm": 1, "cold room": 2, "not cooling": 3, "not heating": 3,
  },
  security: {
    "lock": 2, "locked": 2, "key": 2, "keypad": 3, "camera": 2, "cctv": 3,
    "gate": 2, "door": 1, "intercom": 3, "alarm": 3, "buzzer": 2, "security": 3,
    "broken lock": 3, "key stuck": 2, "fob": 2, "latch": 2,
  },
  janitorial: {
    "cleaning": 3, "clean": 1, "rubbish": 2, "garbage": 2, "trash": 2, "litter": 2,
    "janitorial": 3, "spill": 2, "smell": 1, "odour": 2, "odor": 2, "stain": 2,
    "biohazard": 3, "pest": 2, "rodent": 3, "cockroach": 3, "ants": 2, "vermin": 3,
    "bin": 2, "bins": 2, "overflowing": 2, "dirty": 1,
  },
  gardening: {
    "grass": 2, "garden": 2, "tree": 2, "trees": 2, "overgrown": 3, "weeds": 2,
    "lawn": 2, "landscap": 2, "branch": 2, "branches": 2, "hedge": 2, "gardening": 3,
    "irrigation": 2, "sprinkler": 2, "pruning": 2, "plant": 1,
  },
  carpentry: {
    "door": 1, "drawer": 2, "cabinet": 2, "hinge": 2, "handle": 2, "wooden": 2,
    "wood": 1, "furniture": 2, "squeak": 1, "warped": 2, "shelf": 2, "carpentry": 3,
    "cracked wood": 2, "sticking door": 2,
  },
  masonry: {
    "wall": 2, "ceiling": 2, "tile": 2, "tiles": 2, "crack": 2, "cracks": 2,
    "brick": 2, "concrete": 2, "plaster": 2, "masonry": 3, "paint peeling": 1,
    "water stain": 1, "cracked tile": 3, "loose tile": 3, "damp": 2, "efflorescence": 3,
  },
  painting: {
    "paint": 2, "paintwork": 2, "painting": 3, "repaint": 3, "peeling": 2,
    "chipped": 2, "paint touch up": 3, "graffiti": 2,
  },
};

// Hazard phrases that push urgency. 4 = urgent, 3 = high, 2 = high-ish.
const HAZARDS = [
  { words: ["flood", "flooding", "burst", "gas leak", "smoke", "fire", "electrical fire", "power cut", "no power", "faint", "unconscious", "collapsed", "falling", "unsafe", "sewage"], priority: "urgent" },
  { words: ["spark", "shock", "no water", "water running", "ceiling"], priority: "high" },
  { words: ["leak", "dripping", "tripping", "blocked", "stuck"], priority: "high" },
  { words: ["annoy", "cosmetic", "peeling", "stain"], priority: "low" },
];

function phraseMatch(text, phrase) {
  return text.includes(phrase.toLowerCase());
}

function wordMatch(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(text);
}

export function triageRequest({ title = "", description = "" } = {}) {
  const text = `${title} ${description}`.toLowerCase().trim();
  if (!text) return { trade: null, priority: null, confidence: 0, matched: [], label: null };

  const scores = new Map();
  const matched = [];

  for (const [trade, keywords] of Object.entries(RULES)) {
    for (const [keyword, weight] of Object.entries(keywords)) {
      const hit = keyword.includes(" ") ? phraseMatch(text, keyword) : wordMatch(text, keyword);
      if (hit) {
        scores.set(trade, (scores.get(trade) ?? 0) + weight);
        matched.push({ trade, keyword, weight });
      }
    }
  }

  if (scores.size === 0) {
    return { trade: null, priority: null, confidence: 0, matched: [], label: null };
  }

  const trade = [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const tradeScore = scores.get(trade);

  let priority = "normal";
  for (const hazard of HAZARDS) {
    if (hazard.words.some((w) => (w.includes(" ") ? phraseMatch(text, w) : wordMatch(text, w)))) {
      priority = hazard.priority;
      break;
    }
  }

  const distinctMatches = new Set(matched.map((m) => m.keyword)).size;
  const confidence = Math.max(0.2, Math.min(0.95, 0.3 * distinctMatches + tradeScore * 0.1));

  return {
    trade,
    priority,
    confidence: Number(confidence.toFixed(2)),
    matched: matched.filter((m) => m.trade === trade).map((m) => m.keyword),
    label: `${trade} · ${priority}`,
  };
}
