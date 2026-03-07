# npm Semantic Search

Search npm packages by **meaning**, not keywords — powered by [ZeroEntropy](https://zeroentropy.dev).

**The problem:** `npm search "drag and drop for React hooks"` returns garbage.
**The fix:** semantic search over 10,000 top npm packages indexed with ZeroEntropy's hybrid retrieval.

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your ZeroEntropy API key:

```bash
cp .env.example .env
```

```
ZERO_ENTROPY_API_KEY=ze_your_key_here
ZERO_ENTROPY_BASE_URL=https://api.zeroentropy.dev
COLLECTION_NAME=npm-packages
PORT=3000
```

### 3. Index packages (one-time setup, ~10 min)

Fetches the top 10,000 npm packages by popularity and indexes them into ZeroEntropy:

```bash
npm run index
```

Progress is printed to the terminal. The script is idempotent — re-running it will overwrite existing documents safely.

### 4. Start the search server

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## How It Works

```
┌─────────────┐      GET /-/v1/search      ┌──────────────────┐
│  npm registry│◄───────────────────────────│ index-packages.js│
└─────────────┘                             └────────┬─────────┘
                                                     │ POST /v1/documents/add-document
                                                     ▼
                                            ┌──────────────────┐
                     POST /v1/queries/      │   ZeroEntropy    │
                     top-documents          │   (npm-packages  │
┌──────────────┐◄───────────────────────────│    collection)   │
│  server.js   │                            └──────────────────┘
│  (Express)   │
└──────┬───────┘
       │ GET /api/search?q=...
       ▼
┌──────────────┐
│ index.html   │  ← The search UI
└──────────────┘
```

### Indexer (`scripts/index-packages.js`)

1. Pages through the npm registry search API (sorted by popularity) to collect 10,000 packages.
2. Builds a rich text document per package: name, description, keywords, author, version.
3. Upserts every document into a ZeroEntropy collection with `overwrite: true`.
4. Runs 5 workers in parallel; retries rate-limited requests with exponential back-off.

### Server (`src/server.js`)

- `GET /` → serves the static search UI
- `GET /api/search?q=<query>&k=<n>` → calls ZeroEntropy `top-documents`, returns JSON
- `GET /api/status` → returns indexing status from ZeroEntropy

### UI (`public/index.html`)

Single-file vanilla JS / CSS UI with:
- Debounced live search (fires after 400 ms of inactivity)
- Pre-built example queries
- Dark theme matching npm's aesthetic

---

## Token Budget

| Tier | Packages | Avg tokens/pkg | Total tokens |
|------|----------|----------------|--------------|
| Free | 10,000   | ~80            | ~800,000 ✅  |

The free ZeroEntropy plan covers the full top-10k index comfortably.

---

## API Reference

### `GET /api/search`

| Param | Type   | Default | Description          |
|-------|--------|---------|----------------------|
| `q`   | string | —       | Search query (required) |
| `k`   | number | 10      | Number of results (max 20) |

**Response:**
```json
{
  "query": "drag and drop for React hooks",
  "results": [
    {
      "name": "react-dnd",
      "description": "Drag and Drop for React",
      "keywords": "react, drag, drop, dnd",
      "version": "16.0.1",
      "npm_url": "https://www.npmjs.com/package/react-dnd",
      "score": 0.94
    }
  ]
}
```
