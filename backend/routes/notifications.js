const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

// Helper function other route files can import to create a notification
// Usage: const { createNotification } = require("./notifications");
async function createNotification(userId, type, message) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, message, read, created_at)
       VALUES ($1, $2, $3, false, NOW())`,
      [userId, type, message]
    );
  } catch (err) {
    console.error("Create notification error:", err);
  }
}

// Get my notifications (most recent first)
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({ notifications: result.rows });
  } catch (err) {
    console.error("List notifications error:", err);
    res.status(500).json({ error: "Server error fetching notifications" });
  }
});

// Get count of unread notifications (handy for a badge icon)
router.get("/unread-count", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS unread_count FROM notifications WHERE user_id = $1 AND read = false`,
      [req.user.id]
    );

    res.json({ unread_count: parseInt(result.rows[0].unread_count, 10) });
  } catch (err) {
    console.error("Unread count error:", err);
    res.status(500).json({ error: "Server error fetching unread count" });
  }
});

// Mark a single notification as read
router.put("/:id/read", requireAuth, async (req, res) => {
  try {
    const check = await pool.query("SELECT * FROM notifications WHERE id = $1", [req.params.id]);

    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Notification not found" });
    }

    if (check.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to update this notification" });
    }

    const result = await pool.query(
      `UPDATE notifications SET read = true WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    res.json({ notification: result.rows[0] });
  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ error: "Server error updating notification" });
  }
});

// Mark all my notifications as read
router.put("/read-all", requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET read = true WHERE user_id = $1`, [req.user.id]);
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("Mark all read error:", err);
    res.status(500).json({ error: "Server error updating notifications" });
  }
});

module.exports = router;
module.exports.createNotification = createNotification;
