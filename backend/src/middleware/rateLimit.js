import rateLimit from "express-rate-limit";

const standardHeaders = "draft-7";

// Global API budget — bounds abuse of every authenticated endpoint.
// Tune via env: RATE_LIMIT_MAX (requests) per RATE_LIMIT_WINDOW_MS.
export const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_MAX) || 1000,
  standardHeaders,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
});

// Much tighter budget for credential endpoints (login/signup) to blunt
// brute-force / credential-stuffing attempts. Tune via AUTH_RATE_LIMIT_MAX.
export const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  standardHeaders,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
});
