const express = require("express");
const router = express.Router();

/*
  AF Pulse — world news digest
  Fetches headlines from Currents API and caches them in memory
  for 30 minutes, so we don't burn through the daily request quota
  every time someone loads the homepage.
*/

let cachedArticles = [];
let cachedAt = 0;
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes

router.get("/top", async (req, res) => {
  try {
    const now = Date.now();

    if (cachedArticles.length > 0 && now - cachedAt < CACHE_DURATION_MS) {
      return res.json({ articles: cachedArticles, cached: true });
    }

    const apiKey = process.env.NEWS_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "News API key not configured" });
    }

    const response = await fetch(
      "https://api.currentsapi.services/v1/latest-news?language=en",
      {
        headers: { Authorization: `Bearer ${apiKey}` }
      }
    );

    if (!response.ok) {
      throw new Error(`Currents API responded with ${response.status}`);
    }

    const data = await response.json();

    const articles = (data.news || [])
      .slice(0, 6)
      .map((item) => ({
        title: item.title,
        url: item.url,
        image: item.image && item.image !== "None" ? item.image : null,
        source: item.author || "News",
        published: item.published
      }));

    cachedArticles = articles;
    cachedAt = now;

    res.json({ articles, cached: false });
  } catch (err) {
    console.error("News fetch error:", err.message);

    if (cachedArticles.length > 0) {
      return res.json({ articles: cachedArticles, cached: true, stale: true });
    }

    res.status(500).json({ error: "Could not load news right now" });
  }
});

module.exports = router;
