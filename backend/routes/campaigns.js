const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

// Create a campaign (business only)
router.post("/", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const { title, description, budget, deadline } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: "Title and description are required" });
    }

    const result = await pool.query(
      `INSERT INTO campaigns (business_id, title, description, budget, deadline, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'open', NOW())
       RETURNING *`,
      [req.user.id, title, description, budget || null, deadline || null]
    );

    res.status(201).json({ campaign: result.rows[0] });
  } catch (err) {
    console.error("Create campaign error:", err);
    res.status(500).json({ error: "Server error creating campaign" });
  }
});

// Browse all campaigns (anyone logged in)
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.name AS business_name
       FROM campaigns c
       JOIN users u ON c.business_id = u.id
       ORDER BY c.created_at DESC`
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error("List campaigns error:", err);
    res.status(500).json({ error: "Server error fetching campaigns" });
  }
});

// Get single campaign by ID
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.name AS business_name
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
    console.error("Get campaign error:", err);
    res.status(500).json({ error: "Server error fetching campaign" });
  }
});

// Update a campaign (only the business that owns it)
router.put("/:id", requireAuth, requireRole("business"), async (req, res) => {
  try {
    const { title, description, budget, deadline, status } = req.body;

    const check = await pool.query(
      "SELECT * FROM campaigns WHERE id = $1",
      [req.params.id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (check.rows[0].business_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to edit this campaign" });
    }

    const result = await pool.query(
      `UPDATE campaigns
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           budget = COALESCE($3, budget),
           deadline = COALESCE($4, deadline),
           status = COALESCE($5, status)
       WHERE id = $6
       RETURNING *`,
      [title, description, budget, deadline, status, req.params.id]
    );

    res.json({ campaign: result.rows[0] });
  } catch (err) {
    console.error("Update campaign error:", err);
    res.status(500).json({ error: "Server error updating campaign" });
  }
});

module.exports = router;
