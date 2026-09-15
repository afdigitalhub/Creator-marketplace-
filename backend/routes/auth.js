const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/register", async (req, res) => {
  const { full_name, email, password, role } = req.body;

  if (!full_name || !email || !password || !role) {
    return res.status(400).json({ error: "full_name, email, password, and role are required" });
  }
  // Admin accounts are never self-registered — only 'creator' or 'business'
  // can be chosen here. Promote to admin manually in the database.
  if (!["creator", "business"].includes(role)) {
    return res.status(400).json({ error: "role must be 'creator' or 'business'" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Email already registered" });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const result = await client.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, email, role`,
      [full_name, email, password_hash, role]
    );
    const user = result.rows[0];

    // Automatically create the matching empty profile row so Phase 2
    // (profiles) has somewhere real to write to. Wrapped in the same
    // transaction as the user insert — if this fails, the user insert
    // rolls back too, instead of leaving an orphaned account.
    if (role === "creator") {
      await client.query("INSERT INTO creator_profiles (user_id) VALUES ($1)", [user.id]);
    } else if (role === "business") {
      await client.query(
        "INSERT INTO business_profiles (user_id, business_name) VALUES ($1, $2)",
        [user.id, full_name]
      );
    }

    await client.query("COMMIT");

    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    res.status(201).json({ user, token });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  } finally {
    client.release();
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const user = result.rows[0];

    if (user.status === "suspended") {
      return res.status(403).json({ error: "This account has been suspended" });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    res.json({
      user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role },
      token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /auth/set-pin — lets a logged-in user set or change a short PIN.
// Requires the account password again as confirmation, since this creates
// a second, simpler way into the account and should not be changeable
// by anyone who merely has an already-open session on a shared device.
router.post("/set-pin", requireAuth, async (req, res) => {
  const { password, pin } = req.body;

  if (!password || !pin) {
    return res.status(400).json({ error: "password and pin are required" });
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: "PIN must be 4 to 6 digits" });
  }

  try {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const user = result.rows[0];

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Incorrect password" });
    }

    const pin_hash = await bcrypt.hash(pin, 10);
    await pool.query("UPDATE users SET pin_hash = $1 WHERE id = $2", [pin_hash, req.user.id]);

    res.json({ message: "PIN set successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not set PIN" });
  }
});

// POST /auth/pin-login — logs a user in using their email + PIN instead
// of their full password. Only works if that account has already set a
// PIN via /auth/set-pin.
router.post("/pin-login", async (req, res) => {
  const { email, pin } = req.body;
  if (!email || !pin) {
    return res.status(400).json({ error: "email and pin are required" });
  }
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const user = result.rows[0];

    if (user.status === "suspended") {
      return res.status(403).json({ error: "This account has been suspended" });
    }
    if (!user.pin_hash) {
      return res.status(400).json({ error: "No PIN has been set up for this account yet" });
    }

    const match = await bcrypt.compare(pin, user.pin_hash);
    if (!match) {
      return res.status(401).json({ error: "Incorrect PIN" });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    res.json({
      user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role },
      token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PIN login failed" });
  }
});

// POST /auth/ping — called periodically by the app while someone is using it,
// so we know roughly when they were last active. No response body needed.
router.post("/ping", requireAuth, async (req, res) => {
  try {
    await pool.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update activity" });
  }
});

// GET /auth/online-status/:userId — anyone logged in can check if another
// user was active in the last 2 minutes. Only returns true/false, never
// the actual timestamp, to keep it simple and avoid exposing exact activity times.
router.get("/online-status/:userId", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT last_seen FROM users WHERE id = $1",
      [req.params.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const lastSeen = result.rows[0].last_seen;
    const online = lastSeen && (Date.now() - new Date(lastSeen).getTime()) < 2 * 60 * 1000;
    res.json({ online: Boolean(online) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not check status" });
  }
});

// GET /auth/me - confirms the token's role, used by frontend route guards
router.get("/me", requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role });
});

module.exports = router;
