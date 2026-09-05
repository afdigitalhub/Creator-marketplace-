const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");

// Helper: fetch a conversation and confirm the current user is a real participant
async function getAuthorizedConversation(conversationId, userId) {
  const result = await pool.query(
    `SELECT * FROM conversations WHERE id = $1`,
    [conversationId]
  );
  if (result.rows.length === 0) return { error: 404 };
  const convo = result.rows[0];
  if (convo.buyer_id !== userId && convo.seller_id !== userId) {
    return { error: 403 };
  }
  return { conversation: convo };
}

// GET current user's conversations (as buyer or seller), with latest message preview and unread state
router.get("/conversations", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
        p.title AS product_title,
        p.cover_url AS product_cover_url,
        buyer.full_name AS buyer_name,
        seller.full_name AS seller_name,
        (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
        (SELECT COUNT(*) FROM messages m
          WHERE m.conversation_id = c.id
          AND m.sender_id != $1
          AND m.created_at > COALESCE(
            CASE WHEN c.buyer_id = $1 THEN c.buyer_last_read_at ELSE c.seller_last_read_at END,
            'epoch'::timestamptz
          )
        ) AS unread_count
       FROM conversations c
       JOIN products p ON c.product_id = p.id
       JOIN users buyer ON c.buyer_id = buyer.id
       JOIN users seller ON c.seller_id = seller.id
       WHERE c.buyer_id = $1 OR c.seller_id = $1
       ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC`,
      [req.user.id]
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load conversations" });
  }
});

// POST start or reuse a conversation about a specific product
router.post("/conversations", requireAuth, async (req, res) => {
  const { product_id } = req.body;
  if (!product_id) {
    return res.status(400).json({ error: "product_id is required" });
  }

  try {
    const productResult = await pool.query("SELECT * FROM products WHERE id = $1", [product_id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    const product = productResult.rows[0];

    if (product.seller_id === req.user.id) {
      return res.status(400).json({ error: "You cannot start a conversation with yourself about your own product" });
    }

    const existing = await pool.query(
      `SELECT * FROM conversations WHERE buyer_id = $1 AND seller_id = $2 AND product_id = $3`,
      [req.user.id, product.seller_id, product_id]
    );

    if (existing.rows.length > 0) {
      return res.json({ conversation: existing.rows[0] });
    }

    const created = await pool.query(
      `INSERT INTO conversations (buyer_id, seller_id, product_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, product.seller_id, product_id]
    );

    res.status(201).json({ conversation: created.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not start conversation" });
  }
});

// GET a single conversation's details (only if the current user is a participant)
router.get("/conversations/:id", requireAuth, async (req, res) => {
  try {
    const { error, conversation } = await getAuthorizedConversation(req.params.id, req.user.id);
    if (error === 404) return res.status(404).json({ error: "Conversation not found" });
    if (error === 403) return res.status(403).json({ error: "Not authorized to view this conversation" });

    const enriched = await pool.query(
      `SELECT c.*, p.title AS product_title, p.cover_url AS product_cover_url,
        buyer.full_name AS buyer_name, seller.full_name AS seller_name
       FROM conversations c
       JOIN products p ON c.product_id = p.id
       JOIN users buyer ON c.buyer_id = buyer.id
       JOIN users seller ON c.seller_id = seller.id
       WHERE c.id = $1`,
      [conversation.id]
    );

    res.json({ conversation: enriched.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load conversation" });
  }
});

// GET messages in a conversation, paginated, and mark as read for the current user
router.get("/conversations/:id/messages", requireAuth, async (req, res) => {
  try {
    const { error, conversation } = await getAuthorizedConversation(req.params.id, req.user.id);
    if (error === 404) return res.status(404).json({ error: "Conversation not found" });
    if (error === 403) return res.status(403).json({ error: "Not authorized to view this conversation" });

    const before = req.query.before;
    const limit = 30;

    const queryParams = [conversation.id];
    let whereClause = "conversation_id = $1";
    if (before) {
      queryParams.push(before);
      whereClause += ` AND created_at < $2`;
    }

    const result = await pool.query(
      `SELECT * FROM messages WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`,
      queryParams
    );

    const readField = conversation.buyer_id === req.user.id ? "buyer_last_read_at" : "seller_last_read_at";
    await pool.query(
      `UPDATE conversations SET ${readField} = now() WHERE id = $1`,
      [conversation.id]
    );

    res.json({ messages: result.rows.reverse(), has_more: result.rows.length === limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load messages" });
  }
});

// POST send a message into a conversation
router.post("/conversations/:id/messages", requireAuth, async (req, res) => {
  const content = (req.body.content || "").trim();

  if (!content) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }
  if (content.length > 2000) {
    return res.status(400).json({ error: "Message is too long" });
  }

  try {
    const { error, conversation } = await getAuthorizedConversation(req.params.id, req.user.id);
    if (error === 404) return res.status(404).json({ error: "Conversation not found" });
    if (error === 403) return res.status(403).json({ error: "Not authorized to send messages in this conversation" });

    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, content)
       VALUES ($1, $2, $3) RETURNING *`,
      [conversation.id, req.user.id, content]
    );

    const readField = conversation.buyer_id === req.user.id ? "buyer_last_read_at" : "seller_last_read_at";
    await pool.query(
      `UPDATE conversations SET ${readField} = now() WHERE id = $1`,
      [conversation.id]
    );

    res.status(201).json({ message: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send message" });
  }
});

module.exports = router;
