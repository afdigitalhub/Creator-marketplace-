const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

/*
  Create a normal notification.
  Other route files can import this:
  const { createNotification } = require("./notifications");
*/
async function createNotification(userId, type, message) {
  try {
    await pool.query(
      `INSERT INTO notifications
        (user_id, type, message, read, created_at)
       VALUES ($1, $2, $3, false, NOW())`,
      [userId, type, message]
    );
  } catch (err) {
    console.error("Create notification error:", err);
  }
}

/*
  Friday withdrawal notification.

  Withdrawals are live every Friday:
  12:00 AM - 5:30 PM.

  We use a unique daily marker so the same user
  does not receive the same Friday notification
  repeatedly.
*/
async function ensureWithdrawalWindowNotification(userId) {
  try {
    const now = new Date();

    // JavaScript: Sunday = 0, Monday = 1 ... Friday = 5
    if (now.getUTCDay() !== 5) {
      return;
    }

    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const currentMinutes = hour * 60 + minute;

    // Friday 12:00 AM through 5:30 PM
    if (currentMinutes < 0 || currentMinutes > 17 * 60 + 30) {
      return;
    }

    const today = now.toISOString().slice(0, 10);

    const notificationType = "withdrawal_window";
    const message =
      "Withdrawals are live now. You can submit your withdrawal request until 5:30 PM today. There are no withdrawal charges.";

    // Check whether today's notification already exists.
    const existing = await pool.query(
      `SELECT id
       FROM notifications
       WHERE user_id = $1
         AND type = $2
         AND created_at >= $3::date
         AND created_at < ($3::date + INTERVAL '1 day')
       LIMIT 1`,
      [
        userId,
        notificationType,
        today
      ]
    );

    if (existing.rows.length > 0) {
      return;
    }

    await createNotification(
      userId,
      notificationType,
      message
    );
  } catch (err) {
    console.error(
      "Withdrawal window notification error:",
      err
    );
  }
}

/*
  Get my notifications.
*/
router.get("/", requireAuth, async (req, res) => {
  try {
    // Check whether today's Friday withdrawal notification
    // should be created.
    await ensureWithdrawalWindowNotification(
      req.user.id
    );

    const result = await pool.query(
      `SELECT *
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({
      notifications: result.rows
    });
  } catch (err) {
    console.error(
      "List notifications error:",
      err
    );

    res.status(500).json({
      error:
        "Server error fetching notifications"
    });
  }
});

/*
  Get unread notification count.
*/
router.get(
  "/unread-count",
  requireAuth,
  async (req, res) => {
    try {
      await ensureWithdrawalWindowNotification(
        req.user.id
      );

      const result = await pool.query(
        `SELECT COUNT(*) AS unread_count
         FROM notifications
         WHERE user_id = $1
           AND read = false`,
        [req.user.id]
      );

      res.json({
        unread_count: parseInt(
          result.rows[0].unread_count,
          10
        )
      });
    } catch (err) {
      console.error(
        "Unread count error:",
        err
      );

      res.status(500).json({
        error:
          "Server error fetching unread count"
      });
    }
  }
);

/*
  Mark one notification as read.
*/
router.put(
  "/:id/read",
  requireAuth,
  async (req, res) => {
    try {
      const check = await pool.query(
        `SELECT *
         FROM notifications
         WHERE id = $1`,
        [req.params.id]
      );

      if (check.rows.length === 0) {
        return res.status(404).json({
          error: "Notification not found"
        });
      }

      if (
        String(check.rows[0].user_id) !==
        String(req.user.id)
      ) {
        return res.status(403).json({
          error:
            "Not authorized to update this notification"
        });
      }

      const result = await pool.query(
        `UPDATE notifications
         SET read = true
         WHERE id = $1
         RETURNING *`,
        [req.params.id]
      );

      res.json({
        notification: result.rows[0]
      });
    } catch (err) {
      console.error(
        "Mark read error:",
        err
      );

      res.status(500).json({
        error:
          "Server error updating notification"
      });
    }
  }
);

/*
  Mark all notifications as read.
*/
router.put(
  "/read-all",
  requireAuth,
  async (req, res) => {
    try {
      await pool.query(
        `UPDATE notifications
         SET read = true
         WHERE user_id = $1`,
        [req.user.id]
      );

      res.json({
        message:
          "All notifications marked as read"
      });
    } catch (err) {
      console.error(
        "Mark all read error:",
        err
      );

      res.status(500).json({
        error:
          "Server error updating notifications"
      });
    }
  }
);

module.exports = router;
module.exports.createNotification =
  createNotification;
module.exports.ensureWithdrawalWindowNotification =
  ensureWithdrawalWindowNotification;
