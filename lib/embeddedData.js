const cheerio = require('cheerio');
const { recordsFromJson } = require('./utils');

const STATE_MARKERS = [
  'var propertyData =',
  'let propertyData =',
  'const propertyData =',
  'window.propertyData =',
  'window.__INITIAL_STATE__ =',
  'window.__PRELOADED_STATE__ =',
  'window.__NEXT_DATA__ =',
  'window.__NUXT__ =',
  'window.__APOLLO_STATE__ =',
];

function extractBalancedJson(text, fromIndex) {
  const objectStart = text.slice(fromIndex).search(/[\[{]/);
  if (objectStart === -1) return null;

  const start = fromIndex + objectStart;
  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === opener) {
      depth += 1;
    } else if (char === closer && --depth === 0) {
      return text.slice(start, index + 1);
    }
  }

  return null;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractEmbeddedJsonCandidates(html) {
  const candidates = [];
  const seen = new Set();

  function add(json, source) {
    if (!json || typeof json !== 'object') return;
    const shape = recordsFromJson(json);
    if (!shape.records.length || shape.score < 3) return;

    const first = shape.records[0] || {};
    const signature = `${source}|${shape.arrayPath}|${shape.records.length}|${first.id ?? first.property_id ?? first.url ?? ''}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push({ json, source, ...shape });
  }

  const $ = cheerio.load(html);
  $('script').each((_, element) => {
    const script = $(element).html() || '';
    if (!script || script.length > 12_000_000) return;

    const type = ($(element).attr('type') || '').toLowerCase();
    if (type.includes('json')) add(parseJson(script.trim()), `script[type=${type || 'json'}]`);

    for (const marker of STATE_MARKERS) {
      let offset = 0;
      while ((offset = script.indexOf(marker, offset)) !== -1) {
        const raw = extractBalancedJson(script, offset + marker.length);
        add(parseJson(raw), `inline:${marker.replace(/\s*=\s*$/, '').trim()}`);
        offset += marker.length;
      }
    }

    const variablePattern = /(?:var|let|const)\s+([A-Za-z_$][\w$]*(?:Data|data|State|state|Listings|listings|Properties|properties))\s*=\s*/g;
    for (const match of script.matchAll(variablePattern)) {
      const raw = extractBalancedJson(script, match.index + match[0].length);
      add(parseJson(raw), `inline:${match[1]}`);
    }
  });

  // Several legacy estate-agent platforms serialize their complete result set
  // into a hidden form field for DataTables/client-side rendering.
  $('input[type="hidden"][value], textarea').each((_, element) => {
    const raw = $(element).attr('value') || $(element).text() || '';
    const trimmed = raw.trim();
    if ((!trimmed.startsWith('[') && !trimmed.startsWith('{')) || trimmed.length > 12_000_000) return;
    const name = $(element).attr('name') || $(element).attr('id') || element.tagName;
    add(parseJson(trimmed), `form-field:${name}`);
  });

  return candidates.sort((a, b) => (
    b.score - a.score
    || b.records.length - a.records.length
    || a.arrayPath.length - b.arrayPath.length
  ));
}

function findBestEmbeddedPropertyData(html) {
  return extractEmbeddedJsonCandidates(html)[0] || null;
}

module.exports = {
  extractBalancedJson,
  extractEmbeddedJsonCandidates,
  findBestEmbeddedPropertyData,
};
