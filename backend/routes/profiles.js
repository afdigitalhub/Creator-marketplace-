const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET creator profile
router.get("/creator", requireAuth, requireRole("creator"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM creator_profiles WHERE user_id = $1",
      [req.user.id]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch creator profile" });
  }
});

// UPDATE creator profile
router.put("/creator", requireAuth, requireRole("creator"), async (req, res) => {
  const { bio, niche, social_links } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO creator_profiles (user_id, bio, niche, social_links)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
       SET bio = $2, niche = $3, social_links = $4
       RETURNING *`,
      [req.user.id, bio, niche, social_links]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update creator profile" });
  }
});

// GET business profile
router.get("/business", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM business_profiles WHERE user_id = $1",
      [req.user.id]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch business profile" });
  }
});

// UPDATE business profile
router.put("/business", requireAuth, requireRole("business"), async (req, res) => {
  const { company_name, industry, description, website } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO business_profiles (user_id, company_name, industry, description, website)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
       SET company_name = $2, industry = $3, description = $4, website = $5
       RETURNING *`,
      [req.user.id, company_name, industry, description, website]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update business profile" });
  }
});

module.exports = router;
