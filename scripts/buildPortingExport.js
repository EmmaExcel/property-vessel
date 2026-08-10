#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { MongoStore } = require('../lib/mongoStore');
const { AI_FIELDS } = require('../lib/platformNormalizer');
const { applyRecipeBatch } = require('../lib/mappingEngine');
const { loadCachedRecipe, hostnameSlug } = require('../lib/mappingGenerator');

const SOURCES = [
  'https://www.247propertyservices.co.uk/sales/',
  'https://www.aaronshohetproperty.com/property/for-sale/in-london/sortby-price-desc/',
  'https://www.abacusestates.com/property-for-sale',
  'https://www.bridgfords.co.uk/properties/sales/#/',
  'https://www.sinclairhammelton.co.uk/search/3.html?showstc=on&showsold=off&instruction_type=Sale&address_keyword=&minprice=&maxprice=&property_type=',
  'https://www.bella-properties.co.uk/properties-for-sale',
  'https://bellcoestates.com/property-search/',
  'https://blenheim.co.uk/buy',
];

const SYSTEM_FIELDS = ['justAddedExpiration', 'isPaid', 'isSold', 'salesPlatform', 'isArchive', 'profilePicture'];
const TITLE_NOISE = /properties?\s+archive|search\s+results?|\.st\d+\s*\{|fill\s*:|<svg|@keyframes/i;
const IMAGE_NOISE = /%3e\d+:https?:|https?:\/\/[^/]+\/https?:\/\/|blank\.gif|broadbandavailability|broadband(?:uk)?[-_]?badge/i;

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function importPayload(platform) {
  return Object.fromEntries([...Object.keys(AI_FIELDS), ...SYSTEM_FIELDS].map((field) => [field, platform[field] ?? null]));
}

function qualityIssues(platform) {
  const issues = [];
  if (!platform.title || TITLE_NOISE.test(platform.title)) issues.push('invalid title');
  if (!platform.address && !platform.location) issues.push('missing address/location');
  if (!(Number(platform.price) > 0)) issues.push('missing/invalid price');
  if (!platform.currency) issues.push('missing currency');
  if (!platform.typeOfProperty || platform.typeOfProperty === 'RealEstateListing') issues.push('missing/schematic property type');
  if (!platform.description || platform.description.length < 40) issues.push('missing/short description');
  if (!Array.isArray(platform.images) || !platform.images.length) issues.push('missing images');
  else if (platform.images.some((url) => !/^https?:\/\//i.test(url) || IMAGE_NOISE.test(url))) issues.push('invalid/noisy image URL');
  if (!/^https?:\/\//i.test(platform?._source?.url || '')) issues.push('missing source listing URL');
  return issues;
}

function mergeContacts(target, contact) {
  for (const field of ['names', 'emails', 'phones']) {
    for (const value of contact?.[field] || []) if (value && !target[field].includes(value)) target[field].push(value);
  }
}

async function latestRawBatch(properties, sourceUrl) {
  const latest = await properties.findOne(
    { sourceUrl, kind: 'raw' },
    { projection: { _id: 0, jobId: 1, savedAt: 1 }, sort: { savedAt: -1 } },
  );
  if (!latest) return null;
  const documents = await properties.find(
    { sourceUrl, kind: 'raw', jobId: latest.jobId },
    { projection: { _id: 0, record: 1 } },
  ).sort({ position: 1 }).toArray();
  return { jobId: latest.jobId, savedAt: latest.savedAt, records: documents.map((document) => document.record) };
}

async function main() {
  const store = new MongoStore();
  await store.connect();
  const properties = await store.collection('properties');
  const createdAt = new Date().toISOString();
  const exportJobId = `porting-${createdAt.replace(/\D/g, '').slice(0, 14)}`;
  const outputDir = path.resolve(process.argv[2] || path.join('deliverables', `nutlip-porting-${createdAt.slice(0, 10)}`));
  const readyCombined = [];
  const provenance = [];
  const agentContacts = {};
  const sourceReports = [];

  for (let resultIndex = 0; resultIndex < SOURCES.length; resultIndex += 1) {
    const sourceUrl = SOURCES[resultIndex];
    const rawBatch = await latestRawBatch(properties, sourceUrl);
    const recipe = loadCachedRecipe(sourceUrl);
    if (!rawBatch || !recipe) {
      sourceReports.push({
        sourceUrl,
        status: 'blocked',
        reason: !rawBatch ? 'No usable raw listings were recovered from the live source.' : 'No reviewed mapping recipe is available.',
        rawCount: rawBatch?.records.length || 0,
        readyCount: 0,
        blockedCount: rawBatch?.records.length || 0,
      });
      continue;
    }

    const mapped = applyRecipeBatch(rawBatch.records, recipe, sourceUrl).records.map((record) => record.platform);
    const ready = [];
    const blocked = [];
    const contacts = { names: [], emails: [], phones: [] };
    for (const platform of mapped) {
      const issues = qualityIssues(platform);
      mergeContacts(contacts, platform?._source?.contact);
      platform._normalization.qualityIssues = [...new Set([...(platform._normalization.qualityIssues || []), ...issues])];
      if (issues.length) {
        platform._normalization.publishReady = false;
        platform._normalization.requiresReview = true;
        blocked.push(platform);
      } else {
        platform._normalization.publishReady = true;
        platform._normalization.requiresReview = false;
        ready.push(platform);
      }
    }

    const dedupedReady = [...new Map(ready.map((platform) => [platform._source.url, platform])).values()];
    const importRecords = dedupedReady.map(importPayload);
    readyCombined.push(...importRecords);
    provenance.push(...dedupedReady);
    agentContacts[hostnameSlug(sourceUrl)] = contacts;
    writeJson(path.join(outputDir, 'by-source', `${hostnameSlug(sourceUrl)}.json`), importRecords);
    await store.saveRecords({ jobId: exportJobId, resultIndex, sourceUrl, kind: 'mapped', records: mapped });

    const imageCounts = dedupedReady.map((record) => record.images.length);
    const report = {
      sourceUrl,
      status: blocked.length ? (dedupedReady.length ? 'partial' : 'blocked') : 'ready',
      rawJobId: rawBatch.jobId,
      rawSavedAt: rawBatch.savedAt,
      rawCount: rawBatch.records.length,
      readyCount: dedupedReady.length,
      blockedCount: blocked.length,
      imageCoverage: {
        listingsWithImages: dedupedReady.length,
        totalImages: imageCounts.reduce((sum, count) => sum + count, 0),
        averageImages: imageCounts.length ? Number((imageCounts.reduce((sum, count) => sum + count, 0) / imageCounts.length).toFixed(1)) : 0,
        maximumImages: imageCounts.length ? Math.max(...imageCounts) : 0,
      },
      contactCoverage: contacts,
      blockedReasons: Object.entries(blocked.flatMap((record) => record._normalization.qualityIssues).reduce((counts, issue) => {
        counts[issue] = (counts[issue] || 0) + 1;
        return counts;
      }, {})).map(([issue, count]) => ({ issue, count })),
      note: sourceUrl.includes('247propertyservices')
        ? 'The live rerun was CAPTCHA-blocked; these are the latest preserved detail records, revalidated with the current schema and image rules.'
        : null,
    };
    sourceReports.push(report);
    await store.saveReport({ jobId: exportJobId, resultIndex, sourceUrl, report });
  }

  const combinedDeduped = [...new Map(readyCombined.map((record) => [
    `${record.salesPlatform}|${record.address}|${record.price}`.toLowerCase(), record,
  ])).values()];
  const qa = {
    exportJobId,
    generatedAt: createdAt,
    schema: 'Nutlip property import schema',
    gate: 'Only records with a clean title/address, positive price, currency, explicit property type, substantive description, valid images and source URL are included.',
    totals: {
      sourcesRequested: SOURCES.length,
      sourcesWithReadyData: sourceReports.filter((report) => report.readyCount > 0).length,
      rawRecordsAssessed: sourceReports.reduce((sum, report) => sum + (report.rawCount || 0), 0),
      portingReadyRecords: combinedDeduped.length,
      blockedRecords: sourceReports.reduce((sum, report) => sum + (report.blockedCount || 0), 0),
      images: combinedDeduped.reduce((sum, record) => sum + (record.images?.length || 0), 0),
    },
    sources: sourceReports,
  };

  writeJson(path.join(outputDir, 'nutlip-porting-ready.json'), combinedDeduped);
  writeJson(path.join(outputDir, 'nutlip-porting-ready-with-provenance.json'), provenance);
  writeJson(path.join(outputDir, 'agent-contacts-by-website.json'), agentContacts);
  writeJson(path.join(outputDir, 'quality-report.json'), qa);
  await store.saveJob({
    id: exportJobId,
    status: sourceReports.some((report) => report.status === 'blocked') ? 'partial' : 'completed',
    createdAt,
    startedAt: createdAt,
    completedAt: new Date().toISOString(),
    currentIndex: SOURCES.length,
    total: SOURCES.length,
    currentUrl: null,
    stage: 'completed',
    stageMessage: 'Porting-ready export built and quality-gated',
    sourceProgress: 100,
    error: null,
    results: sourceReports.map((report) => ({
      url: report.sourceUrl,
      count: report.readyCount,
      status: report.status,
      needsReview: report.blockedCount,
      importReady: report.readyCount,
      blockedFromImport: report.blockedCount,
      imageCoverage: report.imageCoverage || null,
    })),
    urls: SOURCES,
    options: { mode: 'reviewed-reusable-mapping', qualityGate: true },
  });
  await store.close();
  console.log(JSON.stringify({ outputDir, ...qa.totals }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
