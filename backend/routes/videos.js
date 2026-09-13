const express = require("express");
const router = express.Router();

/*
  AF Pulse Video — current world news videos
  Fetches recent news videos from YouTube's Data API and caches them
  in memory for 30 minutes, since each search call uses a chunk of
  the free daily quota.
*/

let cachedVideos = [];
let cachedAt = 0;
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes

router.get("/top", async (req, res) => {
  try {
    const now = Date.now();

    if (cachedVideos.length > 0 && now - cachedAt < CACHE_DURATION_MS) {
      return res.json({ videos: cachedVideos, cached: true });
    }

    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "YouTube API key not configured" });
    }

    const url =
      "https://www.googleapis.com/youtube/v3/search" +
      "?part=snippet&type=video&order=date&maxResults=6" +
      "&q=world%20news&relevanceLanguage=en" +
      `&key=${apiKey}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`YouTube API responded with ${response.status}`);
    }

    const data = await response.json();

    const videos = (data.items || [])
      .filter((item) => item.id && item.id.videoId)
      .map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        thumbnail:
          (item.snippet.thumbnails &&
            (item.snippet.thumbnails.medium || item.snippet.thumbnails.default) &&
            (item.snippet.thumbnails.medium || item.snippet.thumbnails.default).url) ||
          null,
        channel: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt
      }));

    cachedVideos = videos;
    cachedAt = now;

    res.json({ videos, cached: false });
  } catch (err) {
    console.error("Video fetch error:", err.message);

    if (cachedVideos.length > 0) {
      return res.json({ videos: cachedVideos, cached: true, stale: true });
    }

    res.status(500).json({ error: "Could not load videos right now" });
  }
});

module.exports = router;
