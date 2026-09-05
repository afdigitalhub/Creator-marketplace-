const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

// --- USERS ---

// View all users
router.get("/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, role FROM users ORDER BY id DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error("Admin list users error:", err);
    res.status(500).json({ error: "Server error fetching users" });
  }
});

// --- CAMPAIGNS ---

// View all campaigns (regardless of owner)
router.get("/campaigns", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    // campaigns.business_id is a business_profiles.id, not users.id —
    // join through business_profiles to reach the real business owner.
    const result = await pool.query(
      `SELECT c.*, u.full_name AS business_name
       FROM campaigns c
       JOIN business_profiles bp ON c.business_id = bp.id
       JOIN users u ON bp.user_id = u.id
       ORDER BY c.created_at DESC`
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error("Admin list campaigns error:", err);
    res.status(500).json({ error: "Server error fetching campaigns" });
  }
});

// Remove a campaign (e.g. for violating platform rules)
router.delete("/campaigns/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const check = await pool.query("SELECT * FROM campaigns WHERE id = $1", [req.params.id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    await pool.query("DELETE FROM campaigns WHERE id = $1", [req.params.id]);
    res.json({ message: "Campaign removed by admin" });
  } catch (err) {
    console.error("Admin delete campaign error:", err);
    res.status(500).json({ error: "Server error deleting campaign" });
  }
});

// --- REPORTS ---

// Anyone can file a report against a user or a campaign
router.post("/reports", requireAuth, async (req, res) => {
  try {
    const { target_id, target_type, reason } = req.body;

    if (!target_id || !target_type || !reason) {
      return res.status(400).json({ error: "target_id, target_type, and reason are required" });
    }

    const result = await pool.query(
      `INSERT INTO reports (target_id, reporter_id, target_type, reason, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       RETURNING *`,
      [target_id, req.user.id, target_type, reason]
    );

    res.status(201).json({ report: result.rows[0] });
  } catch (err) {
    console.error("Create report error:", err);
    res.status(500).json({ error: "Server error creating report" });
  }
});

// Admin views all reports
router.get("/reports", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.full_name AS reporter_name
       FROM reports r
       JOIN users u ON r.reporter_id = u.id
       ORDER BY r.created_at DESC`
    );
    res.json({ reports: result.rows });
  } catch (err) {
    console.error("Admin list reports error:", err);
    res.status(500).json({ error: "Server error fetching reports" });
  }
});

// Admin resolves a report
router.put("/reports/:id/resolve", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const check = await pool.query("SELECT * FROM reports WHERE id = $1", [req.params.id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Report not found" });
    }

    const result = await pool.query(
      `UPDATE reports SET status = 'resolved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    res.json({ report: result.rows[0] });
  } catch (err) {
    console.error("Admin resolve report error:", err);
    res.status(500).json({ error: "Server error resolving report" });
  }
});

// --- PLATFORM SETTINGS ---

// View all settings
router.get("/settings", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM platform_settings`);
    res.json({ settings: result.rows });
  } catch (err) {
    console.error("Admin list settings error:", err);
    res.status(500).json({ error: "Server error fetching settings" });
  }
});

// Update or create a setting
router.put("/settings/:key", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ error: "value is required" });
    }

    const result = await pool.query(
      `INSERT INTO platform_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2
       RETURNING *`,
      [req.params.key, value]
    );

    res.json({ setting: result.rows[0] });
  } catch (err) {
    console.error("Admin update setting error:", err);
    res.status(500).json({ error: "Server error updating setting" });
  }
});

module.exports = router;
