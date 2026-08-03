const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const scrape = require('./commands/scrape');
const { MongoStore } = require('./lib/mongoStore');
const { defaultOutFileName } = require('./lib/utils');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 3000;
const MAX_URLS_PER_JOB = 10;
const MAX_ACTIVE_JOBS = positiveInteger(process.env.MAX_ACTIVE_JOBS, 1, 3);
const jobs = new Map();
const mongo = new MongoStore();

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function requireAuthentication(req, res, next) {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;
  if (!username && !password) return next();
  if (!username || !password) return res.status(503).json({ error: 'Application authentication is misconfigured.' });
  if (req.path === '/api/health') return next();

  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const separator = Buffer.from(encoded, 'base64').toString('utf8').indexOf(':');
    if (separator >= 0) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const suppliedUsername = decoded.slice(0, separator);
      const suppliedPassword = decoded.slice(separator + 1);
      if (safeEqual(suppliedUsername, username) && safeEqual(suppliedPassword, password)) return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Property Vessel", charset="UTF-8"');
  return res.status(401).send('Authentication required.');
}

app.use(requireAuthentication);
app.use(express.static(path.join(__dirname, 'public')));

function enabled(value) {
  return value === true || value === 'true';
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function validateUrls(value) {
  const input = Array.isArray(value) ? value : [value];
  const urls = [...new Set(input.map((item) => String(item || '').trim()).filter(Boolean))];
  if (!urls.length) throw new Error('Add at least one listing-page URL.');
  if (urls.length > MAX_URLS_PER_JOB) throw new Error(`A run can contain at most ${MAX_URLS_PER_JOB} URLs.`);
  for (const item of urls) {
    const parsed = new URL(item);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Unsupported URL: ${item}`);
  }
  return urls;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    currentIndex: job.currentIndex,
    total: job.urls.length,
    currentUrl: job.currentUrl,
    error: job.error,
    results: job.results.map(({ files, ...result }) => result),
  };
}

function storedJob(job) {
  return {
    ...publicJob(job),
    urls: job.urls,
    options: job.options,
  };
}

async function persistJob(job) {
  if (!mongo.configured) return;
  try {
    await mongo.saveJob(storedJob(job));
  } catch (error) {
    console.warn(`MongoDB job persistence failed: ${error.message}`);
  }
}

async function persistResult({ job, resultIndex, url, rawPath, records, isAiRun, report }) {
  if (!mongo.configured) return;
  try {
    const rawRecords = fs.existsSync(rawPath) ? JSON.parse(fs.readFileSync(rawPath, 'utf8')) : records;
    await mongo.saveRecords({ jobId: job.id, resultIndex, sourceUrl: url, kind: 'raw', records: rawRecords });
    if (isAiRun) {
      await mongo.saveRecords({ jobId: job.id, resultIndex, sourceUrl: url, kind: 'mapped', records });
    }
    await mongo.saveReport({ jobId: job.id, resultIndex, sourceUrl: url, report });
  } catch (error) {
    console.warn(`MongoDB listing persistence failed: ${error.message}`);
  }
}

function downloadUrl(jobId, resultIndex, kind) {
  return `/api/jobs/${jobId}/download/${resultIndex}/${kind}`;
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  await persistJob(job);
  const runDir = path.resolve(__dirname, 'data', 'runs', job.id);
  fs.mkdirSync(runDir, { recursive: true });

  try {
    for (let index = 0; index < job.urls.length; index += 1) {
      const url = job.urls[index];
      job.currentIndex = index;
      job.currentUrl = url;
      const filename = path.basename(defaultOutFileName(url));
      const rawPath = path.join(runDir, filename);
      const mappedPath = path.join(runDir, 'ai-normalized', filename);
      const isAiRun = job.options.aiMap || job.options.aiNormalize;

      const records = await scrape({
        url,
        outFile: rawPath,
        maxPages: job.options.maxPages,
        deep: job.options.deep,
        maxDetailPages: job.options.maxDetailPages,
        scopeDiscovery: job.options.scopeDiscovery,
        maxScopes: job.options.maxScopes,
        sitemap: job.options.sitemap,
        sitemapDetails: job.options.sitemapDetails,
        aiMap: job.options.aiMap,
        aiNormalize: job.options.aiNormalize,
        platformOnly: job.options.platformOnly,
        aiModel: job.options.aiModel,
        aiConcurrency: job.options.aiConcurrency,
        mappingsDir: path.resolve(__dirname, 'data', 'mappings'),
        forceRegenerate: job.options.forceRegenerate,
      });

      const finalPath = isAiRun ? mappedPath : rawPath;
      const reportPath = finalPath.replace(/\.json$/i, '.report.json');
      const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
      const resultIndex = job.results.length;
      job.results.push({
        url,
        count: records.length,
        status: report?.status || 'complete',
        needsReview: report?.quality?.needsReview || 0,
        contactCoverage: report?.quality?.contactCoverage || null,
        downloads: {
          raw: downloadUrl(job.id, resultIndex, 'raw'),
          mapped: isAiRun ? downloadUrl(job.id, resultIndex, 'mapped') : null,
          report: fs.existsSync(reportPath) ? downloadUrl(job.id, resultIndex, 'report') : null,
        },
        files: { rawPath, mappedPath: isAiRun ? mappedPath : null, reportPath },
      });
      await persistResult({ job, resultIndex, url, rawPath, records, isAiRun, report });
      await persistJob(job);
    }
    job.currentIndex = job.urls.length;
    job.currentUrl = null;
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    await persistJob(job);
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    await persistJob(job);
  }
}

app.post('/api/jobs', async (req, res) => {
  try {
    const activeJobs = [...jobs.values()].filter((job) => ['queued', 'running'].includes(job.status));
    if (activeJobs.length >= MAX_ACTIVE_JOBS) {
      return res.status(409).json({ error: 'A scraper run is already active. Wait for it to finish before starting another.' });
    }
    const urls = validateUrls(req.body.urls || req.body.url);
    const aiMode = req.body.aiMode || 'map';
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const job = {
      id,
      urls,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      currentIndex: 0,
      currentUrl: null,
      error: null,
      results: [],
      options: {
        deep: req.body.deep !== false,
        maxPages: positiveInteger(req.body.maxPages, 500, 1000),
        maxDetailPages: positiveInteger(req.body.maxDetailPages, 100, 5000),
        scopeDiscovery: req.body.scopeDiscovery === true ? true : false,
        maxScopes: positiveInteger(req.body.maxScopes, 50, 200),
        sitemap: req.body.sitemap !== false,
        sitemapDetails: enabled(req.body.sitemapDetails),
        aiMap: aiMode === 'map',
        aiNormalize: aiMode === 'record',
        platformOnly: aiMode !== 'none' && req.body.platformOnly !== false,
        aiModel: req.body.aiModel || undefined,
        aiConcurrency: positiveInteger(req.body.aiConcurrency, 1, 3),
        forceRegenerate: enabled(req.body.forceRegenerate),
      },
    };
    jobs.set(id, job);
    await persistJob(job);
    setImmediate(() => runJob(job));
    res.status(202).json(publicJob(job));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    if (mongo.configured) return res.json(await mongo.listJobs(positiveInteger(req.query.limit, 25, 100)));
    return res.json([...jobs.values()].map(publicJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  } catch (error) {
    return res.status(503).json({ error: `Could not read saved runs: ${error.message}` });
  }
});

app.get('/api/storage', (_req, res) => {
  res.json({ mode: mongo.connected ? 'mongodb' : 'local', mongodb: mongo.status() });
});

app.get('/api/health', (_req, res) => {
  const healthy = !enabled(process.env.MONGODB_REQUIRED) || mongo.connected;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    storage: mongo.connected ? 'mongodb' : 'local',
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) return res.json(publicJob(job));
  try {
    const stored = await mongo.getJob(req.params.id);
    if (!stored) return res.status(404).json({ error: 'Run not found.' });
    return res.json(stored);
  } catch (error) {
    return res.status(503).json({ error: `Could not read the saved run: ${error.message}` });
  }
});

app.get('/api/jobs/:id/download/:index/:kind', async (req, res) => {
  const job = jobs.get(req.params.id);
  const resultIndex = Number(req.params.index);
  const kind = req.params.kind;
  if (!Number.isInteger(resultIndex) || resultIndex < 0 || !['raw', 'mapped', 'report'].includes(kind)) {
    return res.status(400).json({ error: 'Invalid download request.' });
  }

  const result = job?.results[resultIndex];
  const paths = result ? { raw: result.files.rawPath, mapped: result.files.mappedPath, report: result.files.reportPath } : {};
  const target = paths[kind];
  if (target && fs.existsSync(target)) return res.download(target);

  try {
    res.attachment(`${req.params.id}-${resultIndex}-${kind}.json`);
    res.type('application/json');
    if (kind === 'report') {
      const report = await mongo.getReport({ jobId: req.params.id, resultIndex });
      if (!report) return res.status(404).json({ error: 'Run report not found.' });
      return res.send(JSON.stringify(report, null, 2));
    }
    const written = await mongo.writeRecordsJson(res, { jobId: req.params.id, resultIndex, kind });
    if (!written && !res.headersSent) return res.status(404).json({ error: 'Run output not found.' });
    return undefined;
  } catch (error) {
    if (res.headersSent) return res.end();
    return res.status(503).json({ error: `Could not download saved data: ${error.message}` });
  }
});

// Backwards-compatible synchronous endpoint for existing integrations.
app.post('/scrape', async (req, res) => {
  if (!req.body.url) return res.status(400).json({ error: 'url parameter is required' });
  try {
    const listings = await scrape({
      ...req.body,
      deep: enabled(req.body.deep),
      aiNormalize: enabled(req.body.aiNormalize),
      aiMap: enabled(req.body.aiMap),
      platformOnly: enabled(req.body.platformOnly),
      skipWrite: true,
    });
    return res.json({ success: true, count: listings.length, data: listings });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  if (mongo.configured) {
    try {
      await mongo.connect();
      await mongo.markInterruptedJobs();
      console.log(`MongoDB persistence: ${mongo.databaseName}`);
    } catch (error) {
      console.warn(`MongoDB unavailable; continuing with local storage (${error.message})`);
      if (enabled(process.env.MONGODB_REQUIRED)) throw error;
    }
  } else {
    console.log('MongoDB persistence: disabled (set MONGODB_URI to enable)');
  }

  app.listen(PORT, () => {
    console.log(`Property scraper web app: http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { app, start, mongo };
