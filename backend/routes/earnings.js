const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

// GET /earnings - the logged-in user's own earnings.
// Balances are always calculated from the ledger, never stored,
// so they can never drift out of line with reality.
router.get("/", requireAuth, async (req, res) => {
  try {
    const totalsResult = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending'   THEN net_amount ELSE 0 END), 0) AS pending_total,
         COALESCE(SUM(CASE WHEN status = 'available' THEN net_amount ELSE 0 END), 0) AS available_total,
         COALESCE(SUM(CASE WHEN status = 'withdrawn' THEN net_amount ELSE 0 END), 0) AS withdrawn_total,
         COALESCE(SUM(CASE WHEN status IN ('pending','available','withdrawn') THEN net_amount ELSE 0 END), 0) AS lifetime_total,
         COALESCE(SUM(CASE WHEN status IN ('pending','available','withdrawn') THEN platform_fee ELSE 0 END), 0) AS fees_total,
         COUNT(*) FILTER (WHERE status IN ('pending','available','withdrawn')) AS sale_count
       FROM earnings
       WHERE user_id = $1`,
      [req.user.id]
    );

    const listResult = await pool.query(
      `SELECT
         e.id, e.source_type, e.gross_amount, e.platform_fee, e.net_amount,
         e.currency, e.status, e.available_at, e.created_at,
         o.product_title
       FROM earnings e
       LEFT JOIN orders o ON o.id::text = e.source_id
       WHERE e.user_id = $1
       ORDER BY e.created_at DESC`,
      [req.user.id]
    );

    // Currency is taken from the actual records rather than assumed.
    const currency = listResult.rows.length > 0 ? listResult.rows[0].currency : "GHS";

    res.json({
      totals: totalsResult.rows[0],
      currency,
      earnings: listResult.rows
    });
  } catch (err) {
    console.error("Load earnings error:", err);
    res.status(500).json({ error: "Could not load your earnings" });
  }
});

module.exports = router;
