// Centralized error handling for the API.
// Express 4 does not catch rejections from async handlers, so every async
// route must be wrapped in asyncHandler; otherwise one bad query becomes
// an unhandled rejection / HTML 500 instead of a JSON error response.

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Thrown (or passed to next()) by business logic to control the HTTP status
// and the message shown to the client. Deliberately distinguishes client
// errors (4xx, message safe to expose) from server errors (5xx, hidden).
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = status >= 400 && status < 500;
  }
}

export function notFound(req, res) {
  res.status(404).json({ error: "Route not found" });
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err.expose !== undefined && !err.expose) {
    // Server-side failure: log the real cause, hide it from the client.
    console.error("[error]", err);
    return res.status(err.status || 500).json({ error: "Internal server error" });
  }

  // Validation errors (zod) carry a .issues array.
  if (err.name === "ZodError") {
    return res.status(400).json({
      error: "Validation failed",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  console.error("[error]", err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : "Internal server error" });
}
