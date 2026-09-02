const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

// Business creates a payout for a creator on a campaign
router.post("/", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const { creator_id, campaign_id, amount } = req.body;

    if (!creator_id || !campaign_id || !amount) {
      return res.status(400).json({ error: "creator_id, campaign_id, and amount are required" });
    }

    // Confirm this business owns the campaign
    const campaignCheck = await pool.query("SELECT * FROM campaigns WHERE id = $1", [campaign_id]);
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (campaignCheck.rows[0].business_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to create a payout for this campaign" });
    }

    // Confirm the creator has an accepted application for this campaign
    const appCheck = await pool.query(
      `SELECT * FROM campaign_applications
       WHERE campaign_id = $1 AND creator_id = $2 AND status = 'accepted'`,
      [campaign_id, creator_id]
    );
    if (appCheck.rows.length === 0) {
      return res.status(400).json({ error: "This creator does not have an accepted application for this campaign" });
    }

    const result = await pool.query(
      `INSERT INTO payouts (creator_id, campaign_id, amount, status, created_at)
       VALUES ($1, $2, $3, 'pending', NOW())
       RETURNING *`,
      [creator_id, campaign_id, amount]
    );

    res.status(201).json({ payout: result.rows[0] });
  } catch (err) {
    console.error("Create payout error:", err);
    res.status(500).json({ error: "Server error creating payout" });
  }
});

// Creator views their own payouts
router.get("/mine", requireAuth, requireRole("creator"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.title AS campaign_title
       FROM payouts p
       JOIN campaigns c ON p.campaign_id = c.id
       WHERE p.creator_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.id]
    );

    res.json({ payouts: result.rows });
  } catch (err) {
    console.error("List my payouts error:", err);
    res.status(500).json({ error: "Server error fetching your payouts" });
  }
});

// Business views all payouts they've issued
router.get("/mine/issued", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.title AS campaign_title, u.full_name AS creator_name
       FROM payouts p
       JOIN campaigns c ON p.campaign_id = c.id
       JOIN users u ON p.creator_id = u.id
       WHERE c.business_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.id]
    );

    res.json({ payouts: result.rows });
  } catch (err) {
    console.error("List issued payouts error:", err);
    res.status(500).json({ error: "Server error fetching payouts" });
  }
});

// Business marks a payout as paid
router.put("/:id/paid", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT p.*, c.business_id
       FROM payouts p
       JOIN campaigns c ON p.campaign_id = c.id
       WHERE p.id = $1`,
      [req.params.id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Payout not found" });
    }

    if (check.rows[0].business_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to update this payout" });
    }

    const result = await pool.query(
      `UPDATE payouts SET status = 'paid' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    res.json({ payout: result.rows[0] });
  } catch (err) {
    console.error("Update payout error:", err);
    res.status(500).json({ error: "Server error updating payout" });
  }
});

module.exports = router;
