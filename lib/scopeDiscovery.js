const cheerio = require('cheerio');

const MAX_SITEMAP_BYTES = 8_000_000;

function sameOrigin(url, baseUrl) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function toUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function isLikelyDetailUrl(url) {
  const path = url.pathname.toLowerCase().replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);
  const propertyIndex = segments.findIndex((segment) => segment === 'property' || segment === 'properties');
  if (propertyIndex >= 0) {
    const next = segments[propertyIndex + 1];
    const searchChannels = new Set(['for-sale', 'to-rent', 'sales', 'lettings', 'search', 'list', 'map']);
    // `/property/for-sale/in-york/` is a search scope, while an additional
    // segment is normally the property's slug or ID.
    if (searchChannels.has(next)) return segments.length > propertyIndex + 3;
    return Boolean(next);
  }
  return /\/(?:property-details|details)\//.test(path);
}

function isLikelyScopeUrl(url) {
  if (isLikelyDetailUrl(url)) return false;

  const path = url.pathname.toLowerCase();
  const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
  return /\/(?:properties?|search|for-sale|to-rent|sales|lettings)(?:\/|$)/.test(path)
    || keys.some((key) => /(?:address|location|area|place|postcode|instruction|search|branch|bid)/.test(key));
}

function uniqueUrls(urls, max) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    const value = typeof url === 'string' ? url : url.toString();
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function decodeXml(value) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function parseSitemapLocs(xml) {
  const locs = [];
  for (const match of xml.matchAll(/<loc\b[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/loc>|<loc\b[^>]*>\s*([^<]+?)\s*<\/loc>/gi)) {
    const value = match[1] || match[2];
    if (value) locs.push(decodeXml(value));
  }
  return locs;
}

function sitemapCandidatesFromRobots(text, baseUrl) {
  const candidates = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(\S+)\s*$/i);
    if (match) {
      const url = toUrl(match[1], baseUrl);
      if (url) candidates.push(url.toString());
    }
  }
  return candidates;
}

async function fetchText(session, url) {
  const response = await session.fetch(url);
  if (!response.ok) return null;
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_SITEMAP_BYTES) return null;
  const text = await response.text();
  return text.length <= MAX_SITEMAP_BYTES ? text : null;
}

async function collectSitemapUrls({ session, baseUrl, maxSitemaps = 20, maxUrls = 10_000 }) {
  const root = new URL(baseUrl);
  const queue = [];
  const robotsUrl = new URL('/robots.txt', root).toString();
  const robots = await fetchText(session, robotsUrl).catch(() => null);
  if (robots) queue.push(...sitemapCandidatesFromRobots(robots, root));
  queue.push(new URL('/sitemap.xml', root).toString());

  const seenSitemaps = new Set();
  const urls = [];
  while (queue.length && seenSitemaps.size < maxSitemaps && urls.length < maxUrls) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl) || !sameOrigin(sitemapUrl, root)) continue;
    seenSitemaps.add(sitemapUrl);

    const xml = await fetchText(session, sitemapUrl).catch(() => null);
    if (!xml || !/<(?:urlset|sitemapindex)\b/i.test(xml)) continue;

    const isIndex = /<sitemapindex\b/i.test(xml);
    for (const location of parseSitemapLocs(xml)) {
      const discovered = toUrl(location, root);
      if (!discovered || !sameOrigin(discovered, root)) continue;
      if (isIndex || /(?:sitemap|_sitemap)\.xml(?:\.gz)?$/i.test(discovered.pathname)) {
        queue.push(discovered.toString());
      } else {
        urls.push(discovered.toString());
        if (urls.length >= maxUrls) break;
      }
    }
  }

  return uniqueUrls(urls, maxUrls);
}

function discoverScopesFromHtml(html, baseUrl, maxScopes = 50) {
  const $ = cheerio.load(html);
  const discovered = [];
  const locations = [];

  $('a[href]').each((_, element) => {
    const url = toUrl($(element).attr('href'), baseUrl);
    if (!url || !sameOrigin(url, baseUrl) || !isLikelyScopeUrl(url)) return;
    discovered.push(url.toString());
  });

  // Location selects are useful evidence for operators, but guessing URL formats
  // from an option value can create invalid search routes, so we never crawl them.
  $('select').each((_, element) => {
    const name = ($(element).attr('name') || '').toLowerCase();
    if (!/(?:location|area|place|address|town|postcode|branch)/.test(name)) return;
    $(element).find('option').each((__, option) => {
      const value = ($(option).attr('value') || '').trim();
      const label = $(option).text().trim();
      if (value || label) locations.push({ name, value, label });
    });
  });

  return {
    scopes: uniqueUrls(discovered, maxScopes),
    locationOptions: locations.slice(0, 200),
  };
}

async function discoverScopes({ session, url, html, maxScopes = 50, maxDetailUrls = 500, includeSitemap = true }) {
  const canonicalUrl = toUrl(url, url)?.toString() || url;
  const pageDiscovery = discoverScopesFromHtml(html || '', url, maxScopes);
  const sitemapUrls = includeSitemap
    ? await collectSitemapUrls({ session, baseUrl: url }).catch(() => [])
    : [];
  const sitemapScopes = sitemapUrls.filter((item) => isLikelyScopeUrl(new URL(item)));
  const detailUrls = sitemapUrls.filter((item) => isLikelyDetailUrl(new URL(item)));

  return {
    scopes: uniqueUrls([canonicalUrl, ...pageDiscovery.scopes, ...sitemapScopes], maxScopes),
    detailUrls: uniqueUrls(detailUrls, maxDetailUrls),
    locationOptions: pageDiscovery.locationOptions,
    sitemap: {
      scanned: includeSitemap,
      urlsFound: sitemapUrls.length,
      scopeUrlsFound: sitemapScopes.length,
      detailUrlsFound: detailUrls.length,
    },
  };
}

module.exports = {
  isLikelyDetailUrl,
  isLikelyScopeUrl,
  parseSitemapLocs,
  discoverScopesFromHtml,
  collectSitemapUrls,
  discoverScopes,
};
