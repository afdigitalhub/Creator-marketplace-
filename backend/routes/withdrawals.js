const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const MINIMUM_WITHDRAWAL = 50;

// Calculate a user's available balance from the ledger.
// Never stored, always computed, so it cannot drift out of line.
async function getAvailableBalance(client, userId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(net_amount), 0) AS available, MAX(currency) AS currency
     FROM earnings
     WHERE user_id = $1 AND status = 'available'`,
    [userId]
  );
  return {
    available: Number(result.rows[0].available),
    currency: result.rows[0].currency || "GHS"
  };
}

// GET /withdrawals/mine - the user's own withdrawal history and balance
router.get("/mine", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    // Bring any cleared earnings up to date first.
    await client.query("SELECT mature_earnings()");

    const balance = await getAvailableBalance(client, req.user.id);

    const listResult = await client.query(
      `SELECT id, amount, currency, destination_type, destination_details,
              status, failure_reason, requested_at, completed_at
       FROM withdrawals
       WHERE user_id = $1
       ORDER BY requested_at DESC`,
      [req.user.id]
    );

    res.json({
      available_balance: balance.available,
      currency: balance.currency,
      minimum_withdrawal: MINIMUM_WITHDRAWAL,
      withdrawals: listResult.rows
    });
  } catch (err) {
    console.error("Load withdrawals error:", err);
    res.status(500).json({ error: "Could not load your withdrawals" });
  } finally {
    client.release();
  }
});

// POST /withdrawals - request a withdrawal
router.post("/", requireAuth, async (req, res) => {
  const { amount, destination_type, account_name, account_number, provider_name } = req.body;

  if (!amount || !destination_type || !account_name || !account_number) {
    return res.status(400).json({ error: "amount, destination_type, account_name and account_number are required" });
  }

  const requested = Number(amount);
  if (isNaN(requested) || requested <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number" });
  }

  if (requested < MINIMUM_WITHDRAWAL) {
    return res.status(400).json({ error: `The minimum withdrawal is ${MINIMUM_WITHDRAWAL}` });
  }

  if (!["mobile_money", "bank"].includes(destination_type)) {
    return res.status(400).json({ error: "destination_type must be mobile_money or bank" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock this user's available earnings so two simultaneous requests
    // cannot both pass the balance check and withdraw the same money.
    const lockedEarnings = await client.query(
      `SELECT id, net_amount FROM earnings
       WHERE user_id = $1 AND status = 'available'
       ORDER BY created_at ASC
       FOR UPDATE`,
      [req.user.id]
    );

    const available = lockedEarnings.rows.reduce((sum, e) => sum + Number(e.net_amount), 0);

    if (requested > available) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "You do not have enough available balance for this withdrawal",
        available
      });
    }

    // Check for an existing request still in progress.
    const pendingCheck = await client.query(
      `SELECT id FROM withdrawals
       WHERE user_id = $1 AND status IN ('requested', 'processing')`,
      [req.user.id]
    );

    if (pendingCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "You already have a withdrawal in progress. Please wait for it to complete." });
    }

    const currencyResult = await client.query(
      "SELECT MAX(currency) AS currency FROM earnings WHERE user_id = $1 AND status = 'available'",
      [req.user.id]
    );
    const currency = currencyResult.rows[0].currency || "GHS";

    const destination = {
      account_name: String(account_name).trim(),
      account_number: String(account_number).trim(),
      provider_name: provider_name ? String(provider_name).trim() : null
    };

    const withdrawalResult = await client.query(
      `INSERT INTO withdrawals
        (user_id, amount, currency, destination_type, destination_details, status)
       VALUES ($1, $2, $3, $4, $5, 'requested')
       RETURNING *`,
      [req.user.id, requested, currency, destination_type, JSON.stringify(destination)]
    );

    const withdrawal = withdrawalResult.rows[0];

    // Mark the specific earnings covering this amount as withdrawn,
    // oldest first, and record exactly which ones were used.
    let remaining = requested;
    for (const earning of lockedEarnings.rows) {
      if (remaining <= 0) break;

      await client.query(
        "UPDATE earnings SET status = 'withdrawn' WHERE id = $1",
        [earning.id]
      );

      await client.query(
        "INSERT INTO withdrawal_earnings (withdrawal_id, earning_id) VALUES ($1, $2)",
        [withdrawal.id, earning.id]
      );

      remaining -= Number(earning.net_amount);
    }

    await client.query("COMMIT");

    res.status(201).json({ withdrawal });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create withdrawal error:", err);
    res.status(500).json({ error: "Could not submit your withdrawal request" });
  } finally {
    client.release();
  }
});

// --- ADMIN ---

// GET /withdrawals/admin/all - every withdrawal request
router.get("/admin/all", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.*, u.full_name, u.email
       FROM withdrawals w
       JOIN users u ON w.user_id = u.id
       ORDER BY
         CASE w.status
           WHEN 'requested' THEN 1
           WHEN 'processing' THEN 2
           ELSE 3
         END,
         w.requested_at DESC`
    );
    res.json({ withdrawals: result.rows });
  } catch (err) {
    console.error("Admin list withdrawals error:", err);
    res.status(500).json({ error: "Could not load withdrawals" });
  }
});

// PUT /withdrawals/:id/status - admin marks a withdrawal processing,
// completed, or failed. Failure returns the earnings to available.
router.put("/:id/status", requireAuth, requireRole("admin"), async (req, res) => {
  const { status, failure_reason, provider_reference } = req.body;

  if (!["processing", "completed", "failed"].includes(status)) {
    return res.status(400).json({ error: "status must be processing, completed or failed" });
  }

  if (status === "failed" && !failure_reason) {
    return res.status(400).json({ error: "A reason is required when marking a withdrawal as failed" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Withdrawal not found" });
    }

    const withdrawal = existing.rows[0];

    if (["completed", "failed"].includes(withdrawal.status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "This withdrawal has already been finalised" });
    }

    if (status === "failed") {
      // Return exactly the earnings this withdrawal consumed.
      await client.query(
        `UPDATE earnings SET status = 'available'
         WHERE id IN (SELECT earning_id FROM withdrawal_earnings WHERE withdrawal_id = $1)`,
        [withdrawal.id]
      );
    }

    const result = await client.query(
      `UPDATE withdrawals
       SET status = $1,
           failure_reason = $2,
           provider_reference = COALESCE($3, provider_reference),
           completed_at = CASE WHEN $1 IN ('completed','failed') THEN now() ELSE completed_at END
       WHERE id = $4
       RETURNING *`,
      [status, status === "failed" ? failure_reason : null, provider_reference || null, withdrawal.id]
    );

    await client.query("COMMIT");
    res.json({ withdrawal: result.rows[0] });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update withdrawal status error:", err);
    res.status(500).json({ error: "Could not update this withdrawal" });
  } finally {
    client.release();
  }
});

module.exports = router;
