const express = require("express");
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const PAYSTACK_SECRET = (process.env.PAYSTACK_SECRET_KEY || "").trim();
const PAYSTACK_BASE = "https://api.paystack.co";
const PLATFORM_COMMISSION_RATE = 0.10; // same 10% used across the platform

const CATEGORY_LABELS = {
  errand: "Local Errand",
  voice: "Voice & Language",
  review: "Quick Review",
  price_check: "Price Check",
  courses: "Courses"
};

function toMinorUnit(amount) {
  return Math.round(Number(amount) * 100);
}

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
  Create a new gig, sitting as "pending_payment" until the poster pays.
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

    return res.status(201).json({ success: true, gig: serializeGig(result.rows[0]) });

  } catch (error) {
    console.error("Create gig error:", error);
    return res.status(500).json({ error: "Could not create gig." });
  }
});


/*
  POST /gigs/:id/pay
  Starts a real Paystack transaction for this gig, the same way
  payments.js does for product orders: same base URL, same minor-unit
  conversion, same channel restriction, same reference storage.
*/
router.post("/:id/pay", requireAuth, async (req, res) => {
  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ error: "Payments are not configured yet" });
  }

  try {
    const userId = req.user.id || req.user.userId;

    const gigResult = await pool.query("SELECT * FROM gigs WHERE id = $1", [req.params.id]);
    if (!gigResult.rows.length) {
      return res.status(404).json({ error: "Gig not found." });
    }

    const gig = gigResult.rows[0];

    if (gig.poster_id !== userId) {
      return res.status(403).json({ error: "Only the poster can pay for this gig." });
    }
    if (gig.status !== "pending_payment") {
      return res.status(400).json({ error: "This gig has already been paid for or is no longer payable." });
    }

    const userResult = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
    const email = userResult.rows[0].email;

    const gigCurrency = String(gig.currency || "GHS").toUpperCase();

    const initRes = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        amount: toMinorUnit(gig.price),
        currency: gigCurrency,
        channels: ["card", "mobile_money", "bank", "bank_transfer", "ussd"],
        callback_url: "https://afdigitalhub.net/gig-payment-complete.html",
        metadata: {
          gig_id: gig.id,
          gig_title: gig.title,
          expected_currency: gigCurrency
        }
      })
    });

    const initData = await initRes.json();

    if (!initRes.ok || !initData.status) {
      console.error("Paystack init failed (gig):", initData);
      return res.status(502).json({
        error: "Could not start payment",
        detail: initData.message || "Payment provider rejected the request"
      });
    }

    const reference = initData.data.reference;

    await pool.query(
      "UPDATE gigs SET payment_reference = $1 WHERE id = $2",
      [reference, gig.id]
    );

    return res.json({
      authorization_url: initData.data.authorization_url,
      reference,
      currency: gigCurrency,
      amount: gig.price
    });

  } catch (error) {
    console.error("Gig payment init error:", error);
    return res.status(500).json({ error: "Could not start payment." });
  }
});


/*
  GET /gigs/verify/:reference
  Confirms the Paystack transaction actually succeeded, for the actual
  amount and currency the gig was created with, before the gig goes
  live in the feed. Mirrors the checks in payments.js exactly:
  currency match, amount match, idempotency if already processed.
*/
router.get("/verify/:reference", requireAuth, async (req, res) => {
  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ error: "Payments are not configured yet" });
  }

  try {
    const reference = req.params.reference;

    const gigResult = await pool.query("SELECT * FROM gigs WHERE payment_reference = $1", [reference]);
    if (!gigResult.rows.length) {
      return res.status(404).json({ error: "No gig found for this payment reference." });
    }

    const gig = gigResult.rows[0];

    if (gig.status !== "pending_payment") {
      return res.json({ success: true, already_processed: true, gig: serializeGig(gig) });
    }

    const verifyRes = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });
    const verifyData = await verifyRes.json();

    if (!verifyRes.ok || !verifyData.status) {
      return res.status(400).json({ error: "Payment could not be confirmed." });
    }

    const txn = verifyData.data;

    if (txn.status !== "success") {
      return res.status(400).json({ error: "Payment was not successful.", status: txn.status });
    }

    if (String(txn.currency).toUpperCase() !== String(gig.currency).toUpperCase()) {
      console.error("Gig currency mismatch:", { expected: gig.currency, received: txn.currency, reference });
      return res.status(400).json({ error: "Payment was charged in the wrong currency." });
    }

    const expectedMinor = toMinorUnit(gig.price);
    if (Number(txn.amount) !== expectedMinor) {
      return res.status(400).json({ error: "Payment amount did not match the gig price." });
    }

    const updateResult = await pool.query(
      "UPDATE gigs SET status = 'open' WHERE id = $1 AND status = 'pending_payment' RETURNING *",
      [gig.id]
    );

    return res.json({
      success: true,
      gig: serializeGig(updateResult.rows[0] || gig)
    });

  } catch (error) {
    console.error("Gig payment verify error:", error);
    return res.status(500).json({ error: "Could not verify payment." });
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

    return res.json({ success: true, gigs: result.rows.map(serializeGig) });

  } catch (error) {
    console.error("List gigs error:", error);
    return res.status(500).json({ error: "Could not load gigs." });
  }
});


/*
  GET /gigs/mine
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
  Releases the payment: 90% to the worker's earnings, 10% platform
  commission — inserted into the real "earnings" table, using the
  same source_type/source_id pattern already used for product_sale
  earnings, so it shows up correctly in the worker's Earnings page
  and in your admin stats.
*/
router.post("/:id/approve", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id || req.user.userId;

    await client.query("BEGIN");

    const gigResult = await client.query("SELECT * FROM gigs WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!gigResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Gig not found." });
    }

    const gig = gigResult.rows[0];

    if (gig.poster_id !== userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the poster can approve this gig." });
    }
    if (gig.status !== "submitted") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This gig isn't awaiting approval." });
    }

    const commission = Number(gig.price) * PLATFORM_COMMISSION_RATE;
    const workerShare = Number(gig.price) - commission;

    const updateResult = await client.query(
      `UPDATE gigs SET status = 'approved', approved_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    const existingEarning = await client.query(
      "SELECT id FROM earnings WHERE source_type = 'gig_payout' AND source_id = $1",
      [gig.id]
    );

    if (existingEarning.rows.length === 0) {
      await client.query(
        `INSERT INTO earnings
          (user_id, source_type, source_id, gross_amount, platform_fee,
           net_amount, currency, status, available_at)
         VALUES ($1, 'gig_payout', $2, $3, $4, $5, $6, 'pending', now())`,
        [gig.worker_id, gig.id, gig.price, commission, workerShare, gig.currency]
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      gig: serializeGig(updateResult.rows[0]),
      worker_share: workerShare,
      commission
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Approve gig error:", error);
    return res.status(500).json({ error: "Could not approve gig." });
  } finally {
    client.release();
  }
});


module.exports = router;
