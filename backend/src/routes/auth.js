import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";
import { validate } from "../middleware/validate.js";
import { signToken } from "../middleware/auth.js";
import { seedDefaultLookups } from "../lib/lookups.js";

const router = Router();

const signupSchema = z.object({
  orgName: z.string().trim().min(1, "orgName is required").max(120),
  fullName: z.string().trim().min(1, "fullName is required").max(120),
  email: z.string().trim().toLowerCase().email("a valid email is required").max(200),
  password: z.string().min(8, "password must be at least 8 characters").max(200),
  phone: z.string().trim().max(30).optional(),
  trade: z.string().trim().max(30).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("a valid email is required").max(200),
  password: z.string().min(1, "password is required").max(200),
});

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    trade: row.trade,
    phone: row.phone,
    supplier_id: row.supplier_id || null,
    organization_id: row.organization_id,
    organization_name: row.organization_name,
  };
}

// POST /api/auth/signup
// body: { orgName, fullName, email, password, phone?, trade? }
// Creates a new organization and its first user (an admin), then returns
// a JWT for immediate use.
router.post(
  "/signup",
  validate(signupSchema),
  asyncHandler(async (req, res) => {
    const { orgName, fullName, email, password, phone, trade } = req.body;

    let user;
    try {
      user = await withTransaction(async (client) => {
        const { rows: orgRows } = await client.query(
          `INSERT INTO organizations (name) VALUES ($1) RETURNING id, name`,
          [orgName]
        );
        const org = orgRows[0];

        const password_hash = await bcrypt.hash(password, 10);
        const { rows: userRows } = await client.query(
          `INSERT INTO users (organization_id, email, password_hash, full_name, role, trade, phone)
           VALUES ($1,$2,$3,$4,'admin',$5,$6)
           RETURNING *`,
          [org.id, email, password_hash, fullName, trade || null, phone || null]
        );

        // Seed the org's configurable vocabulary (trades + asset types).
        await seedDefaultLookups(client, org.id);

        return { ...userRows[0], organization_name: org.name };
      });
    } catch (err) {
      if (err.code === "23505") {
        throw new ApiError(409, "An account with that email already exists");
      }
      throw err;
    }

    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  })
);

// POST /api/auth/login
// body: { email, password }
router.post(
  "/login",
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const { rows } = await query(
      `SELECT u.*, o.name AS organization_name
       FROM users u
       JOIN organizations o ON o.id = u.organization_id
       WHERE u.email = $1`,
      [email]
    );
    const user = rows[0];
    if (!user || user.active === false) {
      throw new ApiError(401, "Invalid email or password");
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      throw new ApiError(401, "Invalid email or password");
    }

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  })
);

export default router;
