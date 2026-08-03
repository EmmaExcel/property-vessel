const { delay, fetchWithRetries } = require('./httpClient');
const { dedupeRecords, recordsFromJson } = require('./utils');

function isHomeflowPayload(candidate) {
  return Boolean(
    candidate
    && Array.isArray(candidate.json?.properties)
    && candidate.json?.pagination
    && Number.isFinite(Number(candidate.json.pagination.current_page)),
  );
}

function inferHomeflowSearch(urlStr) {
  const pageUrl = new URL(urlStr);
  const segments = pageUrl.pathname.split('/').filter(Boolean);
  const channel = segments.includes('lettings') ? 'lettings' : 'sales';
  const fragments = segments.filter((segment) => ![
    'properties',
    'property',
    'sales',
    'lettings',
    'list',
    'map',
  ].includes(segment));
  const initialPageIndex = fragments.findIndex((segment) => /^page-\d+$/.test(segment));
  if (initialPageIndex >= 0) fragments.splice(initialPageIndex, 1);

  const endpoint = new URL('/search.ljson', pageUrl.origin);
  for (const [key, value] of pageUrl.searchParams.entries()) {
    if (!['page', 'fragment', 'channel'].includes(key)) endpoint.searchParams.append(key, value);
  }
  endpoint.searchParams.set('channel', channel);

  return {
    channel,
    urlForPage(page) {
      endpoint.searchParams.set('fragment', [...fragments, `page-${page}`].join('/'));
      return endpoint.toString();
    },
  };
}

async function paginateHomeflow({ session, listingUrl, initialCandidate, maxPages, onPage }) {
  const search = inferHomeflowSearch(listingUrl);
  let payload = initialCandidate.json;
  let records = [...initialCandidate.records];
  let page = Number(payload.pagination.current_page) || 1;
  let pagesFetched = 1;

  while (payload.pagination.has_next_page && pagesFetched < maxPages) {
    const nextPage = page + 1;
    const endpoint = search.urlForPage(nextPage);
    const response = await fetchWithRetries(session, endpoint, {
      headers: {
        accept: 'application/json, application/ljson, text/json;q=0.9, */*;q=0.8',
        referer: listingUrl,
      },
    });
    if (!response.ok) throw new Error(`Homeflow pagination returned HTTP ${response.status}`);

    const body = await response.text();
    let json;
    try {
      json = JSON.parse(body.replace(/^\)]}',?\s*/, ''));
    } catch {
      throw new Error(`Homeflow page ${nextPage} did not return JSON`);
    }

    const batch = recordsFromJson(json);
    if (!batch.records.length || batch.score < 3) {
      throw new Error(`Homeflow page ${nextPage} did not contain property records`);
    }

    records.push(...batch.records);
    records = dedupeRecords(records);
    payload = json;
    page = Number(json.pagination?.current_page) || nextPage;
    pagesFetched += 1;
    onPage?.({ page, added: batch.records.length, total: records.length, pagination: json.pagination });

    if (json.pagination?.has_next_page) await delay(120);
  }

  return {
    records,
    pagesFetched,
    totalCount: Number(payload.pagination?.total_count) || null,
    complete: !payload.pagination?.has_next_page,
  };
}

module.exports = {
  inferHomeflowSearch,
  isHomeflowPayload,
  paginateHomeflow,
};
