const fs = require('fs');
const path = require('path');
const { loadLocalEnv } = require('./env');
const { AI_FIELDS, sanitizeForModel, parseModelJson } = require('./platformNormalizer');
const { validateRecipe, KNOWN_TRANSFORMS } = require('./mappingEngine');

loadLocalEnv();

const DEFAULT_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const DEFAULT_MAPPINGS_DIR = 'data/mappings';
const MAX_SAMPLES = 8;
const RECIPE_VERSION = 2;

// ---------------------------------------------------------------------------
// Build the system prompt — asks for a mapping recipe, not platform data
// ---------------------------------------------------------------------------

function buildRecipeSystemPrompt() {
  const fields = Object.entries(AI_FIELDS)
    .map(([name, type]) => `- ${name}: ${type} or null`)
    .join('\n');

  const transforms = Object.keys(KNOWN_TRANSFORMS).join(', ');

  return `You analyze scraped property listing records and produce a mapping recipe.

You receive several sample records from the same source website. Every record from this source should share the same field schema, but some samples may be sparse or noisy.

Return exactly one JSON object and no Markdown, explanation, or code fence:
{
  "fieldMap": { ...one entry per platform field... },
  "confidence": 0.0,
  "unmappedFields": ["source fields not used"],
  "notes": ["mapping decisions made"]
}

Each entry in fieldMap must be one of:
1. An object with "path" — a dot/bracket path into the record, e.g. "raw.bedroom" or "raw.address.address3" or "raw.building[0]"
2. An object with "value" — a static value, e.g. { "value": "GBP" }
3. null — when the source has no data for this field

Optionally add "transform" (a string) and "args" (an object) to an entry.
Available transforms: ${transforms}

Transform details:
- stripHtml: removes HTML tags from a string value. No args needed.
- purposeMap: maps source values to "sale", "rent", "short-let", or "unknown". Args: { "sourceValue": "platformValue", ... }
- extractUrls: extracts .url or .src from an array of image objects. No args needed.
- appendUnit: converts a number to a string with a unit suffix. Args: { "unit": "sqft" }
- titleCase: capitalizes the first letter of each word. No args needed.
- joinAddress: joins object properties into a string. Args: { "keys": ["address1", "address3", "postcode"], "separator": ", " }
- toNumber: converts a string price like "£250,000" to a number. No args needed.
- firstElement: takes the first element of an array. No args needed.
- currencyFromSymbol: detects currency from a symbol (£=GBP, ₦=NGN, €=EUR, $=USD). No args needed.

Platform fields (every field must appear in fieldMap):
${fields}

Rules:
- The path must reference actual keys visible in the sample records.
- Paths should start from the root of the record object (which includes "raw", "title", "price", etc.).
  Prefer "raw.*" paths since raw contains the richest source data.
- Do not use availability labels such as "Sold STC", "Under Offer", "Available", or "New Build" as the property title. Prefer an address or genuine listing headline.
- Map the complete image/gallery array, not a thumbnail field, whenever both exist.
- Do not map archive-page titles, navigation labels, CSS, SVG text, logos, icons, or placeholder media.
- Do not invent data. Use null when the source genuinely has no value.
- confidence is between 0 and 1 based on how clearly the source fields map.
- Do not map seller/contact/identity fields — they are intentionally excluded.`;
}

// ---------------------------------------------------------------------------
// Pick diverse sample records
// ---------------------------------------------------------------------------

function pickSamples(records, maxSamples) {
  if (records.length <= maxSamples) return records;

  // Evenly sample the entire source so one sparse first/middle/last record
  // cannot define the mapping for hundreds of listings.
  const unique = [...new Set(Array.from({ length: maxSamples }, (_, index) => (
    Math.round(index * (records.length - 1) / Math.max(maxSamples - 1, 1))
  )))];
  return unique.map((i) => records[i]);
}

function truncateForPrompt(record) {
  const clone = JSON.parse(JSON.stringify(record));

  // Remove platform data from previous runs
  delete clone.platform;

  // Truncate very long descriptions
  if (clone.raw) {
    for (const key of Object.keys(clone.raw)) {
      if (typeof clone.raw[key] === 'string' && clone.raw[key].length > 2000) {
        clone.raw[key] = clone.raw[key].slice(0, 2000) + '…';
      }
    }
    // Remove highlight/search metadata
    delete clone.raw._highlightResult;
    delete clone.raw._rankingInfo;
    delete clone.raw._distinctSeqID;
  }

  return sanitizeForModel(clone);
}

// ---------------------------------------------------------------------------
// Call OpenRouter for a mapping recipe
// ---------------------------------------------------------------------------

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function generateMappingRecipe(records, options = {}) {
  const provider = (options.provider || process.env.AI_PROVIDER
    || (options.apiKey || process.env.OPENROUTER_API_KEY ? 'openrouter' : 'gemini')).toLowerCase();
  const isGemini = provider === 'gemini';
  const apiKey = options.apiKey || (isGemini ? process.env.GEMINI_API_KEY : process.env.OPENROUTER_API_KEY);
  if (!apiKey) {
    throw new Error(`${isGemini ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY'} is not set. Add it to .env (see .env.example).`);
  }

  if (isGemini && !options.model && !process.env.GEMINI_MODEL) {
    throw new Error('GEMINI_MODEL is required when AI_PROVIDER=gemini. Set it to a model available to your Gemini account.');
  }
  const model = options.model || (isGemini ? process.env.GEMINI_MODEL : process.env.OPENROUTER_MODEL) || DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required (Node.js 18+).');
  }

  const samples = pickSamples(records, MAX_SAMPLES);
  const truncated = samples.map(truncateForPrompt);
  const userContent = JSON.stringify(truncated, null, 2);

  const requestBody = {
    model,
    temperature: 0,
    max_tokens: 3000,
    messages: [
      { role: 'system', content: buildRecipeSystemPrompt() },
      { role: 'user', content: userContent },
    ],
  };

  const maxAttempts = Math.max(1, Math.min(Number(options.maxAttempts) || 3, 3));
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const baseUrl = isGemini 
        ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
      const token = apiKey;

      const response = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'http-referer': options.referer || process.env.OPENROUTER_SITE_URL || 'http://localhost',
          'x-title': options.appName || process.env.OPENROUTER_APP_NAME || 'listing-scraper',
        },
        body: JSON.stringify(requestBody),
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(Number.parseInt(process.env.AI_TIMEOUT_MS, 10) || 120_000)])
          : AbortSignal.timeout(Number.parseInt(process.env.AI_TIMEOUT_MS, 10) || 120_000),
      });

      const responseText = await response.text();
      let responseJson;
      try {
        responseJson = responseText ? JSON.parse(responseText) : {};
      } catch {
        responseJson = {};
      }

      if (!response.ok) {
        const providerName = isGemini ? 'Gemini' : 'OpenRouter';
        const message = responseJson?.error?.message || responseText || `${providerName} returned HTTP ${response.status}`;
        const error = new Error(`${providerName} request failed (${response.status}): ${message}`);
        error.status = response.status;
        throw error;
      }

      const content = responseJson?.choices?.[0]?.message?.content;
      const parsed = parseModelJson(content);
      const { recipe, warnings } = validateRecipe(parsed);

      recipe._model = responseJson?.model || model;
      recipe._generatedAt = new Date().toISOString();
      recipe._sampleCount = samples.length;
      recipe._recipeVersion = RECIPE_VERSION;

      if (warnings.length) {
        recipe.notes = [...(recipe.notes || []), ...warnings];
      }

      return recipe;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryableStatus(error.status)) break;
      await wait(700 * attempt);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Cache management — load/save recipes to data/mappings/<hostname>.json
// ---------------------------------------------------------------------------

function hostnameSlug(sourceUrl) {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
  } catch {
    return 'unknown-source';
  }
}

function recipePath(sourceUrl, mappingsDir) {
  const dir = mappingsDir || DEFAULT_MAPPINGS_DIR;
  return path.resolve(dir, `${hostnameSlug(sourceUrl)}.json`);
}

function loadCachedRecipe(sourceUrl, mappingsDir) {
  const filePath = recipePath(sourceUrl, mappingsDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const recipe = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!recipe.fieldMap || typeof recipe.fieldMap !== 'object') return null;
    return recipe;
  } catch {
    return null;
  }
}

function saveCachedRecipe(sourceUrl, recipe, mappingsDir) {
  const filePath = recipePath(sourceUrl, mappingsDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(recipe, null, 2) + '\n');
  return filePath;
}

async function loadOrGenerateRecipe(sourceUrl, records, options = {}) {
  let staleRecipe = null;
  if (!options.forceRegenerate) {
    const cached = loadCachedRecipe(sourceUrl, options.mappingsDir);
    const reviewed = cached?._model === 'deterministic-reviewed';
    if (cached && (cached._recipeVersion === RECIPE_VERSION || reviewed)) {
      console.log(`  Using cached mapping recipe for ${hostnameSlug(sourceUrl)}`);
      return cached;
    }
    staleRecipe = cached;
    if (cached) console.log(`  Cached recipe for ${hostnameSlug(sourceUrl)} is outdated; regenerating it.`);
  }

  console.log(`  Generating mapping recipe for ${hostnameSlug(sourceUrl)} (${pickSamples(records, MAX_SAMPLES).length} sample(s))...`);
  let recipe;
  try {
    recipe = await generateMappingRecipe(records, options);
  } catch (error) {
    if (!staleRecipe) throw error;
    console.warn(`  Recipe regeneration failed (${error.message}); using the previous recipe and marking it for review.`);
    staleRecipe.confidence = Math.min(Number(staleRecipe.confidence) || 0, 0.6);
    staleRecipe.notes = [...(staleRecipe.notes || []), `Outdated recipe fallback: ${error.message}`];
    return staleRecipe;
  }
  const savedPath = saveCachedRecipe(sourceUrl, recipe, options.mappingsDir);
  console.log(`  Recipe saved to ${savedPath}`);
  return recipe;
}

module.exports = {
  DEFAULT_MODEL,
  RECIPE_VERSION,
  buildRecipeSystemPrompt,
  pickSamples,
  generateMappingRecipe,
  hostnameSlug,
  recipePath,
  loadCachedRecipe,
  saveCachedRecipe,
  loadOrGenerateRecipe,
};
