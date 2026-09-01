const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

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

// GET /auth/me - confirms the token's role, used by frontend route guards
router.get("/me", require("../middleware/auth").requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role });
});

module.exports = router;
