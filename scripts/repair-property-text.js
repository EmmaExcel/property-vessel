const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { loadLocalEnv } = require('../lib/env');

loadLocalEnv();

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value || '').replace(/\/$/, '');
  }
}

function contaminated(value) {
  return /(?:\.st\d+\s*\{|fill\s*:|<svg|@keyframes|font-family\s*:)/i.test(String(value || ''));
}

function genericTitle(value) {
  return /^(?:under offer|sold(?:\s+stc)?|new instruction|for sale|to let)$/i.test(String(value || '').trim());
}

function invalidAddress(value) {
  const text = String(value || '').trim();
  return !text || contaminated(text) || /^\d{3}\s+/.test(text)
    || /^\d{2,3}\s+(?:this|nestled|located|a\s|an\s|the\s)/i.test(text);
}

function repairRecord(document, reference) {
  const record = structuredClone(document.record || {});
  let changed = false;
  const set = (target, key, value, shouldReplace) => {
    if (!value || !shouldReplace(target[key])) return;
    target[key] = value;
    changed = true;
  };

  if (document.kind === 'raw') {
    set(record, 'title', reference.title, (value) => !value || contaminated(value) || genericTitle(value));
    set(record, 'address', reference.address, invalidAddress);
    if (record.raw && typeof record.raw === 'object') {
      set(record.raw, 'title', reference.title, (value) => !value || contaminated(value) || genericTitle(value));
      set(record.raw, 'address', reference.address, invalidAddress);
    }
  } else {
    set(record, 'title', reference.title, (value) => !value || contaminated(value) || genericTitle(value));
    set(record, 'location', reference.address, (value) => !value || contaminated(value) || genericTitle(value));
    set(record, 'address', reference.address, invalidAddress);
    const sourceRaw = record._source?.raw;
    if (sourceRaw && typeof sourceRaw === 'object') {
      set(sourceRaw, 'title', reference.title, (value) => !value || contaminated(value) || genericTitle(value));
      set(sourceRaw, 'address', reference.address, invalidAddress);
      if (sourceRaw.raw && typeof sourceRaw.raw === 'object') {
        set(sourceRaw.raw, 'title', reference.title, (value) => !value || contaminated(value) || genericTitle(value));
        set(sourceRaw.raw, 'address', reference.address, invalidAddress);
      }
    }
    if (changed && record._normalization) {
      const warnings = Array.isArray(record._normalization.warnings) ? record._normalization.warnings : [];
      const note = 'Title/address repaired deterministically from the source listing card.';
      record._normalization.warnings = [...new Set([...warnings, note])];
    }
  }
  return { record, changed };
}

async function main() {
  const [referencePath, mode = '--dry-run'] = process.argv.slice(2);
  if (!referencePath) throw new Error('Usage: node scripts/repair-property-text.js <clean-reference.json> [--apply]');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured.');
  const references = JSON.parse(fs.readFileSync(path.resolve(referencePath), 'utf8'));
  const byUrl = new Map(references.map((record) => [canonicalUrl(record.sourceUrl), record]));
  const sourceSiteUrl = references[0]?.sourceSiteUrl;
  if (!sourceSiteUrl || !byUrl.size) throw new Error('The reference file has no source records.');

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    const collection = client.db(process.env.MONGODB_DB || 'property_vessel').collection('properties');
    const documents = await collection.find({ sourceUrl: sourceSiteUrl, kind: { $in: ['raw', 'mapped'] } }).toArray();
    const operations = [];
    const counts = { inspected: documents.length, matched: 0, changed: 0, raw: 0, mapped: 0, unmatched: 0 };
    for (const document of documents) {
      const recordUrl = document.kind === 'mapped' ? document.record?._source?.url : document.record?.sourceUrl;
      const reference = byUrl.get(canonicalUrl(recordUrl));
      if (!reference) {
        counts.unmatched += 1;
        continue;
      }
      counts.matched += 1;
      const repaired = repairRecord(document, reference);
      if (!repaired.changed) continue;
      counts.changed += 1;
      counts[document.kind] += 1;
      operations.push({ updateOne: { filter: { _id: document._id }, update: { $set: { record: repaired.record } } } });
    }
    if (mode === '--apply' && operations.length) await collection.bulkWrite(operations, { ordered: false });
    console.log(JSON.stringify({ mode: mode === '--apply' ? 'applied' : 'dry-run', sourceSiteUrl, referenceRecords: byUrl.size, ...counts }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
