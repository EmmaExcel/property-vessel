const {
  AI_FIELDS,
  platformFieldTemplate,
  preserveAndRecoverPlatformData,
} = require('./platformNormalizer');

// ---------------------------------------------------------------------------
// Known transforms — a fixed registry of safe, deterministic operations.
// The AI picks from these by name; it never generates arbitrary code.
// ---------------------------------------------------------------------------

function stripHtml(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function purposeMap(value, args) {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase().trim();
  if (args && typeof args === 'object') {
    for (const [key, mapped] of Object.entries(args)) {
      if (lower === key.toLowerCase()) return mapped;
    }
  }
  if (/short[\s-]?(let|term)|holiday/i.test(lower)) return 'short-let';
  if (/rent|let(?:ting)?s?|lease/i.test(lower)) return 'rent';
  if (/sale|buy|purchase|sales/i.test(lower)) return 'sale';
  return 'unknown';
}

function extractUrls(value) {
  if (!Array.isArray(value)) return value;
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.url || item.src || item.href || null;
      return null;
    })
    .filter(Boolean);
}

function appendUnit(value, args) {
  if (value === null || value === undefined) return null;
  const unit = args?.unit || '';
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num === 0) return null;
  return unit ? `${num} ${unit}` : String(num);
}

function titleCase(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function joinAddress(value, args) {
  if (typeof value !== 'object' || value === null) return typeof value === 'string' ? value : null;
  const keys = args?.keys || Object.keys(value);
  const parts = keys
    .map((key) => value[key])
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => part.trim());
  const separator = args?.separator || ', ';
  return parts.length ? parts.join(separator) : null;
}

function decodeCurrencies(str) {
  if (typeof str !== 'string') return String(str);
  return str
    .replace(/&#163;|&pound;/gi, '£')
    .replace(/&#36;|&dollar;/gi, '$')
    .replace(/&#8364;|&euro;/gi, '€')
    .replace(/&#8358;/gi, '₦');
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const decoded = decodeCurrencies(value);
  const cleaned = decoded.replace(/[£$€₦,\s]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function firstElement(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function currencyFromSymbol(value) {
  if (typeof value !== 'string') return null;
  const decoded = decodeCurrencies(value);
  if (decoded.includes('£')) return 'GBP';
  if (decoded.includes('₦')) return 'NGN';
  if (decoded.includes('€')) return 'EUR';
  if (decoded.includes('$')) return 'USD';
  const upper = decoded.toUpperCase().trim();
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  return null;
}

const KNOWN_TRANSFORMS = {
  stripHtml,
  purposeMap,
  extractUrls,
  appendUnit,
  titleCase,
  joinAddress,
  toNumber,
  firstElement,
  currencyFromSymbol,
};

// ---------------------------------------------------------------------------
// Path resolution — walks dot/bracket paths like "raw.address.address3"
// ---------------------------------------------------------------------------

function resolveValue(record, pathSpec) {
  if (!pathSpec || typeof pathSpec !== 'object') return null;

  // Static value (no path lookup needed)
  if ('value' in pathSpec) return pathSpec.value;

  const pathStr = pathSpec.path;
  if (typeof pathStr !== 'string' || !pathStr) return null;

  // Parse path tokens: "raw.address.address3" or "raw.building[0]"
  const tokens = pathStr.match(/[^.\[\]]+/g);
  if (!tokens) return null;

  let current = record;
  for (const token of tokens) {
    if (current === undefined || current === null) return null;
    current = current[token];
  }

  return current === undefined ? null : current;
}

// ---------------------------------------------------------------------------
// Apply a single field spec (resolve value, then apply transform if any)
// ---------------------------------------------------------------------------

function applyFieldSpec(record, spec) {
  if (spec === null || spec === undefined) return null;
  if (typeof spec !== 'object') return null;

  let value = resolveValue(record, spec);

  if (spec.transform && KNOWN_TRANSFORMS[spec.transform]) {
    value = KNOWN_TRANSFORMS[spec.transform](value, spec.args);
  }

  return value === undefined ? null : value;
}

// ---------------------------------------------------------------------------
// Type coercion for platform schema fields
// ---------------------------------------------------------------------------

const STRING_FIELDS = new Set(Object.entries(AI_FIELDS)
  .filter(([, type]) => type === 'string')
  .map(([field]) => field));
const NUMBER_FIELDS = new Set(Object.entries(AI_FIELDS)
  .filter(([, type]) => type === 'number')
  .map(([field]) => field));
const ARRAY_FIELDS = new Set(Object.entries(AI_FIELDS)
  .filter(([, type]) => type === 'string[]')
  .map(([field]) => field));

function coerceValue(field, value) {
  if (value === null || value === undefined) return null;

  if (STRING_FIELDS.has(field)) {
    if (typeof value !== 'string') return String(value);
    return value.trim() || null;
  }
  if (NUMBER_FIELDS.has(field)) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const num = Number(String(value).replace(/[,\s]/g, ''));
    return Number.isFinite(num) ? num : null;
  }
  if (ARRAY_FIELDS.has(field)) {
    if (!Array.isArray(value)) return null;
    const cleaned = value.filter((item) => item !== null && item !== undefined);
    return cleaned.length ? cleaned : null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// System-owned defaults (same as platformNormalizer.js)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Apply a full recipe to a single record
// ---------------------------------------------------------------------------

function applyRecipe(record, recipe, sourceUrl) {
  const fieldMap = recipe.fieldMap || {};
  const data = platformFieldTemplate();

  for (const field of Object.keys(AI_FIELDS)) {
    const spec = fieldMap[field];
    if (spec === null || spec === undefined) {
      data[field] = null;
      continue;
    }
    const raw = applyFieldSpec(record, spec);
    data[field] = coerceValue(field, raw);
  }

  // Normalize purpose to allowed values
  if (data.purpose) {
    const purpose = data.purpose.toLowerCase();
    if (/short[\s-]?(let|term)|holiday/.test(purpose)) data.purpose = 'short-let';
    else if (/rent|let|lease/.test(purpose)) data.purpose = 'rent';
    else if (/sale|buy|purchase/.test(purpose)) data.purpose = 'sale';
    else if (purpose !== 'unknown') data.purpose = 'unknown';
  }

  // Validate currency
  if (data.currency && !/^[A-Z]{3}$/.test(data.currency.toUpperCase())) {
    data.currency = null;
  } else if (data.currency) {
    data.currency = data.currency.toUpperCase();
  }

  const missingFields = Object.entries(data)
    .filter(([, value]) => value === null)
    .map(([field]) => field);
  const criticalMissing = ['title', 'purpose', 'price', 'currency', 'typeOfProperty']
    .filter((field) => data[field] === null || data[field] === 'unknown');

  const confidence = recipe.confidence || 0;

  const platform = {
    ...data,
    ...systemOwnedDefaults(sourceUrl),
    _normalization: {
      status: 'complete',
      provider: 'mapping-recipe',
      model: recipe._model || null,
      confidence,
      requiresReview: confidence < 0.8 || criticalMissing.length > 0,
      missingFields,
      criticalMissing,
      unmappedFields: recipe.unmappedFields || [],
      warnings: recipe.notes || [],
    },
  };
  return preserveAndRecoverPlatformData(platform, record, sourceUrl);
}

// ---------------------------------------------------------------------------
// Apply recipe to an entire batch — zero API calls
// ---------------------------------------------------------------------------

function applyRecipeBatch(records, recipe, sourceUrl) {
  const output = records.map((record) => {
    const platform = applyRecipe(record, recipe, sourceUrl);
    return { ...record, platform };
  });
  const failed = output.filter((r) => r.platform._normalization.requiresReview).length;
  return {
    records: output,
    normalized: output.length - failed,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Validate a recipe returned by the AI
// ---------------------------------------------------------------------------

function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') {
    throw new Error('Recipe must be a JSON object.');
  }
  if (!recipe.fieldMap || typeof recipe.fieldMap !== 'object') {
    throw new Error('Recipe must contain a fieldMap object.');
  }

  const warnings = [];
  for (const [field, spec] of Object.entries(recipe.fieldMap)) {
    if (!(field in AI_FIELDS)) {
      warnings.push(`Unknown platform field "${field}" — ignored.`);
      delete recipe.fieldMap[field];
      continue;
    }
    if (spec === null) continue;
    if (typeof spec !== 'object') {
      throw new Error(`fieldMap.${field} must be an object or null, got ${typeof spec}.`);
    }
    if (spec.transform && !KNOWN_TRANSFORMS[spec.transform]) {
      warnings.push(`Unknown transform "${spec.transform}" on field "${field}" — removed.`);
      delete spec.transform;
      delete spec.args;
    }
  }

  // Ensure all platform fields exist in the recipe
  for (const field of Object.keys(AI_FIELDS)) {
    if (!(field in recipe.fieldMap)) {
      recipe.fieldMap[field] = null;
    }
  }

  if (typeof recipe.confidence !== 'number') {
    recipe.confidence = 0;
  }

  return { recipe, warnings };
}

module.exports = {
  KNOWN_TRANSFORMS,
  resolveValue,
  applyFieldSpec,
  coerceValue,
  applyRecipe,
  applyRecipeBatch,
  validateRecipe,
};
