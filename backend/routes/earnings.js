const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const { ensureWithdrawalWindowNotification } = require("./notifications");

// GET /earnings
// Complete personal earnings dashboard.
// Currency balances are kept separate and are never added together.
router.get("/", requireAuth, async (req, res) => {
  try {
    // Mature any earnings that have reached their available date.
    await pool.query("SELECT mature_earnings()");

    // Create the weekly withdrawal notification when appropriate.
    await ensureWithdrawalWindowNotification(req.user.id);

    // Logged-in user's basic withdrawal/account information.
    const userResult = await pool.query(
      `SELECT
         id,
         full_name,
         email,
         phone,
         phone_verified
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    const user = userResult.rows[0] || null;

    // Earnings are grouped by currency.
    // This prevents GHS, USD, EUR, etc. from being incorrectly combined.
    const currencyResult = await pool.query(
      `SELECT
         currency,

         COALESCE(
           SUM(
             CASE
               WHEN status = 'pending'
               THEN net_amount
               ELSE 0
             END
           ), 0
         ) AS pending,

         COALESCE(
           SUM(
             CASE
               WHEN status = 'available'
               THEN net_amount
               ELSE 0
             END
           ), 0
         ) AS available,

         COALESCE(
           SUM(
             CASE
               WHEN status = 'withdrawn'
               THEN net_amount
               ELSE 0
             END
           ), 0
         ) AS withdrawn,

         COALESCE(
           SUM(
             CASE
               WHEN status IN ('pending', 'available')
               THEN net_amount
               ELSE 0
             END
           ), 0
         ) AS wallet,

         COALESCE(
           SUM(
             CASE
               WHEN status IN ('pending', 'available', 'withdrawn')
               THEN net_amount
               ELSE 0
             END
           ), 0
         ) AS lifetime,

         COALESCE(
           SUM(
             CASE
               WHEN created_at >= date_trunc('week', NOW())
               THEN net_amount
               ELSE 0
             END
           ), 0
         ) AS this_week,

         COALESCE(
           SUM(
             CASE
               WHEN created_at >= date_trunc('month', NOW())
               THEN net_amount
               ELSE 0
             END
           ), 0
         ) AS this_month,

         COUNT(*) FILTER (
           WHERE status IN ('pending', 'available', 'withdrawn')
         ) AS sale_count

       FROM earnings
       WHERE user_id = $1
       GROUP BY currency
       ORDER BY currency`,
      [req.user.id]
    );

    // Recent earnings/activity.
    const listResult = await pool.query(
      `SELECT
         e.id,
         e.source_type,
         e.gross_amount,
         e.platform_fee,
         e.net_amount,
         e.currency,
         e.status,
         e.available_at,
         e.created_at,
         o.product_title
       FROM earnings e
       LEFT JOIN orders o
         ON o.id::text = e.source_id
       WHERE e.user_id = $1
       ORDER BY e.created_at DESC
       LIMIT 100`,
      [req.user.id]
    );

    res.json({
      user,

      currencies: currencyResult.rows.map((row) => ({
        currency: row.currency,

        pending: Number(row.pending),
        available: Number(row.available),
        withdrawn: Number(row.withdrawn),

        // Wallet = money currently pending + available.
        wallet: Number(row.wallet),

        this_week: Number(row.this_week),
        this_month: Number(row.this_month),

        // Total earnings recorded for this currency.
        lifetime: Number(row.lifetime),

        sale_count: Number(row.sale_count)
      })),

      earnings: listResult.rows.map((row) => ({
        id: row.id,
        source_type: row.source_type,
        product_title: row.product_title || null,

        gross_amount: Number(row.gross_amount),
        platform_fee: Number(row.platform_fee
