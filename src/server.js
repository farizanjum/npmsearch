/**
 * npm Semantic Search – Express server
 *
 * Endpoints:
 *   GET  /              → serves the search UI
 *   GET  /api/search?q= → queries ZeroEntropy and returns JSON results
 *   GET  /api/status    → returns indexing status from ZeroEntropy
 */

require("dotenv").config();
const express = require("express");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const ZE_API_KEY = process.env.ZERO_ENTROPY_API_KEY;
const ZE_BASE_URL =
  process.env.ZERO_ENTROPY_BASE_URL || "https://api.zeroentropy.dev";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "npm-packages";

// ---------------------------------------------------------------------------
// ZeroEntropy helper
// ---------------------------------------------------------------------------

async function zeSearch(query, k = 10) {
  const res = await fetch(`${ZE_BASE_URL}/v1/queries/top-documents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ZE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      collection_name: COLLECTION_NAME,
      query,
      k,
      include_metadata: true,
      reranker: "zerank-2",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404 && text.includes("Collection Not Found")) {
      throw new Error(
        `Index empty. Please run 'npm run index' to populate the database.`,
      );
    }
    throw new Error(`ZeroEntropy error ${res.status}: ${text}`);
  }

  return res.json();
}

async function zeStatus() {
  const res = await fetch(`${ZE_BASE_URL}/v1/status/get-status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ZE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ collection_name: COLLECTION_NAME }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404 && text.includes("Collection Not Found")) {
      return { total_documents: 0, status: "Collection Not Found" };
    }
    throw new Error(`ZeroEntropy status error ${res.status}: ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Basic In-Memory Cache for blazing fast repeated searches
// ---------------------------------------------------------------------------
const searchCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getCachedResult(q, k) {
  const key = `${q}:${k}`;
  if (searchCache.has(key)) {
    const entry = searchCache.get(key);
    if (Date.now() - entry.timestamp < CACHE_TTL_MS) {
      return entry.data;
    }
    searchCache.delete(key);
  }
  return null;
}

function setCachedResult(q, k, data) {
  const key = `${q}:${k}`;
  // Simple size limit to prevent memory leak
  if (searchCache.size > 1000) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
  searchCache.set(key, { timestamp: Date.now(), data });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, "..", "public")));

// Search API
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  const k = Math.min(parseInt(req.query.k, 10) || 10, 20);

  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter "q"' });
  }

  if (!ZE_API_KEY) {
    return res
      .status(500)
      .json({ error: "ZERO_ENTROPY_API_KEY not configured on server." });
  }

  try {
    // 1. Browser/Edge CDN caching (Cache-Control)
    res.setHeader(
      "Cache-Control",
      "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
    );

    // 2. Fast In-Memory Cache check
    const cachedData = getCachedResult(q, k);
    if (cachedData) {
      return res.json(cachedData);
    }

    const data = await zeSearch(q, k);

    // Normalise results so the UI always gets a consistent shape
    const results = (data.results || []).map((item) => {
      const meta = item.metadata || {};
      // ZeroEntropy returns path like "packages/<name>"
      const name = meta.name || item.path.replace(/^packages\//, "");
      return {
        name,
        description: meta.description || "",
        keywords: meta.keywords || "",
        version: meta.version || "",
        npm_url:
          meta.npm_url ||
          `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
        score: item.score,
      };
    });

    const responseData = { query: q, results };

    // Save to cache before returning
    setCachedResult(q, k, responseData);

    res.json(responseData);
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Status API
app.get("/api/status", async (req, res) => {
  if (!ZE_API_KEY) {
    return res
      .status(500)
      .json({ error: "ZERO_ENTROPY_API_KEY not configured." });
  }
  try {
    const data = await zeStatus();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start (skip listen when imported as a Vercel serverless function)
// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nnpm Semantic Search is running at http://localhost:${PORT}`);
    console.log(`Collection : ${COLLECTION_NAME}`);
    console.log(`ZeroEntropy: ${ZE_BASE_URL}`);
    if (!ZE_API_KEY) {
      console.warn(
        "WARNING: ZERO_ENTROPY_API_KEY is not set – search will fail!",
      );
    }
  });
}

// Export for Vercel serverless
module.exports = app;
