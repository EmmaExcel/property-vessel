const cheerio = require('cheerio');
const { launchBrowser } = require('../lib/browser');

async function discoverDom({ url }) {
  if (!url) throw new Error('--url is required');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
  const html = await page.content();
  await browser.close();

  const $ = cheerio.load(html);

  const priceRegex = /[£$€]\s?[\d,]+/;
  const candidateContainers = new Map();

  $('*').each((_, el) => {
    const text = $(el).text();
    if (priceRegex.test(text) && text.length < 400) {
      const parentSelector = $(el).parent().prop('tagName');
      const key = `${el.tagName}.${$(el).attr('class') || ''}`;
      candidateContainers.set(key, (candidateContainers.get(key) || 0) + 1);
    }
  });

  const ranked = [...candidateContainers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('Repeated elements containing price-like text (likely listing cards):\n');
  ranked.forEach(([selector, count]) => console.log(`  ${count}x  ${selector}`));
  console.log('\nThis is a starting point only — inspect the page in devtools to confirm the');
  console.log('actual card selector and field selectors, then write a page.evaluate() extractor');
  console.log('using those selectors (see README for a template).');
}

module.exports = discoverDom;
