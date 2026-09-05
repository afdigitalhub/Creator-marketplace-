const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET all published products (public browsing, no login required)
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.full_name AS seller_name
       FROM products p
       JOIN users u ON p.seller_id = u.id
       WHERE p.status = 'published'
       ORDER BY p.created_at DESC`
    );
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch products" });
  }
});

// GET all products regardless of status (admin only, for Manage Products page)
router.get("/admin/all", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.full_name AS seller_name
       FROM products p
       JOIN users u ON p.seller_id = u.id
       ORDER BY p.created_at DESC`
    );
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch products" });
  }
});

// GET single product by id (public, no login required)
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.full_name AS seller_name
       FROM products p
       JOIN users u ON p.seller_id = u.id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json({ product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch product" });
  }
});

// POST create product (founder/admin only for now)
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const {
    title, subtitle, description, category, tags,
    cover_url, preview_url, file_url, price, currency, status
  } = req.body;

  if (!title || !description || !category || !price) {
    return res.status(400).json({ error: "title, description, category, and price are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products
        (seller_id, title, subtitle, description, category, tags,
         cover_url, preview_url, file_url, price, currency, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        req.user.id, title, subtitle || null, description, category, tags || null,
        cover_url || null, preview_url || null, file_url || null,
        price, currency || "GHS", status || "draft"
      ]
    );
    res.status(201).json({ product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create product", detail: err.message });
  }
});

// PUT update product (owner/seller only)
router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    if (existing.rows[0].seller_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to edit this product" });
    }

    const {
      title, subtitle, description, category, tags,
      cover_url, preview_url, file_url, price, currency, status, is_featured
    } = req.body;

    const result = await pool.query(
      `UPDATE products SET
        title = COALESCE($1, title),
        subtitle = COALESCE($2, subtitle),
        description = COALESCE($3, description),
        category = COALESCE($4, category),
        tags = COALESCE($5, tags),
        cover_url = COALESCE($6, cover_url),
        preview_url = COALESCE($7, preview_url),
        file_url = COALESCE($8, file_url),
        price = COALESCE($9, price),
        currency = COALESCE($10, currency),
        status = COALESCE($11, status),
        is_featured = COALESCE($12, is_featured)
       WHERE id = $13
       RETURNING *`,
      [title, subtitle, description, category, tags, cover_url, preview_url, file_url, price, currency, status, is_featured, req.params.id]
    );

    res.json({ product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update product" });
  }
});

// DELETE product (owner/seller only)
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    if (existing.rows[0].seller_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to delete this product" });
    }

    await pool.query("DELETE FROM products WHERE id = $1", [req.params.id]);
    res.json({ message: "Product deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete product" });
  }
});

module.exports = router;
