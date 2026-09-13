const express = require("express");
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const PLATFORM_COMMISSION_RATE = 0.10; // same 10% used across the platform

const CATEGORY_LABELS = {
  errand: "Local Errand",
  voice: "Voice & Language",
  review: "Quick Review",
  price_check: "Price Check"
};

function serializeGig(row) {
  return {
    id: row.id,
    poster_id: row.poster_id,
    poster_name: row.poster_name || null,
    worker_id: row.worker_id,
    worker_name: row.worker_name || null,
    category: row.category,
    category_label: CATEGORY_LABELS[row.category] || row.category,
    title: row.title,
    description: row.description,
    city: row.city,
    price: row.price,
    currency: row.currency,
    status: row.status,
    submission_text: row.submission_text,
    submission_file_url: row.submission_file_url,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    claimed_at: row.claimed_at,
    created_at: row.created_at
  };
}

/*
  POST /gigs
  Create a new gig. Starts as "pending_payment" until payment is confirmed.
  ────────────────────────────────────────────────────────────────────
  PAYMENT NOTE: This route creates the gig row and returns its id, but
  does NOT yet call Paystack directly. Once we see how payments.js
  initializes a Paystack transaction for existing orders, we plug that
  same call in here (right where marked below) so a gig follows the
  exact same, already-trusted payment path as everything else on the
  platform, rather than a newly invented one.
*/
router.post("/", requireAuth, async (req, res) => {
  try {
    const posterId = req.user.id || req.user.userId;
    const { category, title, description, city, price, currency } = req.body || {};

    if (!category || !CATEGORY_LABELS[category]) {
      return res.status(400).json({ error: "A valid category is required." });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Title is required." });
    }
    if (!description || !description.trim()) {
      return res.status(400).json({ error: "Description is required." });
    }
    if (category === "errand" && (!city || !city.trim())) {
      return res.status(400).json({ error: "City is required for local errands." });
    }
    const numericPrice = Number(price);
    if (!numericPrice || numericPrice <= 0) {
      return res.status(400).json({ error: "Price must be a positive number." });
    }

    const result = await pool.query(
      `INSERT INTO gigs (poster_id, category, title, description, city, price, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_payment')
       RETURNING *`,
      [posterId, category, title.trim(), description.trim(), city ? city.trim() : null, numericPrice, currency || "GHS"]
    );

    const gig = result.rows[0];

    // ── PAYMENT INTEGRATION POINT ─────────────────────────────────
    // Once payments.js is reviewed, this is where we call the same
    // Paystack initialize function already used for product orders,
    // passing gig.price and gig.id as the reference metadata, then
    // return the authorization_url the same way orders.js already does.
    // Until then, the gig stays in "pending_payment" and won't show
    // in the open feed.
    // ───────────────────────────────────────────────────────────────

    return res.status(201).json({
      success: true,
      gig: serializeGig(gig),
      message: "Gig created. Payment step will be connected next."
    });

  } catch (error) {
    console.error("Create gig error:", error);
    return res.status(500).json({ error: "Could not create gig." });
  }
});


/*
  GET /gigs
  List open gigs, optionally filtered by category or city.
*/
router.get("/", async (req, res) => {
  try {
    const { category, city } = req.query;

    const conditions = ["g.status = 'open'"];
    const params = [];

    if (category && CATEGORY_LABELS[category]) {
      params.push(category);
      conditions.push(`g.category = $${params.length}`);
    }

    if (city) {
      params.push(`%${city}%`);
      conditions.push(`g.city ILIKE $${params.length}`);
    }

    const result = await pool.query(
      `SELECT g.*, u.full_name AS poster_name
       FROM gigs g
       LEFT JOIN users u ON g.poster_id = u.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY g.created_at DESC
       LIMIT 100`,
      params
    );

    return res.json({
      success: true,
      gigs: result.rows.map(serializeGig)
    });

  } catch (error) {
    console.error("List gigs error:", error);
    return res.status(500).json({ error: "Could not load gigs." });
  }
});


/*
  GET /gigs/mine
  Gigs the current user posted, and gigs they're working on.
*/
router.get("/mine", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;

    const posted = await pool.query(
      `SELECT g.*, u.full_name AS worker_name
       FROM gigs g
       LEFT JOIN users u ON g.worker_id = u.id
       WHERE g.poster_id = $1
       ORDER BY g.created_at DESC`,
      [userId]
    );

    const working = await pool.query(
      `SELECT g.*, u.full_name AS poster_name
       FROM gigs g
       LEFT JOIN users u ON g.poster_id = u.id
       WHERE g.worker_id = $1
       ORDER BY g.created_at DESC`,
      [userId]
    );

    return res.json({
      success: true,
      posted: posted.rows.map(serializeGig),
      working: working.rows.map(serializeGig)
    });

  } catch (error) {
    console.error("My gigs error:", error);
    return res.status(500).json({ error: "Could not load your gigs." });
  }
});


/*
  GET /gigs/:id
*/
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.*, pu.full_name AS poster_name, wu.full_name AS worker_name
       FROM gigs g
       LEFT JOIN users pu ON g.poster_id = pu.id
       LEFT JOIN users wu ON g.worker_id = wu.id
       WHERE g.id = $1`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Gig not found." });
    }

    return res.json({ success: true, gig: serializeGig(result.rows[0]) });

  } catch (error) {
    console.error("Get gig error:", error);
    return res.status(500).json({ error: "Could not load gig." });
  }
});


/*
  POST /gigs/:id/claim
  First qualified user to claim an open gig gets assigned to it.
*/
router.post("/:id/claim", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;

    const gigResult = await pool.query("SELECT * FROM gigs WHERE id = $1", [req.params.id]);
    if (!gigResult.rows.length) {
      return res.status(404).json({ error: "Gig not found." });
    }

    const gig = gigResult.rows[0];

    if (gig.poster_id === userId) {
      return res.status(400).json({ error: "You can't claim your own gig." });
    }
    if (gig.status !== "open") {
      return res.status(409).json({ error: "This gig is no longer available to claim." });
    }

    const updateResult = await pool.query(
      `UPDATE gigs
       SET worker_id = $1, status = 'assigned', claimed_at = now()
       WHERE id = $2 AND status = 'open'
       RETURNING *`,
      [userId, req.params.id]
    );

    if (!updateResult.rows.length) {
      return res.status(409).json({ error: "Someone else just claimed this gig." });
    }

    return res.json({ success: true, gig: serializeGig(updateResult.rows[0]) });

  } catch (error) {
    console.error("Claim gig error:", error);
    return res.status(500).json({ error: "Could not claim gig." });
  }
});


/*
  POST /gigs/:id/submit
  Worker submits their completed work.
*/
router.post("/:id/submit", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const { submission_text, submission_file_url } = req.body || {};

    if (!submission_text && !submission_file_url) {
      return res.status(400).json({ error: "Please provide a written submission, a file, or both." });
    }

    const gigResult = await pool.query("SELECT * FROM gigs WHERE id = $1", [req.params.id]);
    if (!gigResult.rows.length) {
      return res.status(404).json({ error: "Gig not found." });
    }

    const gig = gigResult.rows[0];

    if (gig.worker_id !== userId) {
      return res.status(403).json({ error: "Only the assigned worker can submit this gig." });
    }
    if (gig.status !== "assigned") {
      return res.status(409).json({ error: "This gig isn't in a submittable state." });
    }

    const updateResult = await pool.query(
      `UPDATE gigs
       SET status = 'submitted', submission_text = $1, submission_file_url = $2, submitted_at = now()
       WHERE id = $3
       RETURNING *`,
      [submission_text || null, submission_file_url || null, req.params.id]
    );

    return res.json({ success: true, gig: serializeGig(updateResult.rows[0]) });

  } catch (error) {
    console.error("Submit gig error:", error);
    return res.status(500).json({ error: "Could not submit gig." });
  }
});


/*
  POST /gigs/:id/approve
  Poster approves submitted work. This is where escrowed payment
  would be released: 90% to the worker's earnings, 10% platform
  commission — matching the same split already used elsewhere.
  ────────────────────────────────────────────────────────────────
  Left as a clear, honest TODO rather than a guess: once we see the
  real "earnings" table columns, this inserts a row crediting the
  worker exactly like campaign payouts already do.
*/
router.post("/:id/approve", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;

    const gigResult = await pool.query("SELECT * FROM gigs WHERE id = $1", [req.params.id]);
    if (!gigResult.rows.length) {
      return res.status(404).json({ error: "Gig not found." });
    }

    const gig = gigResult.rows[0];

    if (gig.poster_id !== userId) {
      return res.status(403).json({ error: "Only the poster can approve this gig." });
    }
    if (gig.status !== "submitted") {
      return res.status(409).json({ error: "This gig isn't awaiting approval." });
    }

    const commission = Number(gig.price) * PLATFORM_COMMISSION_RATE;
    const workerShare = Number(gig.price) - commission;

    const updateResult = await pool.query(
      `UPDATE gigs SET status = 'approved', approved_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    // ── EARNINGS INTEGRATION POINT ─────────────────────────────────
    // await pool.query(
    //   `INSERT INTO earnings (<real columns once confirmed>)
    //    VALUES (...)`,
    //   [gig.worker_id, workerShare, ...]
    // );
    // ─────────────────────────────────────────────────────────────

    return res.json({
      success: true,
      gig: serializeGig(updateResult.rows[0]),
      worker_share: workerShare,
      commission
    });

  } catch (error) {
    console.error("Approve gig error:", error);
    return res.status(500).json({ error: "Could not approve gig." });
  }
});


module.exports = router;
