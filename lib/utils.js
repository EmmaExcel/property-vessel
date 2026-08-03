const { PROPERTY_FIELD_GROUPS, FIELD_ALIASES } = require('./constants');

function scoreJsonForPropertyData(json, allowSingleObject = false) {
  let best = { score: 0, sample: null, arrayPath: null };

  function lowerKeys(obj) {
    return Object.keys(obj).map((k) => k.toLowerCase());
  }

  function scoreRecord(record) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return 0;
    const keys = lowerKeys(record);
    let hits = 0;
    for (const group of PROPERTY_FIELD_GROUPS) {
      if (group.some((alias) => keys.includes(alias))) hits += 1;
    }
    return hits;
  }

  function walk(node, pathStr) {
    if (Array.isArray(node) && node.length > 0) {
      const sample = node.find((item) => typeof item === 'object' && item !== null) || node[0];
      const score = scoreRecord(sample);
      if (score > best.score) {
        best = { score, sample, arrayPath: pathStr || '(root array)' };
      }

      if (sample && typeof sample === 'object') walk(sample, `${pathStr}[0]`);
    } else if (typeof node === 'object' && node !== null) {
      if (allowSingleObject) {
        const score = scoreRecord(node);
        if (score > best.score) {
          best = { score, sample: node, arrayPath: pathStr || '(root object)' };
        }
      }
      for (const [key, value] of Object.entries(node)) {
        walk(value, pathStr ? `${pathStr}.${key}` : key);
      }
    }
  }

  walk(json, '');
  return best;
}

function getRecordsAtPath(json, pathStr) {
  if (!pathStr || pathStr === '(root array)') return Array.isArray(json) ? json : [];
  if (pathStr === '(root object)') return [json];

  const tokens = pathStr.match(/[^.\[\]]+/g) || [];
  let current = json;
  for (const token of tokens) {
    if (current === undefined || current === null) return [];
    current = current[token];
  }
  if (Array.isArray(current)) return current;
  if (typeof current === 'object' && current !== null) return [current];
  return [];
}

function recordsFromJson(json, allowSingleObject = false) {
  const shape = scoreJsonForPropertyData(json, allowSingleObject);
  return { ...shape, records: getRecordsAtPath(json, shape.arrayPath) };
}

function recordKey(record) {
  if (!record || typeof record !== 'object') return String(record);
  const explicit = record.property_id
      ?? record.propertyId
      ?? record.listing_id
      ?? record.listingId
      ?? record.id
      ?? record.uuid
      ?? record.url
      ?? record.sourceUrl
      ?? record.permalink;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    const value = String(explicit).trim();
    try {
      const url = new URL(value);
      url.hash = '';
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((key) => url.searchParams.delete(key));
      return url.toString().replace(/\/$/, '');
    } catch {
      return value;
    }
  }
  const address = record.addressWithCommas ?? record.address ?? record.displayAddress ?? record.title ?? '';
  const price = record.priceValue ?? record.price ?? '';
  if (String(address).trim() || String(price).trim()) return `${String(address).trim().toLowerCase()}|${String(price).trim()}`;
  return JSON.stringify(record);
}

function isEmptyValue(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function uniqueValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeRecordValues(existing, incoming, key = '') {
  if (isEmptyValue(existing)) return incoming;
  if (isEmptyValue(incoming)) return existing;
  if (Array.isArray(existing) || Array.isArray(incoming)) {
    return uniqueValues([...(Array.isArray(existing) ? existing : [existing]), ...(Array.isArray(incoming) ? incoming : [incoming])]);
  }
  if (typeof existing === 'object' && typeof incoming === 'object') {
    const merged = { ...existing };
    for (const [nestedKey, value] of Object.entries(incoming)) {
      merged[nestedKey] = mergeRecordValues(merged[nestedKey], value, nestedKey);
    }
    return merged;
  }
  if (/title|name|headline/i.test(key)
      && typeof existing === 'string' && /^(?:load|show|view)\s+(?:previous|next|more|items|results)/i.test(existing)
      && typeof incoming === 'string') return incoming;
  if (/description|details|summary|features/i.test(key)
      && typeof existing === 'string' && typeof incoming === 'string'
      && incoming.length > existing.length) return incoming;
  return existing;
}

function dedupeRecords(records) {
  const seen = new Map();
  for (const record of records) {
    const key = recordKey(record);
    if (!seen.has(key)) {
      seen.set(key, record);
      continue;
    }
    seen.set(key, mergeRecordValues(seen.get(key), record));
  }
  return [...seen.values()];
}

function toAbsoluteUrl(value, sourceUrl) {
  if (typeof value !== 'string' || !value) return value;
  try {
    if (value.startsWith('//')) return new URL(sourceUrl).protocol + value;
    return new URL(value, sourceUrl).toString();
  } catch {
    return value;
  }
}

function normalizedFieldName(value) {
  return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function findAliasValue(raw, aliases) {
  const wanted = new Set(aliases.map(normalizedFieldName));
  let found;
  function visit(value, depth = 0) {
    if (found !== undefined || !value || typeof value !== 'object' || depth > 5) return;
    for (const [key, nested] of Object.entries(value)) {
      if (wanted.has(normalizedFieldName(key)) && !isEmptyValue(nested)) {
        found = nested;
        return;
      }
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  }
  visit(raw);
  return found;
}

function findDirectAliasValue(raw, aliases) {
  const wanted = new Set(aliases.map(normalizedFieldName));
  for (const [key, value] of Object.entries(raw || {})) {
    if (wanted.has(normalizedFieldName(key)) && !isEmptyValue(value)) return value;
  }
  return undefined;
}

function collectMediaUrls(value, output = [], depth = 0) {
  if (value === null || value === undefined || depth > 7) return output;
  if (typeof value === 'string') {
    if (value.trim()) output.push(value.trim());
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectMediaUrls(item, output, depth + 1));
    return output;
  }
  if (typeof value === 'object') {
    const direct = value.url || value.src || value.href || value.contentUrl;
    if (typeof direct === 'string') output.push(direct);
    else Object.values(value).forEach((item) => collectMediaUrls(item, output, depth + 1));
  }
  return output;
}

function cleanEmail(value) {
  const match = String(value || '').replace(/^mailto:/i, '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function cleanPhone(value) {
  const text = String(value || '').replace(/^tel:/i, '').trim();
  const match = text.match(/(?:\+\s?\d{1,3}[\s().-]*)?(?:\d[\s().-]*){7,15}/);
  if (!match) return null;
  const candidate = match[0].trim().replace(/\s+/g, ' ');
  const digits = candidate.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? candidate : null;
}

function extractPublicContacts(raw) {
  const names = [];
  const emails = [];
  const phones = [];
  const visited = new Set();
  function add(target, value, cleaner = (item) => String(item).trim()) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item && typeof item === 'object') continue;
      const cleaned = cleaner(item);
      if (cleaned && !target.includes(cleaned)) target.push(cleaned);
    }
  }
  function visit(value, path = '', depth = 0) {
    if (value === null || value === undefined || depth > 8) return;
    if (typeof value === 'object') {
      if (visited.has(value)) return;
      visited.add(value);
      for (const [key, nested] of Object.entries(value)) visit(nested, `${path}.${normalizedFieldName(key)}`, depth + 1);
      return;
    }
    const key = path.split('.').pop() || '';
    const text = String(value);
    const contactContext = /agent|agency|branch|office|broker|negotiator|contact|seller|vendor|listedby|provider/.test(path);
    const nameKey = /name$|^(?:agent|agency|branch|office|broker|negotiator|listedby|provider)$/.test(key);
    if (contactContext && nameKey && !/(?:id|code|ref)$/.test(key) && /[a-z]/i.test(text) && !/@/.test(text)) add(names, text);
    if (/email/.test(key) || /mailto:|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) add(emails, text, cleanEmail);
    if (/phone|telephone|mobile|tel|voxnumber/.test(key) || /tel:/i.test(text)
        || (contactContext && !/(?:id|code|ref)$/.test(key) && /\+?\d[\d\s().-]{6,}/.test(text))) add(phones, text, cleanPhone);
  }
  visit(raw);
  return { names, emails, phones };
}

function normalizeProperty(raw, sourceUrl) {
  const out = { raw, sourceSiteUrl: sourceUrl };
  const resolutionBaseUrl = raw._documentBaseUrl || sourceUrl;
  for (const [normalizedKey, aliases] of Object.entries(FIELD_ALIASES)) {
    const value = normalizedKey === 'sourceUrl'
      ? findDirectAliasValue(raw, aliases)
      : findAliasValue(raw, aliases);
    if (value !== undefined) out[normalizedKey] = value;
  }

  const contact = extractPublicContacts(raw);
  if (contact.names.length || contact.emails.length || contact.phones.length) out.contact = contact;
  if (!out.agentName && contact.names.length) out.agentName = contact.names[0];
  if (!out.agentEmail && contact.emails.length) out.agentEmail = contact.emails[0];
  if (!out.agentPhone && contact.phones.length) out.agentPhone = contact.phones[0];
  if (!out.agentContact) out.agentContact = out.agentEmail || out.agentPhone;

  if (out.images !== undefined && out.images !== null) {
    out.images = collectMediaUrls(out.images)
      .map((img) => toAbsoluteUrl(img, resolutionBaseUrl))
      .filter((value, index, all) => value && all.indexOf(value) === index);
  }

  if (!out.sourceUrl && raw.slug && (raw.objectID || raw.strapi_id)) {
    const routeType = /rent|lett/i.test(String(raw.search_type || raw.department || '')) ? 'to-rent' : 'for-sale';
    out.sourceUrl = `/${`property-${routeType}`}/${raw.slug}/${raw.objectID || raw.strapi_id}`;
  }
  if (out.sourceUrl) out.sourceUrl = toAbsoluteUrl(out.sourceUrl, resolutionBaseUrl);

  return out;
}


function detectPagination(urlStr) {
  const url = new URL(urlStr);
  const pageStyleKeys = ['page', 'pageno', 'page_number', '_page'];
  const offsetStyleKeys = ['offset', '_offset', 'skip', '_skip', 'start', '_start'];
  const limitKeys = ['_limit', 'limit', 'pagesize', 'page_size', 'per_page', 'perpage'];

  let limit = null;
  for (const key of limitKeys) {
    if (url.searchParams.has(key)) {
      limit = Number(url.searchParams.get(key));
      break;
    }
  }

  for (const key of pageStyleKeys) {
    if (url.searchParams.has(key)) return { param: key, style: 'page', step: 1 };
  }
  for (const key of offsetStyleKeys) {
    if (url.searchParams.has(key)) return { param: key, style: 'offset', step: limit || 1 };
  }

  // Infer the likely offset param from the limit key if no explicit offset is present.
  for (const key of limitKeys) {
    if (url.searchParams.has(key)) {
      const inferredParam = key.startsWith('_') ? '_start' : 'offset';
      return { param: inferredParam, style: 'offset', step: limit || 1, inferred: true };
    }
  }

  return null;
}

function defaultOutFileName(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname.replace(/^www\./, '');
    const slug = hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return `data/${slug}-listings.json`;
  } catch {
    return 'data/listings.json';
  }
}

function normalizeFromDom(record, sourceUrl) {
  const out = { raw: record, sourceSiteUrl: sourceUrl };

  out.title = record.title || record.name || record.headline || null;
  out.description = record.description || record.summary || null;
  out.price = record.price || null;
  out.bedrooms = record.bedrooms || record.numberOfBedrooms || null;
  out.bathrooms = record.bathrooms || record.numberOfBathroomsTotal || null;
  out.sqft = record.sqft || record.floorSize || null;
  out.propertyType = record.propertyType || record.additionalType || null;
  out.address = record.address || null;
  out.city = record.city || record.addressLocality || null;
  out.postcode = record.postcode || record.postalCode || null;
  out.country = record.country || null;
  out.latitude = record.latitude || null;
  out.longitude = record.longitude || null;
  out.sourceUrl = toAbsoluteUrl(record.url || null, sourceUrl);
  out.agentName = record.agentName || null;
  const contact = extractPublicContacts(record);
  if (contact.names.length || contact.emails.length || contact.phones.length) out.contact = contact;
  out.agentName = out.agentName || contact.names[0] || null;
  out.agentEmail = record.agentEmail || contact.emails[0] || null;
  out.agentPhone = record.agentPhone || contact.phones[0] || null;
  out.agentContact = record.agentContact || out.agentEmail || out.agentPhone || null;

  if (Array.isArray(record.images)) {
    out.images = record.images.map((image) => toAbsoluteUrl(image, sourceUrl)).filter(Boolean);
  }

  return out;
}

module.exports = {
  scoreJsonForPropertyData,
  getRecordsAtPath,
  recordsFromJson,
  recordKey,
  dedupeRecords,
  mergeRecordValues,
  extractPublicContacts,
  toAbsoluteUrl,
  normalizeProperty,
  normalizeFromDom,
  detectPagination,
  defaultOutFileName
};
