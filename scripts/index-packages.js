/**
 * Fetch top npm packages and index them in ZeroEntropy for semantic search.
 *
 * Strategy:
 *   1. Pull up to 10,000 packages from the npm registry search API,
 *      sorted by popularity (weekly downloads).
 *   2. For each package, build a rich text document containing its name,
 *      description, keywords, and author.
 *   3. Upsert every document into a ZeroEntropy collection.
 *
 * Run: node scripts/index-packages.js
 */

require('dotenv').config();
const fetch = require('node-fetch');

const ZE_API_KEY = process.env.ZERO_ENTROPY_API_KEY;
const ZE_BASE_URL = process.env.ZERO_ENTROPY_BASE_URL || 'https://api.zeroentropy.dev';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'npm-packages';

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const PAGE_SIZE = 250;        // npm API max per request
const TARGET_PACKAGES = 10000;
const CONCURRENCY = 5;        // parallel ZeroEntropy upserts

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function zeRequest(path, body, retries = 4) {
  const url = `${ZE_BASE_URL}${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ZE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`  Rate limited – waiting ${wait}ms…`);
        await sleep(wait);
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${text}`);
        err.status = res.status;
        throw err;
      }
      return JSON.parse(text);
    } catch (err) {
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw err;
      }
      if (attempt === retries) throw err;
      const wait = Math.pow(2, attempt) * 500;
      console.warn(`  Retry ${attempt + 1}/${retries} for ${path}: ${err.message}`);
      await sleep(wait);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1 – Ensure collection exists
// ---------------------------------------------------------------------------

async function ensureCollection() {
  console.log(`\nEnsuring collection "${COLLECTION_NAME}" exists…`);
  try {
    await zeRequest('/v1/collections/add-collection', {
      collection_name: COLLECTION_NAME,
    });
    console.log('  Collection created.');
  } catch (err) {
    // 409 means it already exists – that's fine
    if (err.message.includes('409') || err.message.toLowerCase().includes('conflict') || err.message.toLowerCase().includes('already')) {
      console.log('  Collection already exists – continuing.');
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2 – Fetch packages from the npm registry
// ---------------------------------------------------------------------------

async function fetchPage(from, retries = 5) {
  const url =
    `${NPM_SEARCH_URL}?text=keywords:%22%22&size=${PAGE_SIZE}&from=${from}` +
    `&quality=0.0&popularity=1.0&maintenance=0.0`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'npm-semantic-search-indexer/1.0' },
    });
    
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.pow(2, attempt) * 2000;
      process.stdout.write(`\n  npm registry HTTP ${res.status} for from=${from} – waiting ${wait}ms before retry…\n`);
      await sleep(wait);
      continue;
    }
    
    if (!res.ok) {
      throw new Error(`npm registry returned HTTP ${res.status} for from=${from}`);
    }
    
    const data = await res.json();
    return data.objects || [];
  }
  
  throw new Error(`npm registry returned HTTP 429 for from=${from} after ${retries} retries.`);
}

async function fetchAllPackages() {
  console.log(`\nFetching up to ${TARGET_PACKAGES} packages from npm registry…`);
  const packages = [];
  let from = 0;

  while (packages.length < TARGET_PACKAGES) {
    const remaining = TARGET_PACKAGES - packages.length;
    const size = Math.min(PAGE_SIZE, remaining);

    let objects;
    try {
      objects = await fetchPage(from);
    } catch (err) {
      console.warn(`  Error fetching page at from=${from}: ${err.message}`);
      break;
    }

    if (!objects.length) {
      console.log('  npm registry returned 0 results – stopping.');
      break;
    }

    packages.push(...objects.slice(0, size));
    from += objects.length;

    const pct = ((packages.length / TARGET_PACKAGES) * 100).toFixed(1);
    process.stdout.write(`  Fetched ${packages.length.toLocaleString()} / ${TARGET_PACKAGES.toLocaleString()} (${pct}%)\r`);

    // Small delay to be a good citizen
    await sleep(200);
  }

  console.log(`\n  Done – ${packages.length.toLocaleString()} packages collected.`);
  return packages;
}

// ---------------------------------------------------------------------------
// Step 3 – Build a rich text document for each package
// ---------------------------------------------------------------------------

function buildDocument(obj) {
  const pkg = obj.package || obj;
  const name = pkg.name || '';
  const description = pkg.description || '';
  const keywords = (pkg.keywords || []).join(', ');
  const author = pkg.author
    ? typeof pkg.author === 'string'
      ? pkg.author
      : pkg.author.name || ''
    : '';
  const version = pkg.version || '';
  const links = pkg.links || {};
  const npm = links.npm || `https://www.npmjs.com/package/${encodeURIComponent(name)}`;

  const lines = [
    `Package: ${name}`,
    description ? `Description: ${description}` : null,
    keywords ? `Keywords: ${keywords}` : null,
    author ? `Author: ${author}` : null,
    version ? `Latest version: ${version}` : null,
    `npm: ${npm}`,
  ].filter(Boolean);

  return {
    path: `packages/${name}`,
    text: lines.join('\n'),
    metadata: {
      name,
      description,
      keywords,
      version,
      npm_url: npm,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 4 – Upsert documents into ZeroEntropy
// ---------------------------------------------------------------------------

async function upsertDocument(doc) {
  try {
    await zeRequest('/v1/documents/add-document', {
      collection_name: COLLECTION_NAME,
      path: doc.path,
      content: {
        type: 'text',
        text: doc.text,
      },
      metadata: doc.metadata,
    });
  } catch (err) {
    if (err.message.includes('409') || err.message.toLowerCase().includes('already exists') || err.message.toLowerCase().includes('conflict')) {
      // Document already exists, skip it, or log it but don't fail
      // We'll consider this a successful "upsert" (since the data is already there and we don't need to overwrite it)
      return;
    } else {
      throw err;
    }
  }
}


async function indexPackages(packages) {
  console.log(`\nIndexing ${packages.length.toLocaleString()} packages into ZeroEntropy…`);

  let indexed = 0;
  let errors = 0;

  // Process in batches using simple concurrency
  const queue = packages.map((p) => buildDocument(p));

  async function worker(items) {
    for (const doc of items) {
      try {
        await upsertDocument(doc);
        indexed++;
      } catch (err) {
        errors++;
        console.warn(`  Failed to index "${doc.metadata.name}": ${err.message}`);
      }

      if ((indexed + errors) % 100 === 0) {
        const total = indexed + errors;
        const pct = ((total / packages.length) * 100).toFixed(1);
        process.stdout.write(
          `  Indexed ${indexed.toLocaleString()} | Errors ${errors} | ${pct}%\r`
        );
      }
    }
  }

  // Split into CONCURRENCY slices
  const chunkSize = Math.ceil(queue.length / CONCURRENCY);
  const chunks = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    chunks.push(queue.slice(i * chunkSize, (i + 1) * chunkSize));
  }

  await Promise.all(chunks.map((chunk) => worker(chunk)));

  console.log(
    `\n  Done! Indexed: ${indexed.toLocaleString()} | Errors: ${errors}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log('=== npm Semantic Search – Indexer ===');
  console.log(`Collection : ${COLLECTION_NAME}`);
  console.log(`ZeroEntropy: ${ZE_BASE_URL}`);

  if (!ZE_API_KEY) {
    console.error('ERROR: ZERO_ENTROPY_API_KEY is not set. Add it to .env');
    process.exit(1);
  }

  await ensureCollection();
  const packages = await fetchAllPackages();
  await indexPackages(packages);

  console.log('\nIndexing complete! You can now start the search server:');
  console.log('  npm start');
})();
