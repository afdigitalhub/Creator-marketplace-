const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// R2 client. Credentials come from environment variables only,
// never from code and never from the repository.
const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

// Fields safe to return publicly. file_url and storage_key are
// deliberately excluded so file locations are never exposed.
const PUBLIC_FIELDS = `
  p.id, p.seller_id, p.title, p.subtitle, p.description, p.category,
  p.tags, p.cover_url, p.preview_url, p.price, p.currency, p.status,
  p.is_featured, p.created_at
`;

// GET all published products (public browsing, no login required)
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${PUBLIC_FIELDS}, u.full_name AS seller_name
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

// GET a secure, short-lived download link.
// Requires login AND an active entitlement for this product.
router.get("/:id/download", requireAuth, async (req, res) => {
  try {
    const entitlement = await pool.query(
      `SELECT id FROM entitlements
       WHERE user_id = $1 AND product_id = $2 AND status = 'active'`,
      [req.user.id, req.params.id]
    );

    if (entitlement.rows.length === 0) {
      return res.status(403).json({ error: "You do not have access to this product" });
    }

    const productResult = await pool.query(
      "SELECT storage_key, title FROM products WHERE id = $1",
      [req.params.id]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    const storageKey = productResult.rows[0].storage_key;

    if (!storageKey) {
      return res.status(500).json({ error: "This product's file is not available for download yet" });
    }

    // Link is valid for 5 minutes only.
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: storageKey
    });

    const url = await getSignedUrl(r2, command, { expiresIn: 300 });

    res.json({ url, expires_in: 300 });
  } catch (err) {
    console.error("Download link error:", err);
    res.status(500).json({ error: "Could not generate download link" });
  }
});

// GET single product by id (public, no login required)
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${PUBLIC_FIELDS}, u.full_name AS seller_name
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
