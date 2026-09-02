const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

// Leave a review for someone after a campaign (either business->creator or creator->business)
router.post("/", requireAuth, async (req, res) => {
  try {
    const { campaign_id, reviewee_id, rating, comment } = req.body;

    if (!campaign_id || !reviewee_id || !rating) {
      return res.status(400).json({ error: "campaign_id, reviewee_id, and rating are required" });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: "rating must be between 1 and 5" });
    }

    if (reviewee_id === req.user.id) {
      return res.status(400).json({ error: "You cannot review yourself" });
    }

    // Confirm the campaign exists
    const campaignCheck = await pool.query("SELECT * FROM campaigns WHERE id = $1", [campaign_id]);
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    // Confirm the reviewer was actually involved in this campaign
    // (either the business that owns it, or a creator with an accepted application)
    const campaign = campaignCheck.rows[0];
    let involved = campaign.business_id === req.user.id;

    if (!involved) {
      const appCheck = await pool.query(
        `SELECT * FROM campaign_applications WHERE campaign_id = $1 AND creator_id = $2 AND status = 'accepted'`,
        [campaign_id, req.user.id]
      );
      involved = appCheck.rows.length > 0;
    }

    if (!involved) {
      return res.status(403).json({ error: "You must be involved in this campaign to leave a review" });
    }

    // Prevent duplicate reviews from the same reviewer for the same campaign/reviewee
    const dupCheck = await pool.query(
      `SELECT * FROM reviews WHERE campaign_id = $1 AND reviewer_id = $2 AND reviewee_id = $3`,
      [campaign_id, req.user.id, reviewee_id]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(400).json({ error: "You already reviewed this person for this campaign" });
    }

    const result = await pool.query(
      `INSERT INTO reviews (reviewee_id, campaign_id, reviewer_id, rating, comment, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [reviewee_id, campaign_id, req.user.id, rating, comment || null]
    );

    res.status(201).json({ review: result.rows[0] });
  } catch (err) {
    console.error("Create review error:", err);
    res.status(500).json({ error: "Server error creating review" });
  }
});

// View all reviews for a specific user (public - shows their reputation)
router.get("/user/:userId", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.full_name AS reviewer_name
       FROM reviews r
       JOIN users u ON r.reviewer_id = u.id
       WHERE r.reviewee_id = $1
       ORDER BY r.created_at DESC`,
      [req.params.userId]
    );

    const avgResult = await pool.query(
      `SELECT ROUND(AVG(rating), 1) AS average_rating, COUNT(*) AS total_reviews
       FROM reviews WHERE reviewee_id = $1`,
      [req.params.userId]
    );

    res.json({
      reviews: result.rows,
      average_rating: avgResult.rows[0].average_rating,
      total_reviews: avgResult.rows[0].total_reviews,
    });
  } catch (err) {
    console.error("List reviews error:", err);
    res.status(500).json({ error: "Server error fetching reviews" });
  }
});

// View all reviews for a specific campaign
router.get("/campaign/:campaignId", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.full_name AS reviewer_name
       FROM reviews r
       JOIN users u ON r.reviewer_id = u.id
       WHERE r.campaign_id = $1
       ORDER BY r.created_at DESC`,
      [req.params.campaignId]
    );

    res.json({ reviews: result.rows });
  } catch (err) {
    console.error("List campaign reviews error:", err);
    res.status(500).json({ error: "Server error fetching campaign reviews" });
  }
});

module.exports = router;
