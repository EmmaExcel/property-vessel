const puppeteer = require('puppeteer');
const fs = require('fs');

const SYSTEM_CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].filter(Boolean);

async function launchBrowser() {
  const containerArgs = process.env.PUPPETEER_CONTAINER === 'true'
    ? ['--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update']
    : [];

  // Cloud containers deliberately use the distribution's Chromium package so
  // the image works on both AMD64 and Oracle's Always Free ARM instances.
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    try {
      return await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        args: containerArgs,
      });
    } catch (error) {
      console.warn(`\nConfigured Chromium failed to launch (${error.message}); trying other browser options.`);
    }
  }

  try {
    return await puppeteer.launch({ headless: 'new', args: containerArgs });
  } catch (err) {
    console.warn(`\nBundled Chromium failed to launch (${err.message}).`);
    console.warn('Retrying with your system-installed Google Chrome...\n');
    let lastError = err;
    for (const executablePath of SYSTEM_CHROME_PATHS) {
      if (!fs.existsSync(executablePath)) continue;
      try {
        return await puppeteer.launch({
          headless: 'new',
          executablePath,
          args: [...new Set([...containerArgs, '--disable-background-networking', '--disable-component-update'])],
        });
      } catch (launchError) {
        lastError = launchError;
      }
    }

    try {
      return await puppeteer.launch({ headless: 'new', channel: 'chrome' });
    } catch (err2) {
      lastError = err2;
      console.error('Could not launch a browser at all. Likely causes:');
      console.error('  1. Bundled Chromium is corrupted/quarantined by macOS Gatekeeper.');
      console.error('     Fix: rm -rf ~/.cache/puppeteer && npm install');
      console.error('  2. On Apple Silicon, Rosetta is missing for the x64 Chromium build.');
      console.error('     Fix: softwareupdate --install-rosetta --agree-to-license');
      console.error('  3. No Google Chrome installed on this machine for the fallback to use.');
      console.error(`\nOriginal errors — bundled: ${err.message}`);
      console.error(`                   system Chrome: ${lastError.message}`);
      throw lastError;
    }
  }
}

module.exports = {
  launchBrowser
};
