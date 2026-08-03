const DEFAULT_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'en-GB,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HttpSession {
  constructor(headers = {}) {
    this.headers = { ...DEFAULT_HEADERS, ...headers };
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  storeCookies(response) {
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : response.headers.get('set-cookie')?.split(/,(?=[^;,]+=)/g) || [];

    for (const cookie of cookies) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  async fetch(url, options = {}) {
    const headers = { ...this.headers, ...options.headers };
    const cookie = this.cookieHeader();
    if (cookie && !headers.cookie) headers.cookie = cookie;

    const response = await fetch(url, {
      redirect: 'follow',
      ...options,
      headers,
    });
    this.storeCookies(response);
    return response;
  }
}

async function fetchWithRetries(session, url, options = {}, retries = 3) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await session.fetch(url, options);
      if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === retries) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
    }

    await delay(400 * (2 ** attempt) + Math.floor(Math.random() * 150));
  }

  throw lastError;
}

module.exports = {
  HttpSession,
  delay,
  fetchWithRetries,
};
