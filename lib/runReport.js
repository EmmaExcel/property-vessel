const fs = require('fs');
const path = require('path');

function defaultReportFileName(outFile) {
  const parsed = path.parse(outFile);
  return path.join(parsed.dir, `${parsed.name}.report.json`);
}

function writeRunReport(report, outFile, reportFile) {
  const target = path.resolve(reportFile || defaultReportFileName(outFile));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote run report to ${reportFile || defaultReportFileName(outFile)}`);
  return target;
}

function buildRunReport({ sourceUrl, startedAt, scopes, records, outputFile }) {
  const failed = scopes.filter((scope) => scope.status === 'failed');
  const incomplete = scopes.filter((scope) => scope.complete === false);
  const expectedListingsReported = scopes.reduce((total, scope) => total + (Number(scope.expectedListings) || 0), 0) || null;
  const status = failed.length ? 'partial' : incomplete.length ? 'incomplete' : 'complete';
  const fields = ['id', 'title', 'price', 'currency', 'address', 'bedrooms', 'bathrooms', 'images', 'description', 'sourceUrl'];
  const present = (value) => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
  const sourceRecord = (record) => {
    const source = record.platform?._source || record._source;
    return source ? { ...record, ...source, sourceUrl: source.url || record.sourceUrl } : record;
  };
  const fieldCoverage = Object.fromEntries(fields.map((field) => {
    const count = records.filter((record) => present(sourceRecord(record)[field])).length;
    return [field, { count, percent: records.length ? Number((count * 100 / records.length).toFixed(1)) : 0 }];
  }));
  const contacts = records.map(sourceRecord).map((record) => record.contact || {});
  const contactCoverage = {
    withAnyContact: contacts.filter((contact) => contact.emails?.length || contact.phones?.length).length,
    withEmail: contacts.filter((contact) => contact.emails?.length).length,
    withPhone: contacts.filter((contact) => contact.phones?.length).length,
  };

  return {
    status,
    sourceUrl,
    startedAt,
    completedAt: new Date().toISOString(),
    outputFile,
    uniqueListings: records.length,
    // Across several location scopes, reported totals can overlap. Keep the
    // aggregate as evidence, but never present it as a deduplicated expected count.
    expectedListings: scopes.length === 1 ? expectedListingsReported : null,
    expectedListingsReported,
    scopesCompleted: scopes.filter((scope) => scope.status === 'complete' && scope.complete !== false).length,
    scopesIncomplete: incomplete.length,
    scopesFailed: failed.length,
    quality: {
      fieldCoverage,
      contactCoverage,
      needsReview: records.filter((record) => record.platform?._normalization?.requiresReview).length,
    },
    scopes,
  };
}

module.exports = {
  defaultReportFileName,
  writeRunReport,
  buildRunReport,
};
