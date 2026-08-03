const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('../lib/browser');
const { 
  scoreJsonForPropertyData, 
  detectPagination, 
  normalizeProperty, 
  defaultOutFileName 
} = require('../lib/utils');

async function extract({ url, match, outFile, maxPages = 20, pageSize }) {
  if (!url) throw new Error('--url is required');
  if (!match) throw new Error('--match is required (path fragment identifying the API endpoint, e.g. "/api/listings")');

  console.log(`\nLaunching browser to capture "${match}" calls from: ${url}\n`);
  const browser = await launchBrowser();
  const page = await browser.newPage();

 
  const matchedResponses = [];
  const pendingCaptures = [];

  page.on('response', (response) => {
    const capture = (async () => {
      try {
        const reqUrl = response.request().url();
        if (!reqUrl.includes(match)) return;
        const length = Number(response.headers()['content-length'] || 0);
        if (length > 12_000_000) return;
        const text = await response.text().catch(() => null);
        if (!text) return;
        let json;
        try {
          json = JSON.parse(text.replace(/^\)]}',?\s*/, ''));
        } catch {
          return;
        }

        matchedResponses.push({ url: reqUrl, json });
      } catch {

      }
    })();
    pendingCaptures.push(capture);
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
  } catch (err) {
    console.warn(`Warning: initial page load didn't fully settle (${err.message}).`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Wait for all response bodies to finish downloading.
  await Promise.race([
    Promise.allSettled(pendingCaptures),
    new Promise((resolve) => setTimeout(resolve, 15000)),
  ]);

  await browser.close();

  if (matchedResponses.length === 0) {
    console.log(`No response matching "${match}" was captured on the first load.`);
    console.log('Double-check the --match string against what discover mode reported.');
    return;
  }

  const scoredCandidates = matchedResponses
    .map((r) => ({ ...r, ...scoreJsonForPropertyData(r.json) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scoredCandidates.length === 0) {
    console.log(`Captured ${matchedResponses.length} response(s) matching "${match}", but none contained`);
    console.log('property-shaped data (e.g. one may be a count/aggregate endpoint that just shares');
    console.log('the same path substring). Try a more specific --match, or re-check discover output:');
    matchedResponses.forEach((r) => console.log(`  - ${r.url}`));
    return;
  }

  const best = scoredCandidates[0];
  if (scoredCandidates.length > 1 && scoredCandidates[1].score === best.score) {
    console.log(`Note: ${scoredCandidates.length} responses matched "${match}" with similar-looking data.`);
    console.log(`Using the first: ${best.url}`);
    console.log('If this is the wrong one, narrow --match to something more specific:');
    scoredCandidates.forEach((r) => console.log(`  [score ${r.score}] ${r.url}`));
  }

  const firstMatchedResponse = { url: best.url, json: best.json };
  const { sample } = best;

  const allRecordsRaw = [];
  function collectArrayAtPath(json, targetSampleKeys) {

    let found = null;
    function walk(node) {
      if (found) return;
      if (Array.isArray(node) && node.length > 0) {
        const first = node.find((i) => typeof i === 'object' && i !== null);
        if (first && targetSampleKeys.every((k) => Object.keys(first).includes(k))) {
          found = node;
          return;
        }
      } else if (typeof node === 'object' && node !== null) {
        for (const v of Object.values(node)) walk(v);
      }
    }
    walk(json);
    return found || [];
  }

  const sampleKeys = Object.keys(sample);
  let records = collectArrayAtPath(firstMatchedResponse.json, sampleKeys);
  allRecordsRaw.push(...records);

  const pagination = detectPagination(firstMatchedResponse.url);
  if (pagination) {
    const step = pageSize ? Number(pageSize) : pagination.step;
    const howFound = pagination.inferred ? 'inferred (not present in the first request)' : 'detected';
    console.log(`Using ${pagination.style}-style pagination param "${pagination.param}" (${howFound}, step ${step}) — fetching additional pages...`);
    const baseUrl = new URL(firstMatchedResponse.url);
    let pageIndex = Number(baseUrl.searchParams.get(pagination.param)) || 0;

    for (let i = 1; i < maxPages; i++) {
      pageIndex += step;
      baseUrl.searchParams.set(pagination.param, String(pageIndex));
      try {
        const res = await fetch(baseUrl.toString());
        if (!res.ok) break;
        const json = await res.json();
        const more = collectArrayAtPath(json, sampleKeys);
        if (!more || more.length === 0) break;
        allRecordsRaw.push(...more);
        console.log(`  page ${pageIndex}: +${more.length} records (total ${allRecordsRaw.length})`);
      } catch (err) {
        console.warn(`  stopped paginating: ${err.message}`);
        break;
      }
    }
  } else {
    console.log('No obvious pagination param found on the endpoint — captured a single page/batch.');
    console.log('If the agent has more listings than this returned, the site likely uses cursor');
    console.log('or infinite-scroll pagination; you may need to script scrolling/"load more" clicks.');
  }

  const normalized = allRecordsRaw.map((r) => normalizeProperty(r, url));

  const resolvedOutFile = outFile || defaultOutFileName(url);
  const absolutePath = path.resolve(resolvedOutFile);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(normalized, null, 2));
  console.log(`\nWrote ${normalized.length} normalized listing(s) to ${resolvedOutFile}`);
}

module.exports = extract;
