const { HttpSession, fetchWithRetries } = require('../lib/httpClient');
const { discoverScopes } = require('../lib/scopeDiscovery');

async function discoverScopesCommand({ url, maxScopes, maxDetailPages, sitemap }) {
  if (!url) throw new Error('--url is required');
  const limit = Number.parseInt(maxScopes, 10) || 50;
  const session = new HttpSession();
  const response = await fetchWithRetries(session, url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

  const result = await discoverScopes({
    session,
    url,
    html: await response.text(),
    maxScopes: limit,
    maxDetailUrls: Number.parseInt(maxDetailPages, 10) || 100,
    includeSitemap: sitemap !== 'false' && sitemap !== false,
  });

  console.log(JSON.stringify(result, null, 2));
  return result;
}

module.exports = discoverScopesCommand;
