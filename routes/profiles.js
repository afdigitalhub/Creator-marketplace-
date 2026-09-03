const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET my creator profile
router.get("/creator", requireAuth, requireRole("creator"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cp.*, u.full_name, u.email
       FROM creator_profiles cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.user_id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.json({ user_id: req.user.id, bio: "", niches: [], platforms: [], portfolio_links: [], photo_url: null });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load creator profile" });
  }
});

// CREATE OR UPDATE my creator profile
router.put("/creator", requireAuth, requireRole("creator"), async (req, res) => {
  const { bio, niches, platforms, portfolio_links, photo_url } = req.body;
  try {
    const existing = await pool.query(
      `SELECT id FROM creator_profiles WHERE user_id = $1`,
      [req.user.id]
    );

    let result;
    if (existing.rows.length === 0) {
      result = await pool.query(
        `INSERT INTO creator_profiles (user_id, bio, niches, platforms, portfolio_links, photo_url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [req.user.id, bio, niches, platforms, portfolio_links, photo_url]
      );
    } else {
      result = await pool.query(
        `UPDATE creator_profiles
         SET bio = $1, niches = $2, platforms = $3, portfolio_links = $4, photo_url = $5
         WHERE user_id = $6
         RETURNING *`,
        [bio, niches, platforms, portfolio_links, photo_url, req.user.id]
      );
    }
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
      `SELECT bp.*, u.full_name, u.email
       FROM business_profiles bp
       JOIN users u ON u.id = bp.user_id
       WHERE bp.user_id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.json({ user_id: req.user.id, business_name: "", description: "", category: "", logo_url: null, contact_email: "", contact_phone: "" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load business profile" });
  }
});

// CREATE OR UPDATE my business profile
router.put("/business", requireAuth, requireRole("business"), async (req, res) => {
  const { business_name, description, category, logo_url, contact_email, contact_phone } = req.body;
  try {
    const existing = await pool.query(
      `SELECT id FROM business_profiles WHERE user_id = $1`,
      [req.user.id]
    );

    let result;
    if (existing.rows.length === 0) {
      result = await pool.query(
        `INSERT INTO business_profiles (user_id, business_name, description, category, logo_url, contact_email, contact_phone, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING *`,
        [req.user.id, business_name, description, category, logo_url, contact_email, contact_phone]
      );
    } else {
      result = await pool.query(
        `UPDATE business_profiles
         SET business_name = $1, description = $2, category = $3, logo_url = $4, contact_email = $5, contact_phone = $6
         WHERE user_id = $7
         RETURNING *`,
        [business_name, description, category, logo_url, contact_email, contact_phone, req.user.id]
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save business profile" });
  }
});

module.exports = router;
