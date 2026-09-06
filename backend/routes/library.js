const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

// GET /library - everything the logged-in user actually owns.
// Entitlements are the single source of truth for ownership.
// A user only appears here if a real, active entitlement exists.
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         e.id AS entitlement_id,
         e.created_at AS owned_since,
         p.id AS product_id,
         p.title,
         p.subtitle,
         p.category,
         p.cover_url,
         u.full_name AS seller_name
       FROM entitlements e
       JOIN products p ON e.product_id = p.id
       LEFT JOIN users u ON p.seller_id = u.id
       WHERE e.user_id = $1 AND e.status = 'active'
       ORDER BY e.created_at DESC`,
      [req.user.id]
    );

    res.json({ items: result.rows });
  } catch (err) {
    console.error("Load library error:", err);
    res.status(500).json({ error: "Could not load your library" });
  }
});

module.exports = router;
