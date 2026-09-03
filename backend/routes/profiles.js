const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET my creator profile
router.get("/creator", requireAuth, requireRole("creator"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM creator_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load creator profile" });
  }
});

// CREATE OR UPDATE my creator profile
router.put("/creator", requireAuth, requireRole("creator"), async (req, res) => {
  const { bio, niches, platforms, portfolio_links, photo_url } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO creator_profiles (user_id, bio, niches, platforms, portfolio_links, photo_url, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET bio = $2, niches = $3, platforms = $4, portfolio_links = $5, photo_url = $6
       RETURNING *`,
      [req.user.id, bio, niches, platforms, portfolio_links, photo_url]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save creator profile" });
  }
});

// GET my business profile
router.get("/business", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM business_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load business profile" });
  }
});

// CREATE OR UPDATE my business profile
router.put("/business", requireAuth, requireRole("business"), async (req, res) => {
  const { business_name, description, category, logo_url, contact_email, contact_phone } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO business_profiles (user_id, business_name, description, category, logo_url, contact_email, contact_phone, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET business_name = $2, description = $3, category = $4, logo_url = $5, contact_email = $6, contact_phone = $7
       RETURNING *`,
      [req.user.id, business_name, description, category, logo_url, contact_email, contact_phone]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save business profile" });
  }
});

module.exports = router;
