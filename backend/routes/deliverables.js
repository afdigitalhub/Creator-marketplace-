const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

// Creator submits a deliverable for a campaign (must have an accepted application)
router.post("/", requireAuth, requireRole("creator"), async (req, res) => {
  try {
    const { campaign_id, submission_url, notes } = req.body;

    if (!campaign_id || !submission_url) {
      return res.status(400).json({ error: "campaign_id and submission_url are required" });
    }

    // campaign_applications.creator_id references creator_profiles.id,
    // not users.id — resolve the real creator profile ID first.
    const creatorProfile = await pool.query(
      "SELECT id FROM creator_profiles WHERE user_id = $1",
      [req.user.id]
    );
    if (creatorProfile.rows.length === 0) {
      return res.status(400).json({ error: "No creator profile found for this account" });
    }
    const creatorProfileId = creatorProfile.rows[0].id;

    // Confirm the creator has an accepted application for this campaign
    const appCheck = await pool.query(
      `SELECT * FROM campaign_applications
       WHERE campaign_id = $1 AND creator_id = $2 AND status = 'accepted'`,
      [campaign_id, creatorProfileId]
    );

    if (appCheck.rows.length === 0) {
      return res.status(403).json({ error: "You must have an accepted application for this campaign to submit a deliverable" });
    }

    // campaign_deliverables.creator_id also references creator_profiles.id
    const result = await pool.query(
      `INSERT INTO campaign_deliverables (campaign_id, creator_id, submission_url, notes, approved, submitted_at)
       VALUES ($1, $2, $3, $4, false, NOW())
       RETURNING *`,
      [campaign_id, creatorProfileId, submission_url, notes || null]
    );

    res.status(201).json({ deliverable: result.rows[0] });
  } catch (err) {
    console.error("Create deliverable error:", err);
    res.status(500).json({ error: "Server error submitting deliverable" });
  }
});

// Business views all deliverables for one of their campaigns
router.get("/campaign/:campaignId", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const campaignCheck = await pool.query("SELECT * FROM campaigns WHERE id = $1", [req.params.campaignId]);
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    // campaigns.business_id references business_profiles.id, not users.id
    const bizProfile = await pool.query(
      "SELECT id FROM business_profiles WHERE user_id = $1",
      [req.user.id]
    );
    const ownBusinessId = bizProfile.rows[0] ? bizProfile.rows[0].id : null;

    if (campaignCheck.rows[0].business_id !== ownBusinessId) {
      return res.status(403).json({ error: "Not authorized to view these deliverables" });
    }

    // creator_id is a creator_profiles.id — join through creator_profiles
    // to reach the real user for their name.
    const result = await pool.query(
      `SELECT d.*, u.full_name AS creator_name
       FROM campaign_deliverables d
       JOIN creator_profiles cp ON d.creator_id = cp.id
       JOIN users u ON cp.user_id = u.id
       WHERE d.campaign_id = $1
       ORDER BY d.submitted_at DESC`,
      [req.params.campaignId]
    );

    res.json({ deliverables: result.rows });
  } catch (err) {
    console.error("List deliverables error:", err);
    res.status(500).json({ error: "Server error fetching deliverables" });
  }
});

// Creator views their own submitted deliverables
router.get("/mine", requireAuth, requireRole("creator"), async (req, res) => {
  try {
    const creatorProfile = await pool.query(
      "SELECT id FROM creator_profiles WHERE user_id = $1",
      [req.user.id]
    );
    if (creatorProfile.rows.length === 0) {
      return res.json({ deliverables: [] });
    }
    const creatorProfileId = creatorProfile.rows[0].id;

    const result = await pool.query(
      `SELECT d.*, c.title AS campaign_title
       FROM campaign_deliverables d
       JOIN campaigns c ON d.campaign_id = c.id
       WHERE d.creator_id = $1
       ORDER BY d.submitted_at DESC`,
      [creatorProfileId]
    );

    res.json({ deliverables: result.rows });
  } catch (err) {
    console.error("List my deliverables error:", err);
    res.status(500).json({ error: "Server error fetching your deliverables" });
  }
});

// Business approves a deliverable
router.put("/:id/approve", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT d.*, c.business_id
       FROM campaign_deliverables d
       JOIN campaigns c ON d.campaign_id = c.id
       WHERE d.id = $1`,
      [req.params.id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Deliverable not found" });
    }

    // campaigns.business_id is a business_profiles.id — resolve the
    // authenticated user's own business profile before comparing.
    const bizProfile = await pool.query(
      "SELECT id FROM business_profiles WHERE user_id = $1",
      [req.user.id]
    );
    const ownBusinessId = bizProfile.rows[0] ? bizProfile.rows[0].id : null;

    if (check.rows[0].business_id !== ownBusinessId) {
      return res.status(403).json({ error: "Not authorized to approve this deliverable" });
    }

    const result = await pool.query(
      `UPDATE campaign_deliverables SET approved = true WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    res.json({ deliverable: result.rows[0] });
  } catch (err) {
    console.error("Approve deliverable error:", err);
    res.status(500).json({ error: "Server error approving deliverable" });
  }
});

module.exports = router;
