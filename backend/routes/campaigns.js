const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET all campaigns (with business name/email)
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.full_name AS business_name, u.email AS business_email
       FROM campaigns c
       JOIN users u ON c.business_id = u.id
       ORDER BY c.created_at DESC`
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch campaigns" });
  }
});

// GET single campaign by id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.full_name AS business_name, u.email AS business_email
       FROM campaigns c
       JOIN users u ON c.business_id = u.id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    res.json({ campaign: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch campaign" });
  }
});

// POST create campaign (business only)
router.post("/", requireAuth, requireRole("business"), async (req, res) => {
  const {
    title,
    description,
    objective,
    deliverables,
    budget,
    currency,
    creators_needed,
    min_followers,
    required_platform,
    required_niche,
    application_deadline,
    deadline
  } = req.body;

  if (
    !title || !description || !objective || !deliverables ||
    !budget || !creators_needed || !min_followers ||
    !required_platform || !required_niche ||
    !application_deadline || !deadline
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO campaigns
        (business_id, title, description, objective, deliverables, budget, currency,
         creators_needed, min_followers, required_platform, required_niche,
         application_deadline, deadline, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open')
       RETURNING *`,
      [
        req.user.id,
        title,
        description,
        objective,
        deliverables,
        budget,
        currency || "USD",
        creators_needed,
        min_followers,
        required_platform,
        required_niche,
        application_deadline,
        deadline
      ]
    );
    res.status(201).json({ campaign: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create campaign", detail: err.message });
  }
});

// PUT update campaign (business who owns it, or admin)
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM campaigns WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (existing.rows[0].business_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized to edit this campaign" });
    }

    const {
      title, description, objective, deliverables, budget, currency,
      creators_needed, min_followers, required_platform, required_niche,
      application_deadline, deadline, status
    } = req.body;

    const result = await pool.query(
      `UPDATE campaigns SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        objective = COALESCE($3, objective),
        deliverables = COALESCE($4, deliverables),
        budget = COALESCE($5, budget),
        currency = COALESCE($6, currency),
        creators_needed = COALESCE($7, creators_needed),
        min_followers = COALESCE($8, min_followers),
        required_platform = COALESCE($9, required_platform),
        required_niche = COALESCE($10, required_niche),
        application_deadline = COALESCE($11, application_deadline),
        deadline = COALESCE($12, deadline),
        status = COALESCE($13, status)
       WHERE id = $14
       RETURNING *`,
      [
        title, description, objective, deliverables, budget, currency,
        creators_needed, min_followers, required_platform, required_niche,
        application_deadline, deadline, status, req.params.id
      ]
    );

    res.json({ campaign: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update campaign" });
  }
});

// DELETE campaign (owner or admin)
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM campaigns WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (existing.rows[0].business_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized to delete this campaign" });
    }

    await pool.query("DELETE FROM campaigns WHERE id = $1", [req.params.id]);
    res.json({ message: "Campaign deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete campaign" });
  }
});

module.exports = router;
