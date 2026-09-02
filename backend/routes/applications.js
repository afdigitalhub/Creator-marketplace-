
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { createNotification } = require("./notifications");

// Creator applies to a campaign
router.post("/", requireAuth, requireRole("creator"), async (req, res) => {
  try {
    const { campaign_id, proposed_price, pitch } = req.body;

    if (!campaign_id || !pitch) {
      return res.status(400).json({ error: "campaign_id and pitch are required" });
    }

    const campaignCheck = await pool.query("SELECT * FROM campaigns WHERE id = $1", [campaign_id]);
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const dupCheck = await pool.query(
      "SELECT * FROM campaign_applications WHERE campaign_id = $1 AND creator_id = $2",
      [campaign_id, req.user.id]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(400).json({ error: "You already applied to this campaign" });
    }

    const result = await pool.query(
      `INSERT INTO campaign_applications (campaign_id, creator_id, proposed_price, pitch, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       RETURNING *`,
      [campaign_id, req.user.id, proposed_price || null, pitch]
    );

    const campaign = campaignCheck.rows[0];
    await createNotification(
      campaign.business_id,
      "new_application",
      `You have a new application for "${campaign.title}"`
    );

    res.status(201).json({ application: result.rows[0] });
  } catch (err) {
    console.error("Create application error:", err);
    res.status(500).json({ error: "Server error creating application" });
  }
});

// Business views all applications for one of their campaigns
router.get("/campaign/:campaignId", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const campaignCheck = await pool.query("SELECT * FROM campaigns WHERE id = $1", [req.params.campaignId]);
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (campaignCheck.rows[0].business_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to view these applications" });
    }

    const result = await pool.query(
      `SELECT a.*, u.full_name AS creator_name, u.email AS creator_email
       FROM campaign_applications a
       JOIN users u ON a.creator_id = u.id
       WHERE a.campaign_id = $1
       ORDER BY a.created_at DESC`,
      [req.params.campaignId]
    );

    res.json({ applications: result.rows });
  } catch (err) {
    console.error("List applications error:", err);
    res.status(500).json({ error: "Server error fetching applications" });
  }
});

// Creator views their own applications
router.get("/mine", requireAuth, requireRole("creator"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, c.title AS campaign_title, c.budget
       FROM campaign_applications a
       JOIN campaigns c ON a.campaign_id = c.id
       WHERE a.creator_id = $1
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );

    res.json({ applications: result.rows });
  } catch (err) {
    console.error("List my applications error:", err);
    res.status(500).json({ error: "Server error fetching your applications" });
  }
});

// Business accepts or rejects an application
router.put("/:id/status", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["accepted", "rejected"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "status must be 'accepted' or 'rejected'" });
    }

    const appCheck = await pool.query(
      `SELECT a.*, c.business_id, c.title
       FROM campaign_applications a
       JOIN campaigns c ON a.campaign_id = c.id
       WHERE a.id = $1`,
      [req.params.id]
    );

    if (appCheck.rows.length === 0) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (appCheck.rows[0].business_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to update this application" });
    }

    const result = await pool.query(
      `UPDATE campaign_applications SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );

    const app = appCheck.rows[0];
    await createNotification(
      app.creator_id,
      status === "accepted" ? "application_accepted" : "application_rejected",
      `Your application for "${app.title}" was ${status}`
    );

    res.json({ application: result.rows[0] });
  } catch (err) {
    console.error("Update application status error:", err);
    res.status(500).json({ error: "Server error updating application status" });
  }
});

module.exports = router;
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { createNotification } = require("./notifications");

// Creator applies to a campaign
router.post("/", requireAuth, requireRole("creator"), async (req, res) => {
  try {
    const { campaign_id, proposed_price, pitch } = req.body;

    if (!campaign_id || !pitch) {
      return res.status(400).json({ error: "campaign_id and pitch are required" });
    }

    const campaignCheck = await pool.query("SELECT * FROM campaigns WHERE id = $1", [campaign_id]);
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const dupCheck = await pool.query(
      "SELECT * FROM campaign_applications WHERE campaign_id = $1 AND creator_id = $2",
      [campaign_id, req.user.id]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(400).json({ error: "You already applied to this campaign" });
    }

    const result = await pool.query(
      `INSERT INTO campaign_applications (campaign_id, creator_id, proposed_price, pitch, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       RETURNING *`,
      [campaign_id, req.user.id, proposed_price || null, pitch]
    );

    const campaign = campaignCheck.rows[0];
    await createNotification(
      campaign.business_id,
      "new_application",
      `You have a new application for "${campaign.title}"`
    );

    res.status(201).json({ application: result.rows[0] });
  } catch (err) {
    console.error("Create application error:", err);
    res.status(500).json({ error: "Server error creating application" });
  }
});

// Business views all applications for one of their campaigns
router.get("/campaign/:campaignId", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const campaignCheck = await pool.query("SELECT * FROM campaigns WHERE id = $1", [req.params.campaignId]);
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (campaignCheck.rows[0].business_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to view these applications" });
    }

    const result = await pool.query(
      `SELECT 
