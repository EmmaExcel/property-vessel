const { loadLocalEnv } = require('./env');

loadLocalEnv();

// The free availability of individual Qwen variants changes frequently. This
// router selects a currently live free model instead of failing on a stale slug.
const DEFAULT_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const DEFAULT_CONCURRENCY = 1;
const MAX_MODEL_INPUT_CHARS = 45_000;
const PERSONAL_DATA_KEYS = new Set([
  'sellerfullname', 'selleremail', 'sellerphone', 'sellerfulladdress', 'sellerdob',
  'agentcontact', 'agentemail', 'agentphone', 'agentmobile', 'email', 'phone',
  'telephone', 'mobile', 'contact', 'dob', 'dateofbirth', 'birthdate',
]);

// These are fields the scraper may infer from a public listing. Operational
// flags and seller identity are deliberately excluded from the model prompt.
const AI_FIELDS = {
  title: 'string',
  purpose: 'string',
  location: 'string',
  price: 'number',
  images: 'string[]',
  address: 'string',
  landmark: 'string',
  radius: 'string',
  city: 'string',
  typeOfProperty: 'string',
  bedrooms: 'number',
  bathrooms: 'number',
  toilets: 'number',
  livingRoom: 'number',
  size: 'string',
  tenureOfProperty: 'string',
  description: 'string',
  amount: 'number',
  minimum_offer: 'number',
  currency: 'string',
  add_features: 'string[]',
  video_link: 'string',
  virtual_tour_link: 'string',
  floorPlan: 'string[]',
  PCM: 'number',
  PCW: 'number',
  subType: 'string',
};

const STRING_FIELDS = new Set(Object.entries(AI_FIELDS)
  .filter(([, type]) => type === 'string')
  .map(([field]) => field));
const NUMBER_FIELDS = new Set(Object.entries(AI_FIELDS)
  .filter(([, type]) => type === 'number')
  .map(([field]) => field));
const ARRAY_FIELDS = new Set(Object.entries(AI_FIELDS)
  .filter(([, type]) => type === 'string[]')
  .map(([field]) => field));
const CURRENCIES = /^[A-Z]{3}$/;

function platformFieldTemplate() {
  return Object.fromEntries(Object.keys(AI_FIELDS).map((field) => [field, null]));
}

function sourcePlatformName(sourceUrl) {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function systemOwnedDefaults(sourceUrl) {
  return {
    justAddedExpiration: false,
    isPaid: false,
    isSold: false,
    salesPlatform: sourcePlatformName(sourceUrl),
    isArchive: false,
    profilePicture: null,
  };
}

function sanitizeForModel(value, depth = 0) {
  if (depth > 8 || value === undefined || value === null) return value ?? null;
  if (typeof value === 'string') return value.slice(0, 12_000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeForModel(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 1_000);

  const clean = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (PERSONAL_DATA_KEYS.has(normalizedKey)) continue;
    clean[key] = sanitizeForModel(nested, depth + 1);
  }
  return clean;
}

function makeModelInput(record) {
  const currentNormalized = { ...record };
  delete currentNormalized.raw;
  delete currentNormalized.agentContact;

  const payload = {
    currentNormalized: sanitizeForModel(currentNormalized),
    sourceRecord: sanitizeForModel(record.raw || {}),
  };
  const json = JSON.stringify(payload);
  return json.length <= MAX_MODEL_INPUT_CHARS ? json : JSON.stringify({
    currentNormalized: payload.currentNormalized,
    sourceRecord: { description: String(payload.sourceRecord?.description || '').slice(0, 8_000) },
    warning: 'Source record was truncated before being sent to the model.',
  });
}

function buildSystemPrompt() {
  const fields = Object.entries(AI_FIELDS).map(([name, type]) => `- ${name}: ${type} or null`).join('\n');
  return `You normalize public property-listing data into a platform import draft.

Return exactly one JSON object and no Markdown, explanation, or code fence:
{
  "data": { ...allowed fields... },
  "confidence": 0.0,
  "unmappedFields": ["source field names that were not used"],
  "warnings": ["uncertainties or conflicts"]
}

Allowed data fields (every field must be present; use null when unknown):
${fields}

Rules:
- Do not invent facts. Use null when the listing does not support a value.
- Do not create seller/contact/identity data. It is intentionally unavailable.
- Return numbers as numbers without currency signs or commas. A zero is valid only when explicitly stated.
- currency must be a three-letter ISO code only when clear from the source (for example £ = GBP, ₦ = NGN).
- purpose must be one of "sale", "rent", "short-let", or "unknown".
- price and amount should be the advertised numeric price when known. For rent, set PCM and/or PCW only if the period is explicitly known.
- images, add_features, and floorPlan must be arrays of strings or null. video_link and virtual_tour_link must be URLs or null.
- Keep source wording for address, location, property type, tenure, and description; do not embellish it.
- confidence is between 0 and 1 and reflects evidence in the input, not optimism.`;
}

function parseModelJson(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('The model returned an empty response.');
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // Use the clearer error below.
      }
    }
    throw new Error('The model response was not valid JSON.');
  }
}

function toNullableString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result || null;
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/,/g, '').trim();
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  const numeric = match ? Number(match[0]) : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function toNullableStringArray(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const cleaned = value.map(toNullableString).filter(Boolean);
  return cleaned.length ? cleaned : null;
}

function normalizePurpose(value) {
  const purpose = toNullableString(value)?.toLowerCase();
  if (!purpose || purpose === 'unknown') return purpose || null;
  if (/short[\s-]?(let|term)|holiday/.test(purpose)) return 'short-let';
  if (/rent|let|lease/.test(purpose)) return 'rent';
  if (/sale|buy|purchase/.test(purpose)) return 'sale';
  return 'unknown';
}

function sourceValue(record, aliases) {
  const wanted = new Set(aliases.map((value) => value.replace(/[^a-z0-9]/gi, '').toLowerCase()));
  let found;
  function visit(value, depth = 0) {
    if (found !== undefined || !value || typeof value !== 'object' || depth > 6) return;
    for (const [key, nested] of Object.entries(value)) {
      if (wanted.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase()) && nested !== null && nested !== undefined && nested !== '') {
        found = nested;
        return;
      }
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  }
  visit(record);
  return found;
}

function currencyFromSource(record) {
  const direct = sourceValue(record, ['currency', 'priceCurrency', 'price_currency']);
  if (typeof direct === 'string' && CURRENCIES.test(direct.trim().toUpperCase())) return direct.trim().toUpperCase();
  const text = String(sourceValue(record, ['price', 'priceValue', 'amount']) ?? '');
  if (/£|&pound;|&#163;/i.test(text)) return 'GBP';
  if (/₦|&#8358;|\bNGN\b/i.test(text)) return 'NGN';
  if (/€|&euro;|&#8364;/i.test(text)) return 'EUR';
  if (/\$|&dollar;|&#36;/i.test(text)) return 'USD';
  const country = String(record?.record?.country || sourceValue(record, ['country', 'addressCountry']) || '').toUpperCase();
  const postcode = String(record?.record?.postcode || sourceValue(record, ['postcode', 'postalCode']) || '').trim();
  if (/^(?:UK|GB|UNITED KINGDOM|ENGLAND|SCOTLAND|WALES|NORTHERN IRELAND)$/.test(country)
      || /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(postcode)) return 'GBP';
  const siteUrl = String(record?.record?.sourceSiteUrl || record?.record?.sourceUrl || '');
  try {
    const hostname = new URL(siteUrl).hostname.toLowerCase();
    if (hostname.endsWith('.co.uk') || hostname.endsWith('.uk')) return 'GBP';
    if (hostname.endsWith('.ng') || hostname.endsWith('.com.ng')) return 'NGN';
  } catch {
    // A missing/relative source URL is not enough evidence for a currency.
  }
  return null;
}

function urlArray(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const urls = items.map((item) => {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object') return item.url || item.src || item.href || item.contentUrl || null;
    return null;
  }).filter(Boolean);
  return urls.length ? [...new Set(urls)] : null;
}

function toSourceString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(toSourceString).find(Boolean) || null;
  if (typeof value === 'object') {
    const preferred = ['building_number', 'buildingName', 'streetAddress', 'address1', 'address2', 'address3', 'town', 'city', 'postcode', 'postalCode'];
    const parts = preferred.map((key) => toSourceString(value[key])).filter(Boolean);
    if (parts.length) return [...new Set(parts)].join(', ');
  }
  return null;
}

function deriveDeterministicPlatformData(record) {
  const raw = record?.raw || record || {};
  const priceSource = record?.price ?? sourceValue(raw, ['priceValue', 'price', 'askingPrice', 'listPrice']);
  const purposeSource = sourceValue({ record, raw }, ['purpose', 'channel', 'department', 'search_type', 'instruction_type', 'listingType'])
    || record?.sourceSiteUrl || record?.sourceUrl;
  const images = urlArray(record?.images ?? sourceValue(raw, ['images', 'photos', 'propertyIndexPhotos', 'photo', 'gallery']));
  const floorPlan = urlArray(sourceValue(raw, ['floorPlan', 'floorPlans', 'floorplan', 'floorplans']));
  const features = sourceValue(raw, ['features', 'propertyFeatures', 'bulletPoints', 'keyFeatures']);
  const periodText = `${String(priceSource || '')} ${String(sourceValue(raw, ['priceQualifier', 'rentFrequency', 'frequency']) || '')}`;
  const price = toNullableNumber(priceSource);
  return {
    title: toSourceString(record?.title) || toSourceString(sourceValue(raw, ['title', 'headline', 'displayAddress', 'name'])) || toSourceString(record?.address),
    purpose: normalizePurpose(purposeSource) || 'unknown',
    location: toSourceString(record?.address) || toSourceString(record?.city) || toSourceString(sourceValue(raw, ['displayAddress', 'location', 'area'])),
    price,
    images,
    address: toSourceString(record?.address) || toSourceString(sourceValue(raw, ['displayAddress', 'addressWithCommas', 'address'])),
    city: toSourceString(record?.city) || toSourceString(sourceValue(raw, ['city', 'town', 'addressLocality'])),
    typeOfProperty: toSourceString(record?.propertyType) || toSourceString(sourceValue(raw, ['propertyType', 'type', 'building', 'subType'])),
    bedrooms: toNullableNumber(record?.bedrooms ?? sourceValue(raw, ['bedrooms', 'bedroom', 'beds'])),
    bathrooms: toNullableNumber(record?.bathrooms ?? sourceValue(raw, ['bathrooms', 'bathroom', 'baths'])),
    livingRoom: toNullableNumber(sourceValue(raw, ['livingRoom', 'reception', 'receptions', 'receptionRooms'])),
    size: toSourceString(record?.sqft) || toSourceString(sourceValue(raw, ['size', 'floorArea', 'squareFeetInternal', 'squareFeet'])),
    tenureOfProperty: toSourceString(sourceValue(raw, ['tenure', 'tenureOfProperty'])),
    description: toSourceString(record?.description) || toSourceString(sourceValue(raw, ['longDescription', 'description', 'shortDescription', 'summary'])),
    amount: price,
    currency: currencyFromSource({ record, raw }),
    add_features: Array.isArray(features)
      ? (features.map((value) => typeof value === 'string' ? value.trim() : null).filter(Boolean).length
        ? features.map((value) => typeof value === 'string' ? value.trim() : null).filter(Boolean)
        : null)
      : null,
    video_link: toSourceString(sourceValue(raw, ['videoLink', 'videoUrl', 'video'])),
    virtual_tour_link: toSourceString(sourceValue(raw, ['virtualTourLink', 'virtualTour', 'virtual_tour'])),
    floorPlan,
    PCM: /\bpcm\b|per\s+month/i.test(periodText) ? price : null,
    PCW: /\b(?:pcw|pw)\b|per\s+week/i.test(periodText) ? price : null,
    subType: toSourceString(sourceValue(raw, ['subType', 'propertySubType', 'style'])),
  };
}

function makeSourceEnvelope(record, sourceUrl) {
  if (!record || typeof record !== 'object') return null;
  const contact = record.contact || {
    names: record.agentName ? [record.agentName] : [],
    emails: record.agentEmail ? [record.agentEmail] : [],
    phones: record.agentPhone ? [record.agentPhone] : [],
  };
  return {
    id: record.id ?? sourceValue(record.raw || {}, ['id', 'propertyId', 'listingId', 'crmId', 'objectID']) ?? null,
    url: record.sourceUrl || null,
    siteUrl: record.sourceSiteUrl || sourceUrl || null,
    status: record.status ?? null,
    postcode: record.postcode ?? null,
    state: record.state ?? null,
    country: record.country ?? null,
    latitude: record.latitude ?? null,
    longitude: record.longitude ?? null,
    agentName: record.agentName ?? contact.names?.[0] ?? null,
    contact: {
      names: Array.isArray(contact.names) ? [...new Set(contact.names.filter(Boolean))] : [],
      emails: Array.isArray(contact.emails) ? [...new Set(contact.emails.filter(Boolean))] : [],
      phones: Array.isArray(contact.phones) ? [...new Set(contact.phones.filter(Boolean))] : [],
    },
    raw: record.raw || record,
  };
}

function preserveAndRecoverPlatformData(platform, record, sourceUrl) {
  const fallback = deriveDeterministicPlatformData(record);
  const recoveredFields = [];
  for (const field of Object.keys(AI_FIELDS)) {
    const current = platform[field];
    const missing = current === null || current === undefined || current === '' || (Array.isArray(current) && current.length === 0);
    if (missing && fallback[field] !== null && fallback[field] !== undefined && fallback[field] !== 'unknown') {
      platform[field] = fallback[field];
      recoveredFields.push(field);
    }
  }
  platform._source = makeSourceEnvelope(record, sourceUrl);
  if (platform._normalization) {
    platform._normalization.recoveredFields = recoveredFields;
    platform._normalization.missingFields = Object.entries(platform)
      .filter(([field, value]) => field in AI_FIELDS && value === null)
      .map(([field]) => field);
    platform._normalization.criticalMissing = ['title', 'purpose', 'price', 'currency', 'typeOfProperty']
      .filter((field) => platform[field] === null || platform[field] === 'unknown');
    platform._normalization.requiresReview = platform._normalization.confidence < 0.8
      || platform._normalization.criticalMissing.length > 0
      || platform._normalization.status === 'failed';
  }
  return platform;
}

function validateAiResult(result, source) {
  const sourceUrl = typeof source === 'string' ? source : source?.sourceUrl || source?.sourceSiteUrl;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('The model result must be a JSON object.');
  }
  const rawData = result.data;
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new Error('The model result did not contain a data object.');
  }

  const data = platformFieldTemplate();
  const warnings = Array.isArray(result.warnings) ? result.warnings.map(toNullableString).filter(Boolean) : [];
  for (const field of Object.keys(AI_FIELDS)) {
    const value = rawData[field];
    if (STRING_FIELDS.has(field)) data[field] = toNullableString(value);
    if (NUMBER_FIELDS.has(field)) data[field] = toNullableNumber(value);
    if (ARRAY_FIELDS.has(field)) data[field] = toNullableStringArray(value);
    if (field === 'purpose') data[field] = normalizePurpose(value);
    if (field === 'currency' && data[field] !== null) {
      data[field] = data[field].toUpperCase();
      if (!CURRENCIES.test(data[field])) data[field] = null;
    }
    if (value !== undefined && data[field] === null && value !== null) {
      warnings.push(`Ignored invalid ${field} value returned by model.`);
    }
  }

  const confidenceValue = Number(result.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : 0;
  const missingFields = Object.entries(data)
    .filter(([, value]) => value === null)
    .map(([field]) => field);
  const criticalMissing = ['title', 'purpose', 'price', 'currency', 'typeOfProperty']
    .filter((field) => data[field] === null || data[field] === 'unknown');

  const platform = {
    ...data,
    ...systemOwnedDefaults(sourceUrl),
    _normalization: {
      status: 'complete',
      provider: 'openrouter',
      model: null,
      confidence,
      requiresReview: confidence < 0.8 || criticalMissing.length > 0,
      missingFields,
      criticalMissing,
      unmappedFields: Array.isArray(result.unmappedFields)
        ? result.unmappedFields.map(toNullableString).filter(Boolean)
        : [],
      warnings,
    },
  };
  return preserveAndRecoverPlatformData(platform, typeof source === 'object' ? source : null, sourceUrl);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function callOpenRouter(record, options = {}) {
  const provider = (options.provider || process.env.AI_PROVIDER
    || (options.apiKey || process.env.OPENROUTER_API_KEY ? 'openrouter' : 'gemini')).toLowerCase();
  const isGemini = provider === 'gemini';
  const apiKey = options.apiKey || (isGemini ? process.env.GEMINI_API_KEY : process.env.OPENROUTER_API_KEY);
  if (!apiKey) {
    throw new Error(`${isGemini ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY'} is not set. Add it to .env (see .env.example) or configure it in your server environment.`);
  }

  if (isGemini && !options.model && !process.env.GEMINI_MODEL) {
    throw new Error('GEMINI_MODEL is required when AI_PROVIDER=gemini. Set it to a model available to your Gemini account.');
  }
  const model = options.model || (isGemini ? process.env.GEMINI_MODEL : process.env.OPENROUTER_MODEL) || DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required (Node.js 18+).');

  const requestBody = {
    model,
    temperature: 0,
    max_tokens: 1_800,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: makeModelInput(record) },
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
        signal: options.signal || AbortSignal.timeout(60_000),
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
      const normalized = validateAiResult(parseModelJson(content), record);
      normalized._normalization.model = responseJson?.model || model;
      return normalized;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryableStatus(error.status)) break;
      await wait(700 * attempt);
    }
  }
  throw lastError;
}

async function normalizeListingsWithAi(records, options = {}) {
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || DEFAULT_CONCURRENCY, 3));
  const output = new Array(records.length);
  let nextIndex = 0;
  let normalized = 0;
  let failed = 0;

  async function worker() {
    while (nextIndex < records.length) {
      const index = nextIndex;
      nextIndex += 1;
      const original = records[index];
      try {
        const platform = await callOpenRouter(original, options);
        output[index] = { ...original, platform };
        normalized += 1;
      } catch (error) {
        failed += 1;
        const failedPlatform = preserveAndRecoverPlatformData({
            ...platformFieldTemplate(),
            ...systemOwnedDefaults(original.sourceUrl || original.sourceSiteUrl),
            _normalization: {
              status: 'failed',
              provider: 'openrouter',
              model: options.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
              confidence: 0,
              requiresReview: true,
              missingFields: Object.keys(AI_FIELDS),
              criticalMissing: ['title', 'purpose', 'price', 'currency', 'typeOfProperty'],
              unmappedFields: [],
              warnings: [error.message],
            },
          }, original, original.sourceUrl || original.sourceSiteUrl);
        output[index] = {
          ...original,
          platform: failedPlatform,
        };
      }
      if (typeof options.onProgress === 'function') options.onProgress({ completed: index + 1, total: records.length, normalized, failed });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));
  return { records: output, normalized, failed };
}

function platformOnly(records) {
  return records.map((record) => record.platform || null);
}

module.exports = {
  DEFAULT_MODEL,
  AI_FIELDS,
  platformFieldTemplate,
  sanitizeForModel,
  makeModelInput,
  buildSystemPrompt,
  parseModelJson,
  validateAiResult,
  deriveDeterministicPlatformData,
  preserveAndRecoverPlatformData,
  makeSourceEnvelope,
  callOpenRouter,
  normalizeListingsWithAi,
  platformOnly,
};
