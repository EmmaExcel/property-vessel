const cheerio = require('cheerio');
const {
  PROPERTY_FIELD_GROUPS,
  DOM_PRICE_REGEX,
  DOM_BEDROOM_REGEX,
  SCHEMA_ORG_PROPERTY_TYPES,
} = require('./constants');

function extractJsonLd($) {
  const results = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      let data = JSON.parse($(el).html());
      if (!Array.isArray(data)) data = [data];

      for (const item of data) {
        const flat = flattenLdGraph(item);
        for (const obj of flat) {
          if (isPropertyShaped(obj)) {
            results.push(normalizeLdRecord(obj));
          }
        }
      }
    } catch {}
  });
  return results;
}

function flattenLdGraph(item) {
  const out = [];
  if (item['@graph'] && Array.isArray(item['@graph'])) {
    for (const node of item['@graph']) out.push(...flattenLdGraph(node));
  } else {
    out.push(item);
  }
  return out;
}

function isPropertyShaped(obj) {
  const type = (obj['@type'] || '').toString();
  if (/\b(?:Organization|LocalBusiness|RealEstateAgent)\b/i.test(type)) return false;
  if (SCHEMA_ORG_PROPERTY_TYPES.some((t) => type.includes(t))) return true;

  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  let hits = 0;
  for (const group of PROPERTY_FIELD_GROUPS) {
    if (group.some((alias) => keys.includes(alias))) hits++;
  }
  return hits >= 4;
}

function normalizeLdRecord(obj) {
  const record = {};
  record.title = obj.name || obj.headline || null;
  record.description = obj.description || null;
  record.url = obj.url || null;

  if (obj.offers) {
    const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
    record.price = offer.price || offer.priceCurrency ? `${offer.priceCurrency || ''}${offer.price || ''}` : null;
  } else {
    record.price = obj.price || null;
  }

  const addr = obj.address || {};
  if (typeof addr === 'string') {
    record.address = addr;
  } else {
    record.address = [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode]
      .filter(Boolean).join(', ');
    record.city = addr.addressLocality || null;
    record.postcode = addr.postalCode || null;
    record.country = addr.addressCountry || null;
  }

  const geo = obj.geo || {};
  record.latitude = geo.latitude || obj.latitude || null;
  record.longitude = geo.longitude || obj.longitude || null;

  record.bedrooms = obj.numberOfBedrooms || obj.numberOfRooms || null;
  record.bathrooms = obj.numberOfBathroomsTotal || null;
  record.sqft = obj.floorSize?.value || obj.floorSize || null;
  record.propertyType = obj.additionalType || obj['@type'] || null;

  if (obj.image) {
    const imgs = Array.isArray(obj.image) ? obj.image : [obj.image];
    record.images = imgs.map((i) => (typeof i === 'string' ? i : i?.url || i?.contentUrl || null)).filter(Boolean);
  }

  const contactCandidates = [obj.seller, obj.broker, obj.offeredBy, obj.provider, obj.author, obj.contactPoint]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => value && typeof value === 'object');
  const names = [];
  const emails = [];
  const phones = [];
  for (const contact of contactCandidates) {
    if (contact.name) names.push(contact.name);
    if (contact.email) emails.push(contact.email);
    if (contact.telephone) phones.push(contact.telephone);
    if (contact.contactPoint) {
      const points = Array.isArray(contact.contactPoint) ? contact.contactPoint : [contact.contactPoint];
      for (const point of points) {
        if (point?.email) emails.push(point.email);
        if (point?.telephone) phones.push(point.telephone);
      }
    }
  }
  if (names.length) record.agentName = [...new Set(names)][0];
  if (emails.length) record.agentEmail = [...new Set(emails)][0];
  if (phones.length) record.agentPhone = [...new Set(phones)][0];
  if (names.length || emails.length || phones.length) {
    record.contact = {
      names: [...new Set(names)],
      emails: [...new Set(emails)],
      phones: [...new Set(phones)],
    };
  }

  record._source = 'json-ld';
  return record;
}

function extractMicrodata($) {
  const results = [];
  const typeSelectors = SCHEMA_ORG_PROPERTY_TYPES.map((t) => `[itemtype*="${t}"]`).join(', ');
  $(typeSelectors).each((_, el) => {
    const record = {};
    $(el).find('[itemprop]').each((_, prop) => {
      const name = $(prop).attr('itemprop');
      const value = $(prop).attr('content') || $(prop).text().trim();
      if (name && value) record[name] = value;
    });
    if (Object.keys(record).length >= 2) {
      record._source = 'microdata';
      results.push(record);
    }
  });
  return results;
}

function extractCards($) {
  const groups = new Map();

  $('*').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName;
    const cls = $el.attr('class') || '';
    if (!tag || !cls) return;
    if (/^(?:select|option|form|nav|header|footer)$/i.test(tag) || $el.closest('select').length) return;

    const text = $el.text();
    if (text.length > 2000 || text.length < 20) return;
    if (!DOM_PRICE_REGEX.test(text)) return;
    const priceMatches = text.match(new RegExp(DOM_PRICE_REGEX.source, 'gi')) || [];
    if (priceMatches.length > 4 && !$el.find('a[href*="property"], a[href*="listing"], a[href*="details"]').length) return;

    const key = `${tag}.${cls.split(/\s+/).sort().join('.')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push($el);
  });

  let bestKey = null;
  let bestScore = 0;

  for (const [key, elements] of groups) {
    if (elements.length < 2) continue;

    let score = elements.length;
    const sampleText = elements[0].text();
    if (DOM_BEDROOM_REGEX.test(sampleText)) score += elements.length;
    if (/\b(?:road|street|lane|drive|avenue|close|way|crescent|terrace|place|court|grove)\b/i.test(sampleText)) {
      score += elements.length;
    }

    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  if (!bestKey) return [];

  const cards = groups.get(bestKey);
  return cards.map(($card) => extractFieldsFromCard($, $card));
}

function extractPageContacts(input) {
  const $ = typeof input === 'string' ? cheerio.load(input) : input;
  const names = [];
  const emails = [];
  const phones = [];
  const add = (target, value) => {
    const cleaned = String(value || '').trim();
    if (cleaned && !target.includes(cleaned)) target.push(cleaned);
  };

  $('a[href^="mailto:"]').each((_, element) => {
    add(emails, ($(element).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].toLowerCase());
  });
  $('a[href^="tel:"]').each((_, element) => {
    add(phones, ($(element).attr('href') || '').replace(/^tel:/i, ''));
  });
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const parsed = JSON.parse($(element).html());
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const value = queue.shift();
        if (!value || typeof value !== 'object') continue;
        const type = String(value['@type'] || '');
        if (/Organization|LocalBusiness|RealEstateAgent|Person|ContactPoint/i.test(type)) {
          add(names, value.name);
          add(emails, value.email);
          add(phones, value.telephone);
        }
        if (value.contactPoint) queue.push(...(Array.isArray(value.contactPoint) ? value.contactPoint : [value.contactPoint]));
        if (value['@graph']) queue.push(...(Array.isArray(value['@graph']) ? value['@graph'] : [value['@graph']]));
      }
    } catch {
      // Invalid JSON-LD is common and should not block the listing itself.
    }
  });
  return { names, emails, phones };
}

function extractOpenGraphProperty(input) {
  const $ = typeof input === 'string' ? cheerio.load(input) : input;
  const meta = (property) => $(`meta[property="${property}"], meta[name="${property}"]`).first().attr('content')?.trim() || null;
  const title = meta('og:title') || $('title').first().text().trim() || null;
  const description = meta('og:description') || meta('description');
  const image = meta('og:image');
  const canonical = meta('og:url') || $('link[rel="canonical"]').first().attr('href') || null;
  const pageText = `${title || ''} ${description || ''}`;
  const explicitPrice = $('.priceask, .displayprice, [itemprop="price"]').first().attr('content')
    || $('.priceask, .displayprice, [itemprop="price"]').first().text().trim()
    || $('input#priceMort, input[name="price"]').first().attr('value');
  const price = explicitPrice || title?.match(DOM_PRICE_REGEX)?.[0] || null;
  const bedrooms = pageText.match(DOM_BEDROOM_REGEX)?.[1] || null;
  if (!title || (!price && !bedrooms) || !/property|for sale|to rent|bedroom|house|flat|apartment|bungalow/i.test(pageText)) return null;
  const typeMatch = pageText.match(/\b(flat|apartment|house|bungalow|maisonette|studio|cottage|townhouse|terraced|semi-detached|detached)\b/i);
  const images = [];
  if (image) images.push(image);
  $('.propertyimagelist img, .propertyimagecontainer img, .detail-gallery img, [data-gallery] img').each((_, element) => {
    const src = $(element).attr('src') || $(element).attr('data-src');
    if (src && !images.includes(src)) images.push(src);
  });
  return {
    title,
    description,
    price,
    bedrooms,
    propertyType: typeMatch?.[1] || null,
    url: canonical,
    images,
    _source: 'open-graph',
  };
}

function extractFieldsFromCard($, $card) {
  const record = {};
  const visibleText = (element) => {
    const clone = element.clone();
    clone.find('style, script, svg').remove();
    return clone.text().replace(/\s+/g, ' ').trim();
  };
  const isNoise = (value) => /(?:\.st\d+\s*\{|fill\s*:|<svg|@keyframes|font-family\s*:)/i.test(String(value || ''));
  const titleFromUrl = (value) => {
    try {
      const slug = new URL(value, 'https://source.invalid').pathname.split('/').filter(Boolean).pop() || '';
      const withoutId = slug.replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ').trim();
      if (!withoutId || /^(?:property|details|for-sale|to-rent)$/i.test(withoutId)) return null;
      return withoutId.replace(/\b\w/g, (character) => character.toUpperCase());
    } catch {
      return null;
    }
  };
  const fullText = visibleText($card);

  const priceMatch = fullText.match(DOM_PRICE_REGEX);
  if (priceMatch) record.price = priceMatch[0].trim();

  const bedMatch = fullText.match(DOM_BEDROOM_REGEX);
  if (bedMatch) record.bedrooms = bedMatch[1];

  const bathMatch = fullText.match(/(\d+)\s*(?:bath(?:room)?s?)\b/i);
  if (bathMatch) record.bathrooms = bathMatch[1];

  const link = $card.find('a[href*="property"], a[href*="listing"], a[href*="details"]').first().length
    ? $card.find('a[href*="property"], a[href*="listing"], a[href*="details"]').first()
    : $card.find('a[href]').first();
  if (link.length) {
    record.url = link.attr('href');
  }

  const titleElement = $card.find('.eapow-overview-title a, .property-address, [itemprop="name"], h1, h2, h3, h4').filter((_, element) => {
    const text = visibleText($(element));
    return text.length > 3 && text.length < 200 && !isNoise(text);
  }).first();
  const explicitTitle = titleElement.length ? visibleText(titleElement) : null;
  const linkText = link.length ? visibleText(link) : null;
  const imageAlt = $card.find('img[alt]').map((_, element) => $(element).attr('alt')).get()
    .find((value) => /\bproperty\s+in\b/i.test(value || ''));
  const altTitle = imageAlt?.replace(/^\s*\d+\s+bed(?:room)?\s+property\s+in\s+/i, '').trim();
  const candidateTitle = [explicitTitle, linkText, altTitle, titleFromUrl(record.url)]
    .find((value) => value && value.length > 3 && value.length < 200 && !isNoise(value));
  if (candidateTitle) {
    record.title = candidateTitle;
  }

  const img = $card.find('img').first();
  if (img.length) {
    record.images = [img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src')].filter(Boolean);
  }

  const allImgs = [];
  $card.find('img').each((_, imgEl) => {
    const src = $(imgEl).attr('src') || $(imgEl).attr('data-src') || $(imgEl).attr('data-lazy-src');
    if (src) allImgs.push(src);
  });
  if (allImgs.length > 0) record.images = allImgs;

  const emails = [];
  const phones = [];
  $card.find('a[href^="mailto:"]').each((_, element) => {
    const value = ($(element).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (value) emails.push(value);
  });
  $card.find('a[href^="tel:"]').each((_, element) => {
    const value = ($(element).attr('href') || '').replace(/^tel:/i, '').trim();
    if (value) phones.push(value);
  });
  if (emails.length) record.agentEmail = [...new Set(emails)][0];
  if (phones.length) record.agentPhone = [...new Set(phones)][0];
  if (emails.length || phones.length) {
    record.contact = { names: [], emails: [...new Set(emails)], phones: [...new Set(phones)] };
  }

  const addressPatterns = /(?<![\d,])\b\d{1,4}\s+[\w\s]+(?:road|street|lane|drive|avenue|close|way|crescent|terrace|place|court|grove)\b/i;
  const addressMatch = fullText.match(addressPatterns);
  if (explicitTitle && /\b(?:road|street|lane|drive|avenue|close|way|crescent|terrace|place|court|grove|view|gardens?|meadows?|rise|oval|common)\b|,/i.test(explicitTitle)) {
    record.address = explicitTitle;
  } else if (addressMatch) record.address = addressMatch[0].trim();

  const postcodeMatch = fullText.match(/[A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}/i);
  if (postcodeMatch) record.postcode = postcodeMatch[0].trim();

  if (!record.address && !record.title) {
    const lines = fullText.split('\n').map((l) => l.trim()).filter((l) => l.length > 5 && l.length < 150);
    if (lines.length > 0) record.title = lines[0];
  }

  record._source = 'card-detection';
  return record;
}

module.exports = {
  extractJsonLd,
  extractMicrodata,
  extractCards,
  extractPageContacts,
  extractOpenGraphProperty,
};
