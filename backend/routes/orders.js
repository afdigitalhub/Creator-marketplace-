const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

// Platform commission. Applies to every sale with no exceptions.
// Read from platform_settings so it can be changed without a deploy,
// falling back to 10 if the setting has not been created yet.
async function getCommissionRate() {
  try {
    const result = await pool.query(
      "SELECT value FROM platform_settings WHERE key = 'commission_rate'"
    );
    if (result.rows.length > 0) {
      const parsed = parseFloat(result.rows[0].value);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) return parsed;
    }
  } catch (err) {
    console.error("Could not read commission rate, using default:", err);
  }
  return 10;
}

// Money is rounded to 2 decimal places at the point of calculation so the
// three amounts always add up exactly. seller_amount is derived by
// subtraction, never calculated separately, so rounding can never create
// or destroy money.
function calculateAmounts(price, ratePercent) {
  const gross = Math.round(Number(price) * 100) / 100;
  const commission = Math.round(gross * (ratePercent / 100) * 100) / 100;
  const seller = Math.round((gross - commission) * 100) / 100;
  return { gross, commission, seller };
}

// POST /orders - create a pending order for a product.
// No payment is taken. This records the intent to buy and the exact
// financial breakdown at this moment in time.
router.post("/", requireAuth, async (req, res) => {
  const { product_id } = req.body;

  if (!product_id) {
    return res.status(400).json({ error: "product_id is required" });
  }

  try {
    // Price, seller and title all come from the database.
    // Nothing about money is ever taken from the request body.
    const productResult = await pool.query(
      "SELECT * FROM products WHERE id = $1",
      [product_id]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = productResult.rows[0];

    if (product.status !== "published") {
      return res.status(400).json({ error: "This product is not available for purchase" });
    }

    if (product.seller_id === req.user.id) {
      return res.status(400).json({ error: "You cannot buy your own product" });
    }

    // If they already own it, do not create a second order.
    const existingEntitlement = await pool.query(
      "SELECT id FROM entitlements WHERE user_id = $1 AND product_id = $2 AND status = 'active'",
      [req.user.id, product_id]
    );
    if (existingEntitlement.rows.length > 0) {
      return res.status(400).json({ error: "You already own this product" });
    }

    // Reuse an existing pending order for the same product rather than
    // creating a new one every time the button is tapped.
    const existingOrder = await pool.query(
      `SELECT * FROM orders
       WHERE buyer_id = $1 AND product_id = $2 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, product_id]
    );
    if (existingOrder.rows.length > 0) {
      return res.json({ order: existingOrder.rows[0], reused: true });
    }

    const ratePercent = await getCommissionRate();
    const { gross, commission, seller } = calculateAmounts(product.price, ratePercent);

    const result = await pool.query(
      `INSERT INTO orders
        (buyer_id, seller_id, product_id, product_title,
         gross_amount, currency, commission_rate, commission_amount,
         seller_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
       RETURNING *`,
      [
        req.user.id,
        product.seller_id,
        product.id,
        product.title,
        gross,
        product.currency || "GHS",
        ratePercent,
        commission,
        seller
      ]
    );

    res.status(201).json({ order: result.rows[0] });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ error: "Could not create order" });
  }
});

// GET /orders/mine - the buyer's own orders
router.get("/mine", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, p.cover_url
       FROM orders o
       LEFT JOIN products p ON o.product_id = p.id
       WHERE o.buyer_id = $1
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error("List my orders error:", err);
    res.status(500).json({ error: "Could not load your orders" });
  }
});

// GET /orders/:id - a single order, visible only to its buyer or seller
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = result.rows[0];

    if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to view this order" });
    }

    res.json({ order });
  } catch (err) {
    console.error("Get order error:", err);
    res.status(500).json({ error: "Could not load order" });
  }
});

module.exports = router;
