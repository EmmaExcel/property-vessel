const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { launchBrowser } = require('../lib/browser');
const { HttpSession, delay, fetchWithRetries } = require('../lib/httpClient');
const { findBestEmbeddedPropertyData } = require('../lib/embeddedData');
const { isHomeflowPayload, paginateHomeflow } = require('../lib/homeflow');
const { discoverScopes } = require('../lib/scopeDiscovery');
const { buildRunReport, writeRunReport } = require('../lib/runReport');
const {
  DEFAULT_MODEL,
  normalizeListingsWithAi,
  platformOnly: toPlatformOnly,
} = require('../lib/platformNormalizer');
const { applyRecipeBatch } = require('../lib/mappingEngine');
const { loadOrGenerateRecipe } = require('../lib/mappingGenerator');
const {
  dedupeRecords,
  normalizeFromDom,
  normalizeProperty,
  recordsFromJson,
  defaultOutFileName,
  toAbsoluteUrl,
  mergeRecordValues,
} = require('../lib/utils');
const {
  extractJsonLd,
  extractMicrodata,
  extractCards,
  extractPageContacts,
  extractOpenGraphProperty,
} = require('../lib/htmlExtractor');
const { NEXT_PAGE_SELECTORS, LOAD_MORE_SELECTORS } = require('../lib/constants');

const MIN_PROPERTY_SCORE = 4;

function asPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sameOrigin(url, baseUrl) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function scopeKey(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function writeNormalizedListings(records, outFile, skipWrite, { dedupe = true } = {}) {
  const normalized = dedupe ? dedupeRecords(records) : records;
  if (!skipWrite) {
    const resolvedOutFile = outFile || 'data/listings.json';
    const absolutePath = path.resolve(resolvedOutFile);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify(normalized, null, 2));
    console.log(`\nWrote ${normalized.length} normalized listing(s) to ${resolvedOutFile}`);
  } else {
    console.log(`\nReturning ${normalized.length} normalized listing(s) in memory (skipWrite enabled)`);
  }
  return normalized;
}

function writeListings(records, sourceUrl, outFile, normalizer = normalizeProperty) {
  return writeNormalizedListings(records.map((record) => normalizer(record, sourceUrl)), outFile || defaultOutFileName(sourceUrl));
}

function findNextPageUrl(html, baseUrl) {
  const $ = cheerio.load(html);
  const selectors = [...NEXT_PAGE_SELECTORS, 'a[rel="next"]', '.pagination a[href*="page"]'];

  for (const selector of selectors) {
    const href = $(selector).first().attr('href');
    if (href) return new URL(href, baseUrl).toString();
  }

  const nextLink = $('a[href]').filter((_, element) => /^(next|next page|older)$/i.test($(element).text().trim())).first();
  const href = nextLink.attr('href');
  return href ? new URL(href, baseUrl).toString() : null;
}

async function paginateEmbeddedHtml({ session, initialHtml, listingUrl, initialCandidate, maxPages }) {
  let currentHtml = initialHtml;
  let currentUrl = listingUrl;
  let records = [...initialCandidate.records];
  let pagesFetched = 1;

  while (pagesFetched < maxPages) {
    const nextUrl = findNextPageUrl(currentHtml, currentUrl);
    if (!nextUrl) break;

    const response = await fetchWithRetries(session, nextUrl, { headers: { referer: currentUrl } });
    if (!response.ok) break;
    currentHtml = await response.text();
    currentUrl = response.url || nextUrl;

    const candidate = findBestEmbeddedPropertyData(currentHtml);
    if (!candidate || candidate.score < MIN_PROPERTY_SCORE) break;

    const before = records.length;
    records = dedupeRecords([...records, ...candidate.records]);
    if (records.length === before) break;

    pagesFetched += 1;
    console.log(`  page ${pagesFetched}: +${records.length - before} records (total ${records.length})`);
    await delay(120);
  }

  return { records, pagesFetched, complete: pagesFetched < maxPages };
}

async function captureJsonResponse(response) {
  const request = response.request();
  if (!['xhr', 'fetch'].includes(request.resourceType()) || response.status() >= 400) return null;

  const length = Number(response.headers()['content-length'] || 0);
  if (length > 12_000_000) return null;

  const body = await response.text().catch(() => null);
  if (!body) return null;

  let json;
  try {
    json = JSON.parse(body.replace(/^\)]}',?\s*/, ''));
  } catch {
    return null;
  }

  const shape = recordsFromJson(json, true);
  if (shape.score < MIN_PROPERTY_SCORE || !shape.records.length) return null;
  return { url: request.url(), json, ...shape };
}

async function isVisibleAndEnabled(element) {
  return element.evaluate((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && !node.hasAttribute('disabled')
      && node.getBoundingClientRect().width > 0
      && node.getBoundingClientRect().height > 0;
  });
}

async function clickLoadMore(page) {
  for (const selector of [...LOAD_MORE_SELECTORS, ...NEXT_PAGE_SELECTORS]) {
    const candidates = await page.$$(selector);
    for (const element of candidates) {
      try {
        if (!await isVisibleAndEnabled(element)) continue;
        await element.evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await element.click();
        return selector;
      } catch {
        // A stale element is normal on apps that rerender immediately after a click.
      }
    }
  }
  return null;
}

async function scrollForMore(page) {
  const before = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    y: window.scrollY,
  }));
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await delay(1_000);
  const after = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    y: window.scrollY,
  }));
  return after.height > before.height || after.y > before.y;
}

async function waitForNewCapture(captures, apiBatches, capturedCount, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await Promise.allSettled([...captures]);
    if (apiBatches.length > capturedCount) return true;
    await delay(250);
  }
  return false;
}

async function scrapeWithBrowser({ url, maxPages }) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(30_000);

  const apiBatches = [];
  const captures = new Set();
  page.on('response', (response) => {
    const capture = captureJsonResponse(response)
      .then((candidate) => { if (candidate) apiBatches.push(candidate); })
      .catch(() => {})
      .finally(() => captures.delete(capture));
    captures.add(capture);
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await delay(1_500);
    await waitForNewCapture(captures, apiBatches, -1, 2_500);

    const initialCandidate = findBestEmbeddedPropertyData(await page.content());
    let apiRecords = initialCandidate?.score >= MIN_PROPERTY_SCORE ? [...initialCandidate.records] : [];
    let processedBatches = 0;
    const mergeCapturedRecords = () => {
      processedBatches = apiBatches.length;
      const candidates = [
        ...(initialCandidate?.score >= MIN_PROPERTY_SCORE ? [initialCandidate] : []),
        ...apiBatches,
      ];
      const groups = new Map();
      for (const candidate of candidates) {
        const signature = Object.keys(candidate.sample || candidate.records[0] || {}).sort().join('|');
        const group = groups.get(signature) || { score: candidate.score || 0, records: [] };
        group.score = Math.max(group.score, candidate.score || 0);
        group.records = dedupeRecords([...group.records, ...candidate.records]);
        groups.set(signature, group);
      }
      const best = [...groups.values()].sort((a, b) => b.score - a.score || b.records.length - a.records.length)[0];
      apiRecords = best?.records || [];
    };
    // This is deliberately before the first click: a client-rendered listing
    // page may have no embedded state and no Load More control.
    mergeCapturedRecords();

    let domRecords = extractStaticHtmlRecords(await page.content())[1];
    if (apiRecords.length) console.log(`[Browser API capture] Found ${apiRecords.length} listing(s) on first page.`);
    else if (domRecords.length) console.log(`[Browser HTML] Found ${domRecords.length} listing(s) on first page.`);

    let exhausted = false;
    for (let pageNumber = 2; pageNumber <= maxPages; pageNumber += 1) {
      const beforeApi = apiRecords.length;
      const beforeDom = dedupeRecords(domRecords).length;
      const captureCount = apiBatches.length;
      let action = null;
      try {
        const clicked = await clickLoadMore(page);
        action = clicked || (await scrollForMore(page) ? 'infinite-scroll' : null);
      } catch (error) {
        console.warn(`  browser pagination stopped (${error.message}); preserving ${apiRecords.length || domRecords.length} captured record(s).`);
        break;
      }
      if (!action) {
        exhausted = true;
        break;
      }

      console.log(`  advancing results: ${action}`);
      await waitForNewCapture(captures, apiBatches, captureCount);
      mergeCapturedRecords();
      domRecords = dedupeRecords([...domRecords, ...extractStaticHtmlRecords(await page.content())[1]]);

      const after = apiRecords.length || domRecords.length;
      const before = beforeApi || beforeDom;
      if (after <= before) {
        exhausted = true;
        break;
      }
      console.log(`  page ${pageNumber}: +${after - before} records (total ${after})`);
    }

    if (apiRecords.length) {
      return { records: apiRecords, normalizer: normalizeProperty, strategy: 'browser-api', complete: exhausted };
    }
    if (domRecords.length) {
      return { records: domRecords, normalizer: normalizeFromDom, strategy: 'browser-html', complete: exhausted };
    }
    return { records: [], normalizer: normalizeProperty, strategy: 'browser-none', complete: false };
  } finally {
    await browser.close();
  }
}

function extractStaticHtmlRecords(html) {
  const $ = cheerio.load(html);
  const sources = [
    ['JSON-LD', extractJsonLd($)],
    ['Microdata', extractMicrodata($)],
    ['Card detection', extractCards($)],
  ];
  return sources.find(([, records]) => records.length > 0) || [null, []];
}

function firstDetailRecord(html) {
  const embedded = findBestEmbeddedPropertyData(html);
  const [, staticRecords] = extractStaticHtmlRecords(html);
  const candidates = [embedded?.records?.[0], staticRecords[0], extractOpenGraphProperty(html)].filter(Boolean);
  const record = candidates.reduce((merged, candidate) => mergeRecordValues(merged, candidate), {});
  if (!Object.keys(record).length) return null;
  const pageContact = extractPageContacts(html);
  if (pageContact.names.length || pageContact.emails.length || pageContact.phones.length) {
    record._pageContact = pageContact;
  }
  return record;
}

function mergeMissingFields(record, detail) {
  for (const [key, value] of Object.entries(detail)) {
    record[key] = mergeRecordValues(record[key], value, key);
  }
}

async function enrichWithDetailPages({ records, sourceUrl, session, maxPages, onProgress }) {
  const candidates = records
    .map((record) => ({
      record,
      url: toAbsoluteUrl(
        record.url || record.href || record.permalink || record.link || record.property_url || record.detailUrl || record.detail_url
          || (record.slug && (record.objectID || record.strapi_id || record.crm_id || record.crmId)
            ? `/property-${/rent|lett/i.test(String(record.search_type || record.department || '')) ? 'to-rent' : 'for-sale'}/${record.slug}/${record.objectID || record.strapi_id || record.crm_id || record.crmId}`
            : null),
        record._documentBaseUrl || sourceUrl,
      ),
      needScore: (record.images?.length || record.photos?.length || record.propertyIndexPhotos?.length || record.photo ? 0 : 5)
        + (record.description || record.long_description || record.shortDescription ? 0 : 3)
        + (record.agentPhone || record.phone || record.telephone ? 0 : 1),
    }))
    .filter(({ url }) => url && sameOrigin(url, sourceUrl))
    .sort((a, b) => b.needScore - a.needScore)
    .slice(0, maxPages);
  let enriched = 0;
  let completed = 0;

  // A small worker pool limits pressure on agent sites while still avoiding a
  // painfully slow one-request-at-a-time crawl.
  let next = 0;
  async function worker() {
    while (next < candidates.length) {
      const current = candidates[next];
      next += 1;
      try {
        const response = await fetchWithRetries(session, current.url, { headers: { referer: sourceUrl } });
        if (!response.ok) continue;
        const detail = firstDetailRecord(await response.text());
        if (!detail) continue;
        mergeMissingFields(current.record, detail);
        enriched += 1;
      } catch {
        // Detail enrichment is supplemental. The search-card record remains valid.
      }
      completed += 1;
      if (onProgress) onProgress({ completed, total: candidates.length });
      await delay(120);
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
  return { attempted: candidates.length, enriched };
}

async function crawlSitemapDetailPages({ urls, sourceUrl, session, maxPages }) {
  const candidates = urls.slice(0, maxPages);
  const records = [];
  let next = 0;
  async function worker() {
    while (next < candidates.length) {
      const detailUrl = candidates[next];
      next += 1;
      try {
        const response = await fetchWithRetries(session, detailUrl, { headers: { referer: sourceUrl } });
        if (!response.ok) continue;
        const detail = firstDetailRecord(await response.text());
        if (!detail) continue;
        if (!detail.url && !detail.permalink && !detail.link) detail.url = detailUrl;
        records.push(detail);
      } catch {
        // A stale sitemap URL should not invalidate the rest of the crawl.
      }
      await delay(120);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
  return { records: dedupeRecords(records), attempted: candidates.length };
}

async function scrapeScope({ url, pageLimit, session }) {
  let initialHtml = null;
  try {
    const response = await fetchWithRetries(session, url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    initialHtml = await response.text();

    const candidate = findBestEmbeddedPropertyData(initialHtml);
    if (candidate && candidate.score >= MIN_PROPERTY_SCORE) {
      const $initial = cheerio.load(initialHtml);
      const baseHref = $initial('base[href]').first().attr('href');
      if (baseHref) {
        const documentBaseUrl = toAbsoluteUrl(baseHref, url);
        candidate.records.forEach((record) => {
          if (record && typeof record === 'object' && !record._documentBaseUrl) record._documentBaseUrl = documentBaseUrl;
        });
      }
      console.log(`[Embedded state] Found ${candidate.records.length} listing(s) at ${candidate.arrayPath} (score ${candidate.score}).`);

      let result;
      if (isHomeflowPayload(candidate)) {
        const total = candidate.json.pagination.total_count;
        console.log(`Detected Homeflow pagination (${total.toLocaleString()} total listings).`);
        result = await paginateHomeflow({
          session,
          listingUrl: url,
          initialCandidate: candidate,
          maxPages: pageLimit,
          onPage: ({ page, added, total: currentTotal }) => {
            console.log(`  page ${page}: +${added} records (total ${currentTotal})`);
          },
        });
      } else {
        result = await paginateEmbeddedHtml({
          session,
          initialHtml,
          listingUrl: url,
          initialCandidate: candidate,
          maxPages: pageLimit,
        });
      }

      if (!result.complete) {
        console.warn(`Stopped at --max-pages ${pageLimit}; ${result.totalCount ? `${result.totalCount} listings exist` : 'more pages may exist'}.`);
      }
      return {
        records: result.records,
        normalizer: normalizeProperty,
        strategy: isHomeflowPayload(candidate) ? 'embedded-homeflow' : 'embedded-html',
        pagesFetched: result.pagesFetched,
        expectedListings: result.totalCount || null,
        complete: result.complete,
      };
    }
  } catch (error) {
    console.warn(`HTTP inspection failed (${error.message}). Continuing with browser discovery.`);
  }

  console.log('\nPhase 2: Capturing browser XHR/fetch responses...\n');
  try {
    const result = await scrapeWithBrowser({ url, maxPages: pageLimit });
    if (result.records.length) return result;
    console.log('Browser discovery found no property-shaped API payloads.');
  } catch (error) {
    console.warn(`Browser discovery unavailable (${error.message}).`);
  }

  console.log('\nPhase 3: Falling back to semantic HTML extraction...\n');
  if (!initialHtml) {
    const response = await fetchWithRetries(session, url);
    if (!response.ok) throw new Error(`Unable to retrieve page HTML (HTTP ${response.status})`);
    initialHtml = await response.text();
  }

  const [source, records] = extractStaticHtmlRecords(initialHtml);
  if (!records.length) {
    throw new Error('No property-shaped API payload or HTML listing cards were found.');
  }

  console.log(`[${source}] Found ${records.length} listing(s).`);
  return {
    records,
    normalizer: normalizeFromDom,
    strategy: `html-${source.toLowerCase().replace(/\s+/g, '-')}`,
    pagesFetched: 1,
    expectedListings: null,
    complete: true,
  };
}

function scopeDiscoveryEnabled(value) {
  return value === true || value === 'true' || value === 'auto';
}

function enabled(value) {
  return value === true || value === 'true';
}

function isUsableNormalizedListing(record) {
  if (!record || typeof record !== 'object') return false;
  const title = String(record.title || '').trim();
  if (/^(?:minimum|maximum)?\s*(?:price|location|bedrooms?)\s*:?$|^(?:load|show|view)\s+(?:previous|next|more|items|results)/i.test(title)) return false;
  const evidence = [record.sourceUrl, record.address, record.images?.length, record.description, record.bedrooms, record.propertyType]
    .filter((value) => value !== undefined && value !== null && value !== '').length;
  return evidence >= 2 && Boolean(title || record.address || record.sourceUrl);
}

async function scrape({
  url,
  outFile,
  maxPages,
  deep,
  maxDetailPages,
  scopeDiscovery,
  maxScopes,
  sitemap,
  sitemapDetails,
  reportFile,
  aiNormalize,
  aiMap,
  aiModel,
  aiConcurrency,
  platformOnly,
  mappingsDir,
  forceRegenerate,
  signal,
  onProgress,
  skipWrite = false,
}) {
  if (!url) throw new Error('--url is required');
  if (enabled(platformOnly) && !enabled(aiNormalize) && !enabled(aiMap)) {
    throw new Error('--platform-only requires --ai-normalize or --ai-map.');
  }

  const startedAt = new Date().toISOString();
  const pageLimit = asPositiveInteger(maxPages, 500);
  const scopeLimit = asPositiveInteger(maxScopes, 50);
  const session = new HttpSession({}, signal);
  const reportProgress = (stage, message, percent) => {
    if (typeof onProgress === 'function') onProgress({ stage, message, percent });
  };
  let scopes = [url];
  let discovery = null;

  async function findScopes() {
    const response = await fetchWithRetries(session, url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return discoverScopes({
      session,
      url,
      html: await response.text(),
      maxScopes: scopeLimit,
      maxDetailUrls: asPositiveInteger(maxDetailPages, 100),
      includeSitemap: sitemap !== 'false' && sitemap !== false,
    });
  }

  if (scopeDiscoveryEnabled(scopeDiscovery)) {
    console.log(`\n=== Discovering search scopes from: ${url} ===\n`);
    try {
      discovery = await findScopes();
      scopes = discovery.scopes;
      console.log(`Found ${scopes.length} valid search scope(s)${discovery.sitemap.scanned ? `; sitemap exposed ${discovery.sitemap.urlsFound} URL(s)` : ''}.`);
      if (discovery.locationOptions.length) console.log(`Found ${discovery.locationOptions.length} location option(s); routes are not guessed from them.`);
    } catch (error) {
      console.warn(`Scope discovery failed (${error.message}); scraping the requested URL only.`);
    }
  }

  const scopeReports = [];
  const normalized = [];
  for (let index = 0; index < scopes.length; index += 1) {
    const scopeUrl = scopes[index];
    console.log(`\n=== Scraping scope ${index + 1}/${scopes.length}: ${scopeUrl} ===\n`);
    try {
      if (signal?.aborted) throw signal.reason;
      reportProgress('scraping', `Collecting listings from ${new URL(scopeUrl).hostname}`, 10);
      const result = await scrapeScope({ url: scopeUrl, pageLimit, session });
      reportProgress('scraping', `Found ${result.records.length} listing records`, 30);
      let enrichment = null;
      if (deep === true || deep === 'true') {
        const limit = asPositiveInteger(maxDetailPages, 100);
        const detailTotal = Math.min(result.records.length, limit);
        reportProgress('enriching', `Enriching ${detailTotal} property detail pages`, 32);
        enrichment = await enrichWithDetailPages({
          records: result.records,
          sourceUrl: scopeUrl,
          session,
          maxPages: limit,
          onProgress: ({ completed, total }) => reportProgress('enriching', `Enriching property details (${completed}/${total})`, 32 + Math.round((completed / Math.max(total, 1)) * 48)),
        });
        console.log(`Detail enrichment: ${enrichment.enriched}/${enrichment.attempted} page(s) supplied extra fields.`);
      }
      reportProgress('processing', 'Cleaning and deduplicating records', 82);
      normalized.push(...result.records.map((record) => result.normalizer(record, scopeUrl)));
      scopeReports.push({
        url: scopeUrl,
        status: 'complete',
        strategy: result.strategy,
        records: result.records.length,
        pagesFetched: result.pagesFetched || null,
        expectedListings: result.expectedListings || null,
        complete: result.complete !== false,
        detailEnrichment: enrichment,
      });
    } catch (error) {
      const failedScope = { url: scopeUrl, status: 'failed', error: error.message, records: 0, complete: false };
      scopeReports.push(failedScope);
      console.warn(`Scope failed (${error.message}).`);

      // Safe automatic escalation: only when the requested URL failed to
      // yield listings. A successful URL remains a single, precise query.
      if (scopeDiscovery === undefined && !discovery && index === 0) {
        try {
          console.log('\nNo listings from the requested route; discovering alternate search scopes...\n');
          discovery = await findScopes();
          const existing = new Set(scopes.map(scopeKey));
          const alternatives = discovery.scopes.filter((candidate) => !existing.has(scopeKey(candidate)));
          if (alternatives.length) {
            scopes.push(...alternatives);
            failedScope.status = 'superseded';
            console.log(`Automatically queued ${alternatives.length} discovered scope(s).`);
          }
        } catch (discoveryError) {
          console.warn(`Automatic scope discovery failed (${discoveryError.message}).`);
        }
      }
    }
  }

  if ((sitemapDetails === true || sitemapDetails === 'true') && discovery?.detailUrls.length) {
    const limit = asPositiveInteger(maxDetailPages, 100);
    console.log(`\n=== Crawling ${Math.min(limit, discovery.detailUrls.length)} sitemap detail URL(s) ===\n`);
    const result = await crawlSitemapDetailPages({ urls: discovery.detailUrls, sourceUrl: url, session, maxPages: limit });
    normalized.push(...result.records.map((record) => normalizeProperty(record, url)));
    scopeReports.push({
      url: 'sitemap detail URLs',
      status: 'complete',
      strategy: 'sitemap-detail-pages',
      records: result.records.length,
      pagesFetched: result.attempted,
      expectedListings: null,
      complete: result.attempted >= discovery.sitemap.detailUrlsFound,
    });
    console.log(`Sitemap details: extracted ${result.records.length}/${result.attempted} property-shaped record(s).`);
  }

  const usable = normalized.filter(isUsableNormalizedListing);
  if (usable.length !== normalized.length) {
    console.warn(`Discarded ${normalized.length - usable.length} control/placeholder record(s) that lacked listing evidence.`);
  }
  let listings = dedupeRecords(usable);
  const rawOutputPath = outFile || defaultOutFileName(url);

  if ((enabled(aiMap) || enabled(aiNormalize)) && !skipWrite) {
    writeNormalizedListings(listings, rawOutputPath, false, { dedupe: false });
  }

  let aiNormalization = null;

  if (enabled(aiMap)) {
    if (!process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) {
      throw new Error('No AI API key is set. Add OPENROUTER_API_KEY or GEMINI_API_KEY before using --ai-map.');
    }
    reportProgress('mapping', `Mapping ${listings.length} records to the platform schema`, 88);
    console.log(`\n=== AI-map: generating recipe for ${listings.length} listing(s) ===\n`);
    const recipe = await loadOrGenerateRecipe(url, listings, {
      model: aiModel,
      mappingsDir,
      forceRegenerate: enabled(forceRegenerate),
      signal,
    });
    const result = applyRecipeBatch(listings, recipe, url);
    listings = result.records;
    aiNormalization = {
      provider: 'mapping-recipe',
      model: recipe._model || aiModel || 'recipe',
      requested: listings.length,
      normalized: result.normalized,
      failed: result.failed,
    };
  } else if (enabled(aiNormalize)) {
    if (!process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) {
      throw new Error('No AI API key is set. Add OPENROUTER_API_KEY or GEMINI_API_KEY before using --ai-normalize.');
    }
    const configuredProvider = process.env.AI_PROVIDER || (process.env.OPENROUTER_API_KEY ? 'openrouter' : 'gemini');
    const providerName = configuredProvider.toLowerCase() === 'gemini' ? 'Gemini' : 'OpenRouter';
    const selectedModel = aiModel || (providerName === 'Gemini' ? process.env.GEMINI_MODEL : process.env.OPENROUTER_MODEL) || DEFAULT_MODEL;
    console.log(`\n=== Normalizing ${listings.length} listing(s) with ${providerName} (${selectedModel}) ===\n`);
    const result = await normalizeListingsWithAi(listings, {
      model: aiModel,
      concurrency: asPositiveInteger(aiConcurrency, 1),
      signal,
      onProgress: ({ completed, total, normalized: completedSuccessfully, failed }) => {
        reportProgress('mapping', `Mapping records (${completed}/${total})`, 84 + Math.round((completed / Math.max(total, 1)) * 14));
        console.log(`  AI ${completed}/${total}: ${completedSuccessfully} normalized, ${failed} needs review`);
      },
    });
    listings = result.records;
    aiNormalization = {
      provider: 'openrouter',
      model: selectedModel,
      requested: listings.length,
      normalized: result.normalized,
      failed: result.failed,
    };
  }

  const isAiRun = enabled(aiMap) || enabled(aiNormalize);
  let finalOutputPath = rawOutputPath;
  if (isAiRun) {
    finalOutputPath = outFile 
      ? path.join(path.dirname(outFile), 'ai-normalized', path.basename(outFile))
      : `data/ai-normalized/${path.basename(rawOutputPath)}`;
  }

  const outputRecords = enabled(platformOnly) ? toPlatformOnly(listings) : listings;
  writeNormalizedListings(outputRecords, finalOutputPath, skipWrite, { dedupe: false });
  const report = buildRunReport({ sourceUrl: url, startedAt, scopes: scopeReports, records: listings, outputFile: finalOutputPath });
  if (aiNormalization) report.aiNormalization = aiNormalization;
  if (discovery) report.discovery = discovery;
  if (!skipWrite) {
    writeRunReport(report, finalOutputPath, reportFile);
  }
  if (!scopeReports.some((scope) => scope.status === 'complete')) {
    throw new Error('No scope could be scraped successfully; see the run report for failure details.');
  }
  reportProgress('saving', 'Saving completed records', 100);
  return outputRecords;
}

module.exports = scrape;
