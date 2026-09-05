const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

// GET my own professional profile (creates a default empty row if none exists yet)
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM professional_profiles WHERE user_id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        user_id: req.user.id,
        headline: null,
        about: null,
        skills: [],
        portfolio: [],
        links: []
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Get professional profile error:", err);
    res.status(500).json({ error: "Could not load professional profile" });
  }
});

// CREATE OR UPDATE my own professional profile
router.put("/me", requireAuth, async (req, res) => {
  const { headline, about, skills, portfolio, links } = req.body;

  if (headline && headline.length > 150) {
    return res.status(400).json({ error: "Headline must be 150 characters or fewer" });
  }
  if (about && about.length > 2000) {
    return res.status(400).json({ error: "About section must be 2000 characters or fewer" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO professional_profiles (user_id, headline, about, skills, portfolio, links, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET headline = $2, about = $3, skills = $4, portfolio = $5, links = $6, updated_at = NOW()
       RETURNING *`,
      [
        req.user.id,
        headline || null,
        about || null,
        Array.isArray(skills) ? skills : [],
        JSON.stringify(Array.isArray(portfolio) ? portfolio : []),
        JSON.stringify(Array.isArray(links) ? links : [])
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Save professional profile error:", err);
    res.status(500).json({ error: "Could not save professional profile" });
  }
});

// GET a public professional profile by user ID — combines professional_profiles,
// role-specific data (creator/business), published products, and real reviews.
// Requires auth per this phase's scope decision (not fully public/logged-out).
router.get("/:userId", requireAuth, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT id, full_name, role FROM users WHERE id = $1`,
      [req.params.userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const user = userResult.rows[0];

    const profResult = await pool.query(
      `SELECT headline, about, skills, portfolio, links FROM professional_profiles WHERE user_id = $1`,
      [req.params.userId]
    );
    const professional = profResult.rows[0] || { headline: null, about: null, skills: [], portfolio: [], links: [] };

    let roleData = null;
    if (user.role === "creator") {
      const cp = await pool.query(
        `SELECT photo_url, bio, niches, platforms FROM creator_profiles WHERE user_id = $1`,
        [req.params.userId]
      );
      roleData = cp.rows[0] || null;
    } else if (user.role === "business") {
      const bp = await pool.query(
        `SELECT business_name, description, category, logo_url FROM business_profiles WHERE user_id = $1`,
        [req.params.userId]
      );
      roleData = bp.rows[0] || null;
    }

    const productsResult = await pool.query(
      `SELECT id, title, subtitle, cover_url, price, currency, category
       FROM products WHERE seller_id = $1 AND status = 'published'
       ORDER BY created_at DESC`,
      [req.params.userId]
    );

    const reviewsResult = await pool.query(
      `SELECT r.rating, r.comment, r.created_at, u.full_name AS reviewer_name
       FROM reviews r JOIN users u ON r.reviewer_id = u.id
       WHERE r.reviewee_id = $1 ORDER BY r.created_at DESC`,
      [req.params.userId]
    );
    const avgResult = await pool.query(
      `SELECT ROUND(AVG(rating), 1) AS average_rating, COUNT(*) AS total_reviews
       FROM reviews WHERE reviewee_id = $1`,
      [req.params.userId]
    );

    res.json({
      full_name: user.full_name,
      role: user.role,
      professional,
      role_data: roleData,
      products: productsResult.rows,
      reviews: reviewsResult.rows,
      average_rating: avgResult.rows[0].average_rating,
      total_reviews: avgResult.rows[0].total_reviews
    });
  } catch (err) {
    console.error("Get public profile error:", err);
    res.status(500).json({ error: "Could not load profile" });
  }
});

module.exports = router;
