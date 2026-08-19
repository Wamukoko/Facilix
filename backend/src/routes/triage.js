// AI triage for resident requests (Phase 4). A thin wrapper around the pure
// triage engine: validates the free text, runs the classifier, and drops any
// suggested trade that isn't in the org's configured vocabulary (so custom
// orgs degrade gracefully instead of getting an unusable suggestion).

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errors.js";
import { validate } from "../middleware/validate.js";
import { query } from "../db.js";
import { triageRequest } from "../triage.js";

const router = Router();

const triageSchema = z.object({
  title: z.string().trim().max(300).optional(),
  description: z.string().trim().max(5000).optional(),
});

// POST /api/triage — suggest trade + urgency from a resident's free text.
router.post(
  "/",
  validate(triageSchema),
  asyncHandler(async (req, res) => {
    const suggestion = triageRequest(req.body);
    if (suggestion.trade) {
      const { rows } = await query(
        `SELECT 1 FROM trades WHERE organization_id = $1 AND value = $2 AND active = true`,
        [req.orgId, suggestion.trade]
      );
      if (rows.length === 0) {
        suggestion.trade = null;
        suggestion.priority = null;
        suggestion.confidence = 0;
        suggestion.label = null;
        suggestion.matched = [];
      }
    }
    res.json({ suggestion });
  })
);

export default router;
