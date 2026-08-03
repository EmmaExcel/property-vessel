const { launchBrowser } = require('../lib/browser');
const { scoreJsonForPropertyData } = require('../lib/utils');

async function discover({ url, timeout = 20000 }) {
  if (!url) throw new Error('--url is required');

  console.log(`\nLaunching browser and loading: ${url}\n`);
  const browser = await launchBrowser();
  const page = await browser.newPage();

  const candidates = [];
  const pendingCaptures = [];

  page.on('response', (response) => {
    const capture = (async () => {
      try {
        const request = response.request();
        if (response.status() >= 400) return;
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

        const { score, sample, arrayPath } = scoreJsonForPropertyData(json);
        if (score > 0) {
          candidates.push({
            endpoint: request.url(),
            method: request.method(),
            score,
            arrayPath,
            sampleKeys: sample ? Object.keys(sample) : [],
            sample,
          });
        }
      } catch (err) {

      }
    })();
    pendingCaptures.push(capture);
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
  } catch (err) {
    console.warn(`Warning: page load didn't fully settle (${err.message}). Continuing with what was captured.`);
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Wait for all response bodies to finish downloading.
  await Promise.race([
    Promise.allSettled(pendingCaptures),
    new Promise((resolve) => setTimeout(resolve, 15000)),
  ]);

  await browser.close();

  const byEndpoint = new Map();
  for (const c of candidates) {
    const existing = byEndpoint.get(c.endpoint);
    if (!existing || c.score > existing.score) byEndpoint.set(c.endpoint, c);
  }
  const ranked = [...byEndpoint.values()].sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    console.log('No JSON API calls that look like property data were found.');
    console.log('This site likely renders listings server-side in the HTML.');
    console.log('Try: node scraper.js discover-dom --url <url>  (see README)');
    return;
  }

  console.log(`Found ${ranked.length} candidate endpoint(s), best matches first:\n`);
  ranked.slice(0, 5).forEach((c, i) => {
    console.log(`${i + 1}. [score ${c.score}/9] ${c.method} ${c.endpoint}`);
    console.log(`   data path: ${c.arrayPath}`);
    console.log(`   sample fields: ${c.sampleKeys.join(', ')}`);
    console.log('');
  });

  const best = ranked[0];
  console.log('--- Sample record from the top match ---');
  console.log(JSON.stringify(best.sample, null, 2));
  console.log('\nNext step: confirm this is the right endpoint, then run:');
  console.log(`  node scraper.js extract --url "${url}" --match "${new URL(best.endpoint).pathname}"\n`);

  return ranked;
}

module.exports = discover;
