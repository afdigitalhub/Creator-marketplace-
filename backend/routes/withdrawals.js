const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getWithdrawalWindow } = require("./withdrawalWindow");
const { ensureWithdrawalWindowNotification } = require("./notifications");

const MINIMUM_WITHDRAWAL = 50;
const WITHDRAWAL_FEE = 0;

async function getBalances(client, userId) {
  const result = await client.query(
    `SELECT currency,
            COALESCE(SUM(CASE WHEN status = 'available' THEN GREATEST(net_amount - withdrawn_amount, 0) ELSE 0 END), 0) AS available,
            COALESCE(SUM(CASE WHEN status IN ('pending','available') THEN GREATEST(net_amount - CASE WHEN status='available' THEN withdrawn_amount ELSE 0 END, 0) ELSE 0 END), 0) AS wallet
     FROM earnings
     WHERE user_id = $1
     GROUP BY currency
     ORDER BY currency`,
    [userId]
  );

  return result.rows.map(r => ({
    currency: r.currency,
    available: Number(r.available),
    wallet: Number(r.wallet)
  }));
}

router.get("/status", requireAuth, async (req, res) => {
  try {
    await ensureWithdrawalWindowNotification(req.user.id);

    const window = getWithdrawalWindow(new Date());

    const profile = await pool.query(
      `SELECT email, phone, phone_verified,
              (password_hash IS NOT NULL AND password_hash <> '') AS password_set
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    const p = profile.rows[0] || {};
    const ready = Boolean(p.email && p.phone && p.password_set);

    res.json({
      open: window.open,
      window,
      no_fee: true,
      fee: WITHDRAWAL_FEE,
      minimum_withdrawal: MINIMUM_WITHDRAWAL,
      account_ready: ready,
      requirements: {
        email: Boolean(p.email),
        phone: Boolean(p.phone),
        password: Boolean(p.password_set)
      }
    });
  } catch (err) {
    console.error("Withdrawal status error:", err);
    res.status(500).json({ error: "Could not load withdrawal status" });
  }
});

router.get("/mine", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("SELECT mature_earnings()");
    await ensureWithdrawalWindowNotification(req.user.id);

    const balances = await getBalances(client, req.user.id);

    const profileResult = await client.query(
      `SELECT full_name, email, phone, phone_verified,
              (password_hash IS NOT NULL AND password_hash <> '') AS password_set
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    const listResult = await client.query(
      `SELECT id, amount, currency, destination_type, destination_details,
              status, failure_reason, requested_at, completed_at, provider_reference
       FROM withdrawals
       WHERE user_id = $1
       ORDER BY requested_at DESC`,
      [req.user.id]
    );

    res.json({
      profile: profileResult.rows[0] || null,
      balances,
      minimum_withdrawal: MINIMUM_WITHDRAWAL,
      no_fee: true,
      fee: WITHDRAWAL_FEE,
      window: getWithdrawalWindow(new Date()),
      withdrawals: listResult.rows
    });
  } catch (err) {
    console.error("Load withdrawals error:", err);
    res.status(500).json({ error: "Could not load your withdrawals" });
  } finally {
    client.release();
  }
});

router.post("/", requireAuth, async (req, res) => {
  const {
    amount,
    currency,
    destination_type,
    account_name,
    account_number,
    provider_name,
    password,
    phone
  } = req.body;

  const window = getWithdrawalWindow(new Date());

  if (!window.open) {
    return res.status(403).json({
      error: "Withdrawals are closed right now. They are live every Friday from 12:00 AM to 5:30 PM.",
      window
    });
  }

  if (!amount || !currency || !destination_type || !account_name || !account_number || !password || !phone) {
    return res.status(400).json({
      error: "currency, amount, destination details, phone and password are required"
    });
  }

  const requested = Number(amount);

  if (!Number.isFinite(requested) || requested <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number" });
  }

  if (requested < MINIMUM_WITHDRAWAL) {
    return res.status(400).json({
      error: `The minimum withdrawal is ${MINIMUM_WITHDRAWAL} ${currency}`
    });
  }

  if (!/^[A-Z]{3}$/.test(String(currency))) {
    return res.status(400).json({ error: "Invalid currency" });
  }

  if (!["mobile_money", "bank"].includes(destination_type)) {
    return res.status(400).json({
      error: "destination_type must be mobile_money or bank"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `SELECT id, email, phone, password_hash
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [req.user.id]
    );

    const user = userResult.rows[0];

    if (!user || !user.email || !user.phone || !user.password_hash) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Complete your email, phone number and password before withdrawing."
      });
    }

    if (String(phone).trim() !== String(user.phone).trim()) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "The withdrawal phone number must match the phone number on your account."
      });
    }

    const passwordOk = await bcrypt.compare(
      String(password),
      user.password_hash
    );

    if (!passwordOk) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        error: "Incorrect account password."
      });
    }

    const pendingCheck = await client.query(
      `SELECT id
       FROM withdrawals
       WHERE user_id = $1
       AND status IN ('requested','processing')`,
      [req.user.id]
    );

    if (pendingCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "You already have a withdrawal in progress. Please wait for it to complete."
      });
    }

    // Lock only this user's earnings in this currency.
    const locked = await client.query(
      `SELECT id, net_amount, withdrawn_amount
       FROM earnings
       WHERE user_id = $1
       AND currency = $2
       AND status = 'available'
       ORDER BY created_at ASC
       FOR UPDATE`,
      [req.user.id, currency]
    );

    let available = 0;

    for (const e of locked.rows) {
      available += Math.max(
        Number(e.net_amount) - Number(e.withdrawn_amount || 0),
        0
      );
    }

    if (requested > available + 0.00001) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `You do not have enough available ${currency} balance for this withdrawal.`,
        available
      });
    }

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
      [
        req.user.id,
        requested,
        currency,
        destination_type,
        JSON.stringify(destination)
      ]
    );

    const withdrawal = withdrawalResult.rows[0];

    let remaining = requested;

    for (const earning of locked.rows) {
      if (remaining <= 0) break;

      const availableFromEarning = Math.max(
        Number(earning.net_amount) -
          Number(earning.withdrawn_amount || 0),
        0
      );

      const take = Math.min(
        remaining,
        availableFromEarning
      );

      if (take <= 0) continue;

      const newWithdrawn =
        Number(earning.withdrawn_amount || 0) + take;

      const fullyConsumed =
        newWithdrawn >=
        Number(earning.net_amount) - 0.00001;

      await client.query(
        `UPDATE earnings
         SET withdrawn_amount = $1,
             status = $2
         WHERE id = $3`,
        [
          Math.min(
            newWithdrawn,
            Number(earning.net_amount)
          ),
          fullyConsumed ? "withdrawn" : "available",
          earning.id
        ]
      );

      await client.query(
        `INSERT INTO withdrawal_earnings
          (withdrawal_id, earning_id, amount)
         VALUES ($1, $2, $3)`,
        [withdrawal.id, earning.id, take]
      );

      remaining -= take;
    }

    await client.query("COMMIT");

    res.status(201).json({
      withdrawal,
      fee: WITHDRAWAL_FEE,
      message: "Withdrawal request received."
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create withdrawal error:", err);

    res.status(500).json({
      error: "Could not submit your withdrawal request"
    });
  } finally {
    client.release();
  }
});

// --- ADMIN ---

router.get(
  "/admin/all",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT w.*, u.full_name, u.email, u.phone
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

      res.json({
        withdrawals: result.rows,
        window: getWithdrawalWindow(new Date()),
        no_fee: true
      });
    } catch (err) {
      console.error("Admin list withdrawals error:", err);

      res.status(500).json({
        error: "Could not load withdrawals"
      });
    }
  }
);

router.put(
  "/:id/status",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    const {
      status,
      failure_reason,
      provider_reference
    } = req.body;

    if (
      !["processing", "completed", "failed"].includes(status)
    ) {
      return res.status(400).json({
        error: "status must be processing, completed or failed"
      });
    }

    if (status === "failed" && !failure_reason) {
      return res.status(400).json({
        error: "A reason is required when marking a withdrawal as failed"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existing = await client.query(
        "SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE",
        [req.params.id]
      );

      if (!existing.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "Withdrawal not found"
        });
      }

      const withdrawal = existing.rows[0];

      if (
        ["completed", "failed"].includes(
          withdrawal.status
        )
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "This withdrawal has already been finalised"
        });
      }

      if (status === "failed") {
        const allocations = await client.query(
          `SELECT earning_id, amount
           FROM withdrawal_earnings
           WHERE withdrawal_id = $1
           FOR UPDATE`,
          [withdrawal.id]
        );

        for (const a of allocations.rows) {
          await client.query(
            `UPDATE earnings
             SET withdrawn_amount =
                   GREATEST(withdrawn_amount - $1, 0),
                 status =
                   CASE
                     WHEN GREATEST(withdrawn_amount - $1, 0) < net_amount
                     THEN 'available'
                     ELSE status
                   END
             WHERE id = $2`,
            [
              Number(a.amount || 0),
              a.earning_id
            ]
          );
        }
      }

      const isFinal =
        status === "completed" ||
        status === "failed";

      const completedAt = isFinal
        ? new Date()
        : withdrawal.completed_at;

      const reason =
        status === "failed"
          ? failure_reason
          : null;

      const ref =
        provider_reference ||
        withdrawal.provider_reference ||
        null;

      const result = await client.query(
        `UPDATE withdrawals
         SET status = $1,
             failure_reason = $2,
             provider_reference = $3,
             completed_at = $4
         WHERE id = $5
         RETURNING *`,
        [
          status,
          reason,
          ref,
          completedAt,
          withdrawal.id
        ]
      );

      await client.query("COMMIT");

      res.json({
        withdrawal: result.rows[0],
        fee: WITHDRAWAL_FEE
      });
    } catch (err) {
      await client.query("ROLLBACK");

      console.error(
        "Update withdrawal status error:",
        err
      );

      res.status(500).json({
        error: "Could not update this withdrawal"
      });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
