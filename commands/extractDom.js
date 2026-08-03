const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { launchBrowser } = require('../lib/browser');
const { extractJsonLd, extractMicrodata, extractCards } = require('../lib/htmlExtractor');
const { normalizeFromDom, defaultOutFileName } = require('../lib/utils');
const { NEXT_PAGE_SELECTORS, LOAD_MORE_SELECTORS } = require('../lib/constants');

async function extractDom({ url, outFile, maxPages = 20, deep }) {
  if (!url) throw new Error('--url is required');

  console.log(`\nLaunching browser for HTML extraction: ${url}\n`);
  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (err) {
    console.warn(`Warning: page load didn't fully settle (${err.message}). Continuing...`);
  }

  await new Promise((r) => setTimeout(r, 2000));

  const allRecords = [];
  let pageNum = 1;

  while (pageNum <= maxPages) {
    const html = await page.content();
    const $ = cheerio.load(html);
    let records = [];
    let source = '';

    const jsonLd = extractJsonLd($);
    if (jsonLd.length > 0) {
      records = jsonLd;
      source = 'JSON-LD';
    }

    if (records.length === 0) {
      const micro = extractMicrodata($);
      if (micro.length > 0) {
        records = micro;
        source = 'Microdata';
      }
    }

    if (records.length === 0) {
      const cards = extractCards($);
      if (cards.length > 0) {
        records = cards;
        source = 'Card detection';
      }
    }

    if (records.length === 0 && pageNum === 1) {
      console.log('Could not find any property-shaped data in the HTML.');
      console.log('The site may use a non-standard layout that needs manual selector configuration.');
      await browser.close();
      return;
    }

    if (records.length === 0) break;

    const newCount = records.filter((r) => {
      const key = r.url || r.title || r.price || JSON.stringify(r);
      return !allRecords.some((existing) => {
        const eKey = existing.url || existing.title || existing.price || JSON.stringify(existing);
        return eKey === key;
      });
    });

    if (newCount.length === 0) {
      console.log(`  page ${pageNum}: no new records — stopping.`);
      break;
    }

    allRecords.push(...newCount);
    if (pageNum === 1) {
      console.log(`[${source}] Found ${newCount.length} listings on first page.`);
    } else {
      console.log(`  page ${pageNum}: +${newCount.length} records (total ${allRecords.length})`);
    }

    const nextPage = await navigateToNextPage(page);
    if (!nextPage) break;
    pageNum++;

    await new Promise((r) => setTimeout(r, 2000));
  }

  if (deep === 'true' || deep === true) {
    console.log('\n--deep flag set: crawling individual listing pages for full details...');
    await enrichWithDetailPages(browser, allRecords, url);
  }

  await browser.close();

  const normalized = allRecords.map((r) => normalizeFromDom(r, url));

  const resolvedOutFile = outFile || defaultOutFileName(url);
  const absolutePath = path.resolve(resolvedOutFile);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(normalized, null, 2));
  console.log(`\nWrote ${normalized.length} normalized listing(s) to ${resolvedOutFile}`);
}

async function navigateToNextPage(page) {
  for (const selector of NEXT_PAGE_SELECTORS) {
    try {
      const el = await page.$(selector);
      if (el) {
        const href = await el.evaluate((a) => a.href);
        if (href) {
          console.log(`  clicking next page: ${selector}`);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
            el.click(),
          ]);
          return true;
        }
      }
    } catch {}
  }

  for (const selector of LOAD_MORE_SELECTORS) {
    try {
      const el = await page.$(selector);
      if (el) {
        const visible = await el.evaluate((e) => {
          const style = window.getComputedStyle(e);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (visible) {
          console.log(`  clicking load more: ${selector}`);
          await el.click();
          await new Promise((r) => setTimeout(r, 3000));
          return true;
        }
      }
    } catch {}
  }

  const scrolledNew = await autoScroll(page);
  return scrolledNew;
}

async function autoScroll(page) {
  const beforeHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 3000));
  const afterHeight = await page.evaluate(() => document.body.scrollHeight);

  if (afterHeight > beforeHeight) {
    console.log('  scrolled to load more content');
    return true;
  }
  return false;
}

async function enrichWithDetailPages(browser, records, baseUrl) {
  const baseOrigin = new URL(baseUrl).origin;
  let enriched = 0;

  for (const record of records) {
    if (!record.url) continue;

    let detailUrl = record.url;
    if (detailUrl.startsWith('/')) detailUrl = baseOrigin + detailUrl;
    if (!detailUrl.startsWith('http')) continue;

    try {
      const page = await browser.newPage();
      await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 15000 });
      const html = await page.content();
      await page.close();

      const $ = cheerio.load(html);
      const jsonLd = extractJsonLd($);
      if (jsonLd.length > 0) {
        const detail = jsonLd[0];
        for (const [key, value] of Object.entries(detail)) {
          if (key === '_source') continue;
          if (value && !record[key]) record[key] = value;
        }
        enriched++;
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.warn(`  failed to enrich ${detailUrl}: ${err.message}`);
    }
  }

  console.log(`  enriched ${enriched} of ${records.length} records from detail pages.`);
}

module.exports = extractDom;
