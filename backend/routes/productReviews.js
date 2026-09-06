const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

// GET /product-reviews/product/:productId
// Public. Anyone can read reviews for a product.
router.get("/product/:productId", async (req, res) => {
  try {
    const listResult = await pool.query(
      `SELECT r.id, r.rating, r.comment, r.created_at, u.full_name AS reviewer_name
       FROM product_reviews r
       JOIN users u ON r.reviewer_id = u.id
       WHERE r.product_id = $1
       ORDER BY r.created_at DESC`,
      [req.params.productId]
    );

    const summaryResult = await pool.query(
      `SELECT
         ROUND(AVG(rating)::numeric, 1) AS average_rating,
         COUNT(*) AS total_reviews,
         COUNT(*) FILTER (WHERE rating = 5) AS five_star,
         COUNT(*) FILTER (WHERE rating = 4) AS four_star,
         COUNT(*) FILTER (WHERE rating = 3) AS three_star,
         COUNT(*) FILTER (WHERE rating = 2) AS two_star,
         COUNT(*) FILTER (WHERE rating = 1) AS one_star
       FROM product_reviews
       WHERE product_id = $1`,
      [req.params.productId]
    );

    res.json({
      reviews: listResult.rows,
      summary: summaryResult.rows[0]
    });
  } catch (err) {
    console.error("List product reviews error:", err);
    res.status(500).json({ error: "Could not load reviews" });
  }
});

// GET /product-reviews/eligibility/:productId
// Tells the logged-in user whether they can review this product,
// and returns their existing review if they have one.
router.get("/eligibility/:productId", requireAuth, async (req, res) => {
  try {
    // A paid order for this product by this user is the only thing
    // that grants review rights.
    const orderResult = await pool.query(
      `SELECT id FROM orders
       WHERE buyer_id = $1 AND product_id = $2 AND status = 'paid'
       ORDER BY created_at ASC LIMIT 1`,
      [req.user.id, req.params.productId]
    );

    if (orderResult.rows.length === 0) {
      return res.json({ can_review: false, reason: "no_purchase", existing_review: null });
    }

    const orderId = orderResult.rows[0].id;

    const existing = await pool.query(
      "SELECT id, rating, comment, created_at FROM product_reviews WHERE order_id = $1",
      [orderId]
    );

    if (existing.rows.length > 0) {
      return res.json({
        can_review: false,
        reason: "already_reviewed",
        order_id: orderId,
        existing_review: existing.rows[0]
      });
    }

    res.json({ can_review: true, order_id: orderId, existing_review: null });
  } catch (err) {
    console.error("Review eligibility error:", err);
    res.status(500).json({ error: "Could not check review eligibility" });
  }
});

// POST /product-reviews
// Leave a review. Purchase is verified server-side; nothing about
// eligibility is trusted from the request.
router.post("/", requireAuth, async (req, res) => {
  const { product_id, rating, comment } = req.body;

  if (!product_id || !rating) {
    return res.status(400).json({ error: "product_id and rating are required" });
  }

  const numericRating = Number(rating);
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    return res.status(400).json({ error: "Rating must be a whole number between 1 and 5" });
  }

  if (comment && String(comment).length > 2000) {
    return res.status(400).json({ error: "Comment must be 2000 characters or fewer" });
  }

  try {
    // Confirm a genuine paid purchase exists for this user and product.
    const orderResult = await pool.query(
      `SELECT id FROM orders
       WHERE buyer_id = $1 AND product_id = $2 AND status = 'paid'
       ORDER BY created_at ASC LIMIT 1`,
      [req.user.id, product_id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(403).json({ error: "You can only review products you have purchased" });
    }

    const orderId = orderResult.rows[0].id;

    const existing = await pool.query(
      "SELECT id FROM product_reviews WHERE order_id = $1",
      [orderId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "You have already reviewed this product" });
    }

    const result = await pool.query(
      `INSERT INTO product_reviews (product_id, order_id, reviewer_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, rating, comment, created_at`,
      [product_id, orderId, req.user.id, numericRating, comment ? String(comment).trim() : null]
    );

    res.status(201).json({ review: result.rows[0] });
  } catch (err) {
    // The UNIQUE constraint on order_id is the final guard against duplicates.
    if (err.code === "23505") {
      return res.status(400).json({ error: "You have already reviewed this product" });
    }
    console.error("Create product review error:", err);
    res.status(500).json({ error: "Could not save your review" });
  }
});

// PUT /product-reviews/:id - edit your own review
router.put("/:id", requireAuth, async (req, res) => {
  const { rating, comment } = req.body;

  if (rating !== undefined) {
    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ error: "Rating must be a whole number between 1 and 5" });
    }
  }

  if (comment && String(comment).length > 2000) {
    return res.status(400).json({ error: "Comment must be 2000 characters or fewer" });
  }

  try {
    const existing = await pool.query(
      "SELECT * FROM product_reviews WHERE id = $1",
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Review not found" });
    }

    if (existing.rows[0].reviewer_id !== req.user.id) {
      return res.status(403).json({ error: "You can only edit your own review" });
    }

    const result = await pool.query(
      `UPDATE product_reviews
       SET rating = COALESCE($1, rating),
           comment = COALESCE($2, comment),
           updated_at = now()
       WHERE id = $3
       RETURNING id, rating, comment, created_at, updated_at`,
      [rating !== undefined ? Number(rating) : null, comment !== undefined ? String(comment).trim() : null, req.params.id]
    );

    res.json({ review: result.rows[0] });
  } catch (err) {
    console.error("Update product review error:", err);
    res.status(500).json({ error: "Could not update your review" });
  }
});

module.exports = router;
