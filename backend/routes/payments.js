const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const crypto = require("crypto");

const PAYSTACK_SECRET = (process.env.PAYSTACK_SECRET_KEY || "").trim();
const PAYSTACK_BASE = "https://api.paystack.co";

// Paystack works in the smallest currency unit (pesewas for GHS).
function toMinorUnit(amount) {
  return Math.round(Number(amount) * 100);
}

// Shared logic for confirming a payment with Paystack and, if genuine,
// completing the order. Written to be safely repeatable: calling it twice
// for the same payment does not create duplicate entitlements or earnings.
async function verifyAndComplete(reference) {
  // 1. Ask Paystack directly. We never trust what the browser or a
  //    webhook body claims about payment status.
  const verifyRes = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
  });

  const verifyData = await verifyRes.json();

  if (!verifyRes.ok || !verifyData.status) {
    return { ok: false, reason: "verification_failed", detail: verifyData.message || "Paystack did not confirm this payment" };
  }

  const txn = verifyData.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 2. Find the payment row. The UNIQUE constraint on provider_reference
    //    means there can only ever be one.
    const paymentResult = await client.query(
      "SELECT * FROM payments WHERE provider_reference = $1 FOR UPDATE",
      [reference]
    );

    if (paymentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "unknown_payment" };
    }

    const payment = paymentResult.rows[0];

    // 3. Already processed? Stop here. This is what makes repeated
    //    webhooks harmless.
    if (payment.status === "successful") {
      await client.query("ROLLBACK");
      return { ok: true, already_processed: true, order_id: payment.order_id };
    }

    const orderResult = await client.query(
      "SELECT * FROM orders WHERE id = $1 FOR UPDATE",
      [payment.order_id]
    );

    if (orderResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "unknown_order" };
    }

    const order = orderResult.rows[0];

    // 4. Payment not successful at Paystack: record that and stop.
    if (txn.status !== "success") {
      await client.query(
        "UPDATE payments SET status = $1, raw_response = $2 WHERE id = $3",
        [txn.status === "abandoned" ? "abandoned" : "failed", JSON.stringify(txn), payment.id]
      );
      await client.query(
        "UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1",
        [order.id]
      );
      await client.query("COMMIT");
      return { ok: false, reason: "payment_not_successful", status: txn.status };
    }

    // 5. Confirm the amount actually paid matches what we charged.
    //    This blocks a tampered checkout paying less than the price.
    const expectedMinor = toMinorUnit(order.gross_amount);
    if (Number(txn.amount) !== expectedMinor) {
      await client.query(
        "UPDATE payments SET status = 'failed', raw_response = $1 WHERE id = $2",
        [JSON.stringify(txn), payment.id]
      );
      await client.query("COMMIT");
      return { ok: false, reason: "amount_mismatch", expected: expectedMinor, received: txn.amount };
    }

    // 6. Genuine, verified, correct amount. Complete the order.
    await client.query(
      "UPDATE payments SET status = 'successful', raw_response = $1, verified_at = now() WHERE id = $2",
      [JSON.stringify(txn), payment.id]
    );

    await client.query(
      "UPDATE orders SET status = 'paid', updated_at = now() WHERE id = $1",
      [order.id]
    );

    // Entitlement: the buyer's right to download. UNIQUE (user_id, product_id)
    // means a repeat cannot create a duplicate.
    await client.query(
      `INSERT INTO entitlements (user_id, product_id, order_id, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (user_id, product_id) DO UPDATE SET status = 'active'`,
      [order.buyer_id, order.product_id, order.id]
    );

    // Earning: what the platform owes the seller. Guarded against duplicates
    // by checking for an existing row for this order.
    const existingEarning = await client.query(
      "SELECT id FROM earnings WHERE source_type = 'product_sale' AND source_id = $1",
      [order.id]
    );

    if (existingEarning.rows.length === 0) {
      await client.query(
        `INSERT INTO earnings
          (user_id, source_type, source_id, gross_amount, platform_fee,
           net_amount, currency, status, available_at)
         VALUES ($1, 'product_sale', $2, $3, $4, $5, $6, 'pending', now() + interval '7 days')`,
        [
          order.seller_id,
          order.id,
          order.gross_amount,
          order.commission_amount,
          order.seller_amount,
          order.currency
        ]
      );
    }

    await client.query("COMMIT");
    return { ok: true, order_id: order.id, product_id: order.product_id };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// POST /payments/initialise - start a payment for an existing pending order
router.post("/initialise", requireAuth, async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) {
    return res.status(400).json({ error: "order_id is required" });
  }

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ error: "Payments are not configured yet" });
  }

  try {
    const orderResult = await pool.query("SELECT * FROM orders WHERE id = $1", [order_id]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orderResult.rows[0];

    if (order.buyer_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized to pay for this order" });
    }

    if (order.status === "paid") {
      return res.status(400).json({ error: "This order has already been paid" });
    }

    if (order.status !== "pending") {
      return res.status(400).json({ error: "This order can no longer be paid" });
    }

    const userResult = await pool.query("SELECT email FROM users WHERE id = $1", [req.user.id]);
    const email = userResult.rows[0].email;

    // Amount comes from the order in our database, never from the request.
    const initRes = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        amount: toMinorUnit(order.gross_amount),
        currency: order.currency,
        metadata: { order_id: order.id, product_title: order.product_title }
      })
    });

    const initData = await initRes.json();

    if (!initRes.ok || !initData.status) {
      console.error("Paystack init failed:", initData);
      return res.status(502).json({
        error: "Could not start payment",
        detail: initData.message || "Payment provider rejected the request"
      });
    }

    const reference = initData.data.reference;

    await pool.query(
      `INSERT INTO payments (order_id, provider, provider_reference, amount, currency, status)
       VALUES ($1, 'paystack', $2, $3, $4, 'pending')`,
      [order.id, reference, order.gross_amount, order.currency]
    );

    res.json({
      authorization_url: initData.data.authorization_url,
      reference
    });

  } catch (err) {
    console.error("Initialise payment error:", err);
    res.status(500).json({ error: "Could not start payment" });
  }
});

// GET /payments/verify/:reference - called when the customer returns.
// This is a convenience check, not the authority; the webhook is.
router.get("/verify/:reference", requireAuth, async (req, res) => {
  try {
    const result = await verifyAndComplete(req.params.reference);

    if (!result.ok) {
      return res.status(400).json({ error: "Payment not confirmed", reason: result.reason });
    }

    res.json({ success: true, order_id: result.order_id, product_id: result.product_id });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ error: "Could not verify payment" });
  }
});

// POST /payments/webhook - Paystack calls this. No auth middleware:
// authenticity is proven by the signature, not by a login token.
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const rawBody = req.body;

    // Verify this genuinely came from Paystack before trusting anything in it.
    const expected = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (signature !== expected) {
      console.error("Webhook signature mismatch, ignoring request");
      return res.sendStatus(401);
    }

    const event = JSON.parse(rawBody.toString());

    // Acknowledge immediately so Paystack does not retry unnecessarily.
    res.sendStatus(200);

    if (event.event === "charge.success") {
      const reference = event.data.reference;
      try {
        await verifyAndComplete(reference);
      } catch (err) {
        console.error("Webhook processing error:", err);
      }
    }

  } catch (err) {
    console.error("Webhook error:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

module.exports = router;
