import jwt from "jsonwebtoken";
import "dotenv/config";

const defaultSecret = "change-me-in-production";
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : defaultSecret);

// Failing to set a real secret in production is a security incident waiting
// to happen — refuse to boot rather than run with a known default.
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET must be set before booting Facilix in production");
}

// Issues the JWT the rest of the API expects: { sub, orgId, role }.
// req.orgId is set from this payload by requireAuth, which is the
// multi-tenancy boundary for every downstream query.
export function signToken(user) {
  return jwt.sign(
    { sub: user.id, orgId: user.organization_id, role: user.role, supplierId: user.supplier_id || null },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// Verifies the bearer token and attaches user info (including
// organization_id) to req, so every downstream query is scoped
// to the caller's org — this is the multi-tenancy boundary.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    req.orgId = payload.orgId;
    req.role = payload.role;
    req.supplierId = payload.supplierId || null;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Restrict a route to specific roles, e.g. requireRole('admin', 'manager')
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
