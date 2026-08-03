# listing-scraper

Extracts listing data from an agent's own website without relying on one
specific template or one fragile browser-only path.

## Browser app — no terminal required

On macOS, double-click `Launch Property Vessel.command` in this folder. It
starts the local scraper and opens the control panel in your browser at
`http://localhost:3000`.

The private operations dashboard accepts up to ten listing-page URLs per run.
It includes a proper sign-in screen, workspace metrics, live run monitoring,
persistent history, per-source contact coverage, and a searchable MongoDB data
library. Scrapes support detail enrichment, optional search-area discovery,
reusable AI mapping, per-record AI mapping, raw-only output, review counts, and
downloads for raw JSON, platform JSON, and the audit report. Each browser run
uses its own temporary folder under `data/runs/`, so one run does not overwrite
another. When MongoDB is configured, the temporary folder and in-memory job are
removed only after the raw records, mapped records, report, and final job state
have been confirmed in MongoDB. Downloads then stream from MongoDB.

### Persistent MongoDB storage (free Atlas tier)

Set `MONGODB_URI` to persist runs online. The app stores run metadata in
`jobs`, untouched and mapped property records in `properties`, and audit
reports in `artifacts`. Records are saved individually, which works for large
multi-thousand-property scrapes without putting an entire run in one MongoDB
document. JSON downloads automatically fall back to MongoDB when local files
are no longer present.

Create an Atlas Free cluster, create a database user, allow the scraper host's
IP address, and add these values to `.env` locally or to the host's secret
environment variables:

```bash
MONGODB_URI=mongodb+srv://username:password@cluster.example.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=property_vessel
MONGODB_REQUIRED=true
```

`GET /api/storage` reports whether the app is using MongoDB, `GET /api/jobs`
returns recent saved runs, and the authenticated `/api/dashboard` and
`/api/properties` routes supply the operations views. Without `MONGODB_URI`,
existing local filesystem and in-memory behavior continues to work.

The app runs locally because scraping needs Chrome, filesystem access, and your
private AI credentials. Keep `.env` private and do not expose port 3000 to the
public internet.

## Recommended workflow

Use `scrape` for normal production runs:

```bash
node scraper.js scrape --url 'https://agent-site.com/properties/sales' --max-pages 500
```

For a site that requires a location or exposes several regional searches, opt
into breadth crawling. This discovers same-site search routes from the page and
its XML sitemap, then scrapes each route and deduplicates their listings:

```bash
node scraper.js scrape --url 'https://agent-site.com/property/for-sale/in-york/' \
  --scope-discovery --max-scopes 50
```

Scope discovery is deliberately **not** the default: a working API-backed URL
stays on the fast, single-scope path unless you explicitly ask to expand
coverage. The crawler never invents a URL from a location dropdown. It reports
those options but only crawls routes that the site actually links or publishes
in its sitemap.

If the supplied URL produces no usable listings, scope discovery now runs
automatically as a safe fallback. It does **not** widen a successful filtered
search (for example, an address search), and it never automatically enables
the request-heavy sitemap-detail crawl.

It applies these strategies in order and only falls through when one cannot
produce a property-shaped record set:

1. **HTTP and embedded-state extraction.** Reads JSON embedded in the original
   response (`propertyData`, Next/Nuxt state, JSON script blocks, etc.), so it
   keeps working even if Chromium is unavailable.
2. **Known API pagination.** Detects Homeflow result payloads and requests
   every page through its `search.ljson` API while preserving the route's
   channel, sort order, and filters. Requests are rate-limited and retried for
   transient failures.
3. **Browser network capture.** When the original HTML has no useful state, it
   watches all XHR/fetch responses and accepts valid JSON by content rather
   than requiring a conventional `application/json` content type.
4. **Semantic HTML fallback.** Uses JSON-LD, microdata, then repeated listing
   cards. Organisation schema is explicitly rejected so an agency's logo block
   cannot be mistaken for a listing.

`--max-pages` is a safety cap (default: 500). If the cap is reached, the
command says so instead of silently reporting an incomplete result as done.

Every `scrape` run writes a companion report beside the output (for example
`data/example-com-listings.report.json`). It records the strategy used per
scope, pages fetched, reported total where available, failed scopes, and
whether the run is complete, incomplete, or partial. Use `--report-file` to
choose another location.

## Install

```bash
cd listing-scraper
npm install
```

Use it directly with `node scraper.js …`, or expose a proper command on your
machine while developing this project:

```bash
npm link
listing-scraper --help
```

## Usage

### 1. Scrape a listing page

```bash
node scraper.js scrape --url 'https://www.bridgfords.co.uk/properties/sales/most-recent-first/#/'
```

For Bridgfords/Homeflow, this discovers the initial `propertyData` object and
then paginates the public `search.ljson` response. To make a small test run:

```bash
node scraper.js scrape --url 'https://www.bridgfords.co.uk/properties/sales/most-recent-first/#/' --max-pages 2
```

The default output path is `data/<hostname>-listings.json`; pass
`--out-file path/to/file.json` to override it.

### 1b. Crawl location-bound or multiple search scopes

First inspect what the crawler can safely use as a scope:

```bash
node scraper.js discover-scopes --url 'https://agent-site.com/property/for-sale/in-york/'
```

Then run all discovered scopes. `--sitemap false` restricts discovery to links
on the supplied page, and `--max-scopes` is a safety cap:

```bash
node scraper.js scrape --url 'https://agent-site.com/property/for-sale/in-york/' \
  --scope-discovery --max-scopes 30 --sitemap false
```

This is appropriate for sites such as Linley & Simpson that only accept a
location route, or an Ashtons-style form URL whose parameters define one valid
search area. Overlapping areas are merged by stable listing ID/canonical URL.

If a site has no useful search routes at all but publishes individual property
URLs in its sitemap, use the explicit, capped detail fallback:

```bash
node scraper.js scrape --url 'https://agent-site.com/property/for-sale/in-york/' \
  --scope-discovery --sitemap-details --max-detail-pages 250
```

It is intentionally off by default because it makes one request per property.

### 1c. Enrich result cards from listing details

Use `--deep` when you need fields that search cards omit. It fetches canonical
same-site property pages at a small, rate-limited concurrency and only fills
missing fields; it never discards the already-collected search result. The
default limit is 100 detail pages, so set an explicit higher cap only when you
intend that load:

```bash
node scraper.js scrape --url 'https://agent-site.com/properties/sales' \
  --deep --max-detail-pages 500
```

### 2. Inspect API candidates manually (advanced)

```bash
node scraper.js discover --url https://agent-site.com/properties
```

This prints ranked candidate endpoints with their sample fields, e.g.:

```
1. [score 7/9] GET https://agent-site.com/api/v2/listings?page=1
   data path: data.results
   sample fields: id, title, price, bedrooms, bathrooms, address, images
```

If nothing is found, the site probably renders listings server-side with no
API — see **DOM fallback** below.

### 3. Extract a chosen API response (advanced)

Once you've confirmed the right endpoint from step 1:

```bash
node scraper.js extract --url https://agent-site.com/properties --match "/api/v2/listings"
```

`--match` is just a substring of the endpoint URL — enough to identify it,
not necessarily unique. If more than one response matches (e.g. a Strapi-style
backend firing a `/properties/count` call alongside the real `/properties`
listings call), extract scores every match the same way discover does and
picks the one that actually contains property-shaped records, logging the
others it saw in case it picked wrong.

This legacy lower-level command will:

- re-capture the best-matching response
- detect `page=N`-style pagination, or offset-style (`_start`, `offset`,
  `skip`) paired with whatever limit/page-size param is present, and keep
  incrementing by the right step until a page comes back empty. If a limit
  param is present but no offset param yet (common — the offset defaults to
  0 on page one and isn't included explicitly), it infers the likely param
  name from the limit key's naming convention and logs that it's a guess
- normalize every record onto a common schema (see below)
- write the result to `<agent-hostname>-listings.json` (e.g.
  `linleyandsimpson-co-uk-listings.json`) unless you override with `--outFile`

For cursor and infinite-scroll sites, prefer `scrape`: it can collect XHR
responses while activating the site's own load-more control.

### 4. DOM inspection (advanced)

```bash
node scraper.js discover-dom --url https://agent-site.com/properties
```

Looks for repeated elements containing price-like text (`£`, `$`, `€` +
digits) as a proxy for "listing cards", and reports which selector repeats
most. This is a starting point for writing a `page.evaluate()` extractor by
hand — it won't fully automate a server-rendered site the way the API path
does, since there's no structured payload to key off of.

## Normalized output schema

The scraper maps source fields onto this shape (see
`lib/constants.js` to extend the aliases):

```json
{
  "id": "...",
  "title": "...",
  "description": "...",
  "price": 0,
  "currency": "...",
  "bedrooms": 0,
  "bathrooms": 0,
  "sqft": 0,
  "propertyType": "...",
  "address": "...",
  "city": "...",
  "state": "...",
  "postcode": "...",
  "country": "...",
  "latitude": 0,
  "longitude": 0,
  "images": ["..."],
  "status": "...",
  "agentName": "...",
  "agentEmail": "...",
  "agentPhone": "...",
  "agentContact": "...",
  "contact": {
    "names": ["..."],
    "emails": ["..."],
    "phones": ["..."]
  },
  "sourceUrl": "...",
  "sourceSiteUrl": "https://agent-site.com/properties",
  "raw": { "...original untouched record..." }
}
```

`raw` is kept alongside the normalized fields so nothing is lost if a
site-specific field doesn't map cleanly. Public agent/branch contact data is
also extracted deterministically into `contact`; it is never entrusted to the
AI mapper. Duplicate records are merged field-by-field, including unioning
images and contacts, instead of dropping every version after the first.

Run the offline regression checks with `npm test`.

## AI mapping to your platform schema (OpenRouter/Qwen)

The normal scraper output remains available and is always saved as `raw` so a
mapping can be inspected or rerun. Opt into AI mapping only when you want a
platform import draft:

```bash
cp .env.example .env
# Put your real OPENROUTER_API_KEY in .env. Never commit this file.

node scraper.js scrape --url 'https://agent-site.com/properties/sales' \
  --ai-normalize --platform-only --out-file data/platform-import.json
```

`--ai-normalize` calls OpenRouter on the server side, using
`OPENROUTER_MODEL` defaults to `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, which chooses a live free
model rather than relying on a free model slug that may disappear. Free models
may be rate limited or temporarily unavailable, so this mode runs one request
at a time by default. Set `--ai-concurrency` only after moving to a
provider/plan that can support it. Use `--ai-model` to make a one-off model
override. If you add OpenRouter credits and specifically want Qwen, set the
model to `qwen/qwen3-8b` (without `:free`).

Without `--platform-only`, output retains the scraper record and adds a
`platform` property. This is the safest integration shape because it preserves
the source URL and untouched raw data next to the AI result. With
`--platform-only`, the output is an array of platform import drafts.

Each draft has the property fields supplied in the platform interface plus
platform-owned defaults:

```json
{
  "title": "3 bedroom flat in Lekki",
  "purpose": "rent",
  "price": 2500000,
  "amount": 2500000,
  "currency": "NGN",
  "bedrooms": 3,
  "images": ["https://..."],
  "isPaid": false,
  "isSold": false,
  "isArchive": false,
  "salesPlatform": "source-site.example",
  "_source": {
    "id": "source-listing-id",
    "url": "https://source-site.example/property/123",
    "contact": {
      "names": ["Source branch"],
      "emails": ["sales@source-site.example"],
      "phones": ["+44 20 7000 0000"]
    },
    "raw": { "...": "untouched source record" }
  },
  "_normalization": {
    "confidence": 0.91,
    "requiresReview": false
  }
}
```

Unknown scraped values are `null`, never zero, empty text, or invented data.
Every AI result is reconciled with deterministic source mappings afterward:
the model may fill gaps, but it cannot erase a source-backed title, price,
currency, media URL, description, or contact. `_source.raw` makes even
`--platform-only` output lossless; strip `_source` only at the final API
boundary if your platform validator rejects metadata fields, and archive it as
a sidecar first.
`_normalization.requiresReview` is true when important fields are missing,
confidence is below 0.8, validation fails, or OpenRouter returns an error.
Keep those drafts out of the automatic publish path until reviewed.

The model is sent a truncated, redacted public listing record. Seller identity,
email addresses, phone numbers, dates of birth, and public agent-contact fields
are removed before the request; public contacts are handled locally and added
back through `_source.contact`. It is also never allowed to choose platform-owned
flags such as `isPaid`, `isSold`, `isArchive`, or `profilePicture`.

The companion `*.report.json` now includes field coverage, contact coverage,
and a count of platform drafts needing review. This makes a scrape that
technically “completed” but produced thin records visible immediately.

The API endpoint accepts the same opt-in values:

```bash
curl -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://agent-site.com/properties/sales","aiNormalize":true,"platformOnly":true}'
```

### Normalize files you already scraped

You do not need to scrape old files again. The batch command reads only
top-level `*-listings.json` files, ignores `*.report.json`, and writes enriched
copies under `data/ai-normalized/` by default:

```bash
node scraper.js normalize-existing --data-dir data --max-records 50
```

It is resumable: run the same command again and it skips records that already
have a completed `platform` result. Use `--retry-failed` only for records whose
previous API request failed. To run one selected source file:

```bash
node scraper.js normalize-existing \
  --file data/aaronshohetproperty-com-listings.json \
  --out-dir data/ai-normalized \
  --max-records 14
```

The default cap of 50 is intentional for OpenRouter free-model accounts. It is
the total number of records processed in a run across every input file, not a
per-file limit. Your original files are never overwritten.

## Before running this against a live agent site

- **Confirm data ownership, not just page ownership.** If the agent's
  listings are pulled from an MLS/IDX feed, the feed provider (not just the
  agent) may have separate rules about where that data can be redisplayed.
  Worth a quick per-agent check so consent from the agent is actually
  sufficient.
- **Rate limit.** Don't hammer the pagination loop — add a delay between
  requests if the site has more than a handful of pages.
- **Respect `robots.txt` / ToS** on the agent's own site where applicable,
  even though they've consented — some sites' hosting platforms (e.g. a
  shared WordPress plugin vendor) have their own terms that sit above the
  individual agent's wishes.
- **Ask the agent for a login-gated export if one exists.** Many listing
  platforms (real estate CMS vendors) have an official CSV/API export for
  the site owner — that's more stable than scraping and worth checking for
  first, since scraping is inherently one broken frontend redesign away
  from needing maintenance.
