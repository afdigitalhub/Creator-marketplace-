const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const pool = require("../config/db");

const router = express.Router();

// Each of these three routes is locked to exactly one role. A creator token
// hitting /dashboard/business gets a real 403, not a silent bypass — this is
// what "a creator must not access business/admin functions" actually means
// in code, not just in the spec.

router.get("/creator", requireAuth, requireRole("creator"), async (req, res) => {
  const profile = await pool.query(
    "SELECT * FROM creator_profiles WHERE user_id = $1",
    [req.user.id]
  );
  res.json({ message: "Creator dashboard", profile: profile.rows[0] || null });
});

router.get("/business", requireAuth, requireRole("business"), async (req, res) => {
  const profile = await pool.query(
    "SELECT * FROM business_profiles WHERE user_id = $1",
    [req.user.id]
  );
  res.json({ message: "Business dashboard", profile: profile.rows[0] || null });
});

router.get("/admin", requireAuth, requireRole("admin"), async (req, res) => {
  const userCount = await pool.query("SELECT COUNT(*) FROM users");
  res.json({
    message: "Admin dashboard",
    total_users: parseInt(userCount.rows[0].count),
  });
});

module.exports = router;
