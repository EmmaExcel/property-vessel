const pkg = require('../package.json');

const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (text) => paint('1', text);
const cyan = (text) => paint('36', text);
const green = (text) => paint('32', text);
const yellow = (text) => paint('33', text);
const red = (text) => paint('31', text);
const dim = (text) => paint('2', text);

function banner() {
  console.log(`\n${bold(cyan('listing-scraper'))} ${dim(`v${pkg.version}`)} — property inventory crawler\n`);
}

function command(name, url) {
  console.log(`${cyan('›')} ${bold(name)}${url ? `  ${dim(url)}` : ''}`);
}

function success(message) {
  console.log(`${green('✓')} ${message}`);
}

function warning(message) {
  console.warn(`${yellow('!')} ${message}`);
}

function error(message) {
  console.error(`${red('✗')} ${message}`);
}

function printHelp(commandName) {
  banner();
  console.log('Usage:');
  console.log('  listing-scraper <command> [options]\n');
  console.log('Commands:');
  console.log(`  ${bold('scrape')}           Auto-detect the strongest extraction strategy.`);
  console.log(`  ${bold('discover')}         Inspect browser API calls for listing-shaped payloads.`);
  console.log(`  ${bold('discover-scopes')}  List same-site search routes and sitemap candidates.`);
  console.log(`  ${bold('extract')}          Extract a selected API endpoint after discovery.`);
  console.log(`  ${bold('extract-dom')}      Extract repeated listing cards from rendered HTML.`);
  console.log(`  ${bold('discover-dom')}     Inspect likely repeated listing-card selectors.`);
  console.log(`  ${bold('normalize-existing')} AI-normalize saved *-listings.json files without scraping again.\n`);
  console.log('Most useful command:');
  console.log('  listing-scraper scrape --url <listing-page-url> [--max-pages 500]\n');
  console.log('Scrape options:');
  console.log('  --scope-discovery        Expand to linked/sitemap search scopes intentionally.');
  console.log('  --max-scopes <n>         Safety cap for discovered search scopes (default: 50).');
  console.log('  --deep                   Enrich missing fields from property detail pages.');
  console.log('  --max-detail-pages <n>   Cap detail-page requests (default: 100 with --deep).');
  console.log('  --sitemap-details        Crawl sitemap property URLs (explicit, request-heavy).');
  console.log('  --ai-normalize           Map listings to the platform schema through OpenRouter (per-record).');
  console.log('  --ai-map                 Generate a reusable mapping recipe with AI (1 call per source, recommended).');
  console.log('  --ai-model <model>       Override OPENROUTER_MODEL for this import.');
  console.log('  --ai-concurrency <n>     Parallel AI requests (default: 1; use 1 on free tier).');
  console.log('  --force-regenerate       Regenerate cached mapping recipe even if one exists.');
  console.log('  --platform-only          Write only platform schema drafts (requires --ai-normalize or --ai-map).');
  console.log('  --out-file <path>        Listings JSON destination.');
  console.log('  --report-file <path>     Coverage report destination.\n');
  console.log('Existing-data options:');
  console.log('  --file <path>            Normalize one existing listing JSON file.');
  console.log('  --data-dir <path>        Folder to scan for *-listings.json (default: data).');
  console.log('  --out-dir <path>         Output folder for enriched copies (default: data/ai-normalized).');
  console.log('  --max-records <n>        Total AI requests for this run (default: 50).');
  console.log('  --resume false           Ignore previously enriched output files.');
  console.log('  --retry-failed           Retry records whose prior AI request failed.\n');
  console.log('Examples:');
  console.log('  listing-scraper scrape --url "https://agent-site.com/properties/sales"');
  console.log('  listing-scraper scrape --url "https://agent-site.com/properties/sales" --ai-map --platform-only');
  console.log('  listing-scraper scrape --url "https://agent-site.com/properties/sales" --ai-normalize --platform-only');
  console.log('  listing-scraper normalize-existing --data-dir data --ai-map');
  console.log('  listing-scraper normalize-existing --data-dir data --max-records 50');
  console.log('  listing-scraper scrape --url "https://agent-site.com/property/for-sale/in-york/" --scope-discovery');
  console.log('  listing-scraper discover-scopes --url "https://agent-site.com/property/for-sale/in-york/"');
  if (commandName) console.log(`\n${dim(`Help requested for: ${commandName}`)}`);
}

module.exports = { banner, command, success, warning, error, printHelp };
