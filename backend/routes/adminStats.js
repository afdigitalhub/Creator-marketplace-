const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET /admin-stats - a real picture of the platform.
// Every figure here is computed from actual records. Nothing estimated.
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    // Keep earnings current before reporting on them.
    await pool.query("SELECT mature_earnings()");

    const [
      moneyResult,
      orderResult,
      earningsResult,
      withdrawalResult,
      peopleResult,
      productResult,
      marketplaceResult,
      recentOrdersResult,
      topProductsResult
    ] = await Promise.all([

      // Money: only paid orders count as revenue
      pool.query(`
        SELECT
          COALESCE(SUM(gross_amount), 0)      AS gross_revenue,
          COALESCE(SUM(commission_amount), 0) AS platform_commission,
          COALESCE(SUM(seller_amount), 0)     AS seller_share,
          COUNT(*)                            AS paid_orders,
          MAX(currency)                       AS currency
        FROM orders WHERE status = 'paid'
      `),

      // Orders by status
      pool.query(`
        SELECT status, COUNT(*) AS count
        FROM orders GROUP BY status
      `),

      // Earnings ledger
      pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'pending'   THEN net_amount ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN status = 'available' THEN net_amount ELSE 0 END), 0) AS available,
          COALESCE(SUM(CASE WHEN status = 'withdrawn' THEN net_amount ELSE 0 END), 0) AS withdrawn
        FROM earnings
      `),

      // Withdrawals
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('requested','processing')) AS awaiting,
          COALESCE(SUM(amount) FILTER (WHERE status IN ('requested','processing')), 0) AS awaiting_amount,
          COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) AS paid_out,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed_count
        FROM withdrawals
      `),

      // People
      pool.query(`
        SELECT
          COUNT(*) AS total_users,
          COUNT(*) FILTER (WHERE role = 'creator')  AS creators,
          COUNT(*) FILTER (WHERE role = 'business') AS businesses,
          COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS new_this_month
        FROM users
      `),

      // Products
      pool.query(`
        SELECT
          COUNT(*) AS total_products,
          COUNT(*) FILTER (WHERE status = 'published') AS published,
          COUNT(*) FILTER (WHERE status = 'draft')     AS drafts
        FROM products
      `),

      // Creator/business marketplace activity
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM campaigns)                                  AS campaigns,
          (SELECT COUNT(*) FROM campaign_applications)                      AS applications,
          (SELECT COUNT(*) FROM campaign_applications WHERE status='accepted') AS accepted,
          (SELECT COUNT(*) FROM campaign_deliverables)                      AS deliverables,
          (SELECT COUNT(*) FROM conversations)                              AS conversations,
          (SELECT COUNT(*) FROM reports WHERE status = 'pending')           AS open_reports
      `),

      // Recent paid orders
      pool.query(`
        SELECT o.product_title, o.gross_amount, o.currency, o.created_at,
               u.full_name AS buyer_name
        FROM orders o
        LEFT JOIN users u ON o.buyer_id = u.id
        WHERE o.status = 'paid'
        ORDER BY o.created_at DESC
        LIMIT 5
      `),

      // Best selling products
      pool.query(`
        SELECT product_title,
               COUNT(*) AS sales,
               COALESCE(SUM(gross_amount), 0) AS revenue,
               MAX(currency) AS currency
        FROM orders
        WHERE status = 'paid'
        GROUP BY product_title
        ORDER BY sales DESC, revenue DESC
        LIMIT 5
      `)
    ]);

    // Turn the order status rows into a simple object
    const ordersByStatus = {};
    orderResult.rows.forEach(r => {
      ordersByStatus[r.status] = Number(r.count);
    });

    res.json({
      money: moneyResult.rows[0],
      orders_by_status: ordersByStatus,
      earnings: earningsResult.rows[0],
      withdrawals: withdrawalResult.rows[0],
      people: peopleResult.rows[0],
      products: productResult.rows[0],
      marketplace: marketplaceResult.rows[0],
      recent_orders: recentOrdersResult.rows,
      top_products: topProductsResult.rows
    });

  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ error: "Could not load platform statistics" });
  }
});

module.exports = router;
