/**
 * npm Semantic Search – Express server
 *
 * Endpoints:
 *   GET  /              → serves the search UI
 *   GET  /api/search?q= → queries ZeroEntropy and returns JSON results
 *   GET  /api/status    → returns indexing status from ZeroEntropy
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const ZE_API_KEY = process.env.ZERO_ENTROPY_API_KEY;
const ZE_BASE_URL = process.env.ZERO_ENTROPY_BASE_URL || 'https://api.zeroentropy.dev';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'npm-packages';

// ---------------------------------------------------------------------------
// ZeroEntropy helper
// ---------------------------------------------------------------------------

async function zeSearch(query, k = 10) {
  const res = await fetch(`${ZE_BASE_URL}/v1/queries/top-documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ZE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      collection_name: COLLECTION_NAME,
      query,
      k,
      include_metadata: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ZeroEntropy error ${res.status}: ${text}`);
  }

  return res.json();
}

async function zeStatus() {
  const res = await fetch(`${ZE_BASE_URL}/v1/status/get-status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ZE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ collection_name: COLLECTION_NAME }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ZeroEntropy status error ${res.status}: ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'public')));

// Search API
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const k = Math.min(parseInt(req.query.k, 10) || 10, 20);

  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter "q"' });
  }

  if (!ZE_API_KEY) {
    return res.status(500).json({ error: 'ZERO_ENTROPY_API_KEY not configured on server.' });
  }

  try {
    const data = await zeSearch(q, k);

    // Normalise results so the UI always gets a consistent shape
    const results = (data.results || []).map((item) => {
      const meta = item.metadata || {};
      // ZeroEntropy returns path like "packages/<name>"
      const name = meta.name || item.path.replace(/^packages\//, '');
      return {
        name,
        description: meta.description || '',
        keywords: meta.keywords || '',
        version: meta.version || '',
        npm_url: meta.npm_url || `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
        score: item.score,
      };
    });

    res.json({ query: q, results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Status API
app.get('/api/status', async (req, res) => {
  if (!ZE_API_KEY) {
    return res.status(500).json({ error: 'ZERO_ENTROPY_API_KEY not configured.' });
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
      console.warn('WARNING: ZERO_ENTROPY_API_KEY is not set – search will fail!');
    }
  });
}

// Export for Vercel serverless
module.exports = app;
