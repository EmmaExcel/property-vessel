#!/usr/bin/env node

const discover = require('./commands/discover');
const extract = require('./commands/extract');
const extractDom = require('./commands/extractDom');
const discoverDom = require('./commands/discoverDom');
const discoverScopes = require('./commands/discoverScopes');
const scrape = require('./commands/scrape');
const normalizeExisting = require('./commands/normalizeExisting');
const cli = require('./lib/cli');

function parseArgs(argv) {
  const mode = argv[2];
  const args = { mode };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '-h') {
      args.help = true;
      continue;
    }
    if (argv[i] === '-v') {
      args.version = true;
      continue;
    }
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i]
      .replace(/^--/, '')
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  try {
    if (args.mode === '--version' || args.mode === '-v' || args.version) {
      console.log(require('./package.json').version);
    } else if (args.mode === '--help' || args.mode === '-h' || args.help || !args.mode) {
      cli.printHelp(args.mode && !args.mode.startsWith('-') ? args.mode : null);
    } else if (args.mode === 'scrape') {
      cli.banner();
      cli.command('scrape', args.url);
      await scrape(args);
      cli.success('Scrape finished. Inspect the listings JSON and companion run report.');
    }
    else if (args.mode === 'normalize-existing') {
      cli.banner();
      cli.command('normalize-existing', args.file || args.dataDir || 'data');
      await normalizeExisting(args);
      cli.success('Existing listing files have been AI-normalized.');
    }
    else if (args.mode === 'discover') await discover(args);
    else if (args.mode === 'extract') await extract(args);
    else if (args.mode === 'extract-dom') await extractDom(args);
    else if (args.mode === 'discover-dom') await discoverDom(args);
    else if (args.mode === 'discover-scopes') await discoverScopes(args);
    else {
      cli.error(`Unknown command: ${args.mode}`);
      cli.printHelp();
      process.exitCode = 1;
    }
  } catch (err) {
    cli.error(err.message);
    console.error('Run "listing-scraper --help" to see available commands.');
    process.exit(1);
  }
})();
