const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Normalise the endpoint so common copy-paste mistakes cannot break it:
// missing https://, trailing slash, or the bucket name accidentally appended.
function normaliseEndpoint(raw, bucketName) {
  if (!raw) return null;
  let ep = String(raw).trim();
  if (!/^https?:\/\//i.test(ep)) ep = "https://" + ep;
  ep = ep.replace(/\/+$/, "");
  if (bucketName && ep.toLowerCase().endsWith("/" + String(bucketName).trim().toLowerCase())) {
    ep = ep.slice(0, -(String(bucketName).trim().length + 1));
  }
  return ep;
}

const R2_BUCKET = (process.env.R2_BUCKET_NAME || "").trim();
const R2_ENDPOINT = normaliseEndpoint(process.env.R2_ENDPOINT, R2_BUCKET);
const R2_KEY_ID = (process.env.R2_ACCESS_KEY_ID || "").trim();
const R2_SECRET = (process.env.R2_SECRET_ACCESS_KEY || "").trim();

let r2 = null;
if (R2_ENDPOINT && R2_KEY_ID && R2_SECRET) {
  r2 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_KEY_ID, secretAccessKey: R2_SECRET }
  });
}

const PUBLIC_FIELDS = `
  p.id, p.seller_id, p.title, p.subtitle, p.description, p.category,
  p.tags, p.cover_url, p.preview_url, p.price, p.currency, p.status,
  p.is_featured, p.created_at
`;

// Admin-only storage health check. Reports exactly what is wrong,
// without ever revealing secret values.
router.get("/storage/health", requireAuth, requireRole("admin"), async (req, res) => {
  const report = {
    bucket_name_set: Boolean(R2_BUCKET),
    bucket_name: R2_BUCKET || null,
    access_key_set: Boolean(R2_KEY_ID),
    access_key_length: R2_KEY_ID.length,
    secret_set: Boolean(R2_SECRET),
    secret_length: R2_SECRET.length,
    endpoint_raw_set: Boolean(process.env.R2_ENDPOINT),
    endpoint_normalised: R2_ENDPOINT,
    endpoint_looks_valid: Boolean(R2_ENDPOINT && /^https:\/\/.+\.r2\.cloudflarestorage\.com$/i.test(R2_ENDPOINT)),
    client_created: Boolean(r2)
  };

  if (!r2) {
    report.can_sign = false;
    report.error = "R2 client not created. One or more environment variables are missing.";
    return res.json(report);
  }

  try {
    const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: "connection-test.pdf" });
    const url = await getSignedUrl(r2, command, { expiresIn: 60 });
    report.can_sign = true;
    report.signed_url_host = new URL(url).host;
  } catch (err) {
    report.can_sign = false;
    report.error = err.message;
    report.error_name = err.name;
  }

  res.json(report);
});

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

// GET all products regardless of status (admin only)
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

// Secure, short-lived download link. Requires login AND an active entitlement.
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

    if (!r2) {
      return res.status(500).json({
        error: "File storage is not configured correctly. Please contact support.",
        detail: "R2 client unavailable: missing environment configuration"
      });
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

    const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: storageKey });
    const url = await getSignedUrl(r2, command, { expiresIn: 300 });

    res.json({ url, expires_in: 300 });
  } catch (err) {
    console.error("Download link error:", err);
    res.status(500).json({
      error: "Could not generate download link",
      detail: err.message,
      detail_name: err.name
    });
  }
});

// GET single product by id (public)
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

// POST create product (admin only)
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

// PUT update product
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

// DELETE product
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
