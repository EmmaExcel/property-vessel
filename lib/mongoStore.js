const { MongoClient, ServerApiVersion } = require('mongodb');
const { loadLocalEnv } = require('./env');

loadLocalEnv();

const RETRY_DELAY_MS = 30_000;
const INSERT_BATCH_SIZE = 500;

class MongoStore {
  constructor({ uri = process.env.MONGODB_URI, database = process.env.MONGODB_DB || 'property_vessel' } = {}) {
    this.uri = uri;
    this.databaseName = database;
    this.client = null;
    this.db = null;
    this.connecting = null;
    this.lastError = null;
    this.retryAfter = 0;
  }

  get configured() {
    return Boolean(this.uri);
  }

  get connected() {
    return Boolean(this.db);
  }

  status() {
    return {
      configured: this.configured,
      connected: this.connected,
      database: this.configured ? this.databaseName : null,
      error: this.lastError,
    };
  }

  async connect() {
    if (!this.configured) return false;
    if (this.db) return true;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.retryAfter) throw new Error(this.lastError || 'MongoDB reconnect is pending.');

    this.connecting = (async () => {
      const client = new MongoClient(this.uri, {
        serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
        serverSelectionTimeoutMS: 8_000,
        maxPoolSize: 10,
      });
      try {
        await client.connect();
        const db = client.db(this.databaseName);
        await db.command({ ping: 1 });
        this.client = client;
        this.db = db;
        this.lastError = null;
        this.retryAfter = 0;
        await this.ensureIndexes();
        return true;
      } catch (error) {
        await client.close().catch(() => {});
        this.client = null;
        this.db = null;
        this.lastError = error.message;
        this.retryAfter = Date.now() + RETRY_DELAY_MS;
        throw error;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  async ensureIndexes() {
    await Promise.all([
      this.db.collection('jobs').createIndex({ createdAt: -1 }),
      this.db.collection('properties').createIndex(
        { jobId: 1, resultIndex: 1, kind: 1, position: 1 },
        { unique: true },
      ),
      this.db.collection('properties').createIndex({ sourceUrl: 1, kind: 1 }),
      this.db.collection('artifacts').createIndex(
        { jobId: 1, resultIndex: 1, kind: 1 },
        { unique: true },
      ),
    ]);
  }

  async collection(name) {
    await this.connect();
    return this.db.collection(name);
  }

  async markInterruptedJobs() {
    if (!this.configured) return;
    const jobs = await this.collection('jobs');
    const completedAt = new Date().toISOString();
    await jobs.updateMany(
      { status: { $in: ['queued', 'running'] } },
      {
        $set: {
          status: 'failed',
          error: 'The scraper server restarted before this run completed. Start a new run to retry it.',
          completedAt,
          updatedAt: completedAt,
        },
      },
    );
  }

  async saveJob(job) {
    if (!this.configured) return false;
    const jobs = await this.collection('jobs');
    await jobs.replaceOne(
      { _id: job.id },
      { _id: job.id, ...job, updatedAt: new Date().toISOString() },
      { upsert: true },
    );
    return true;
  }

  async getJob(id) {
    if (!this.configured) return null;
    const jobs = await this.collection('jobs');
    return jobs.findOne({ _id: id }, { projection: { _id: 0, urls: 0, options: 0, updatedAt: 0 } });
  }

  async listJobs(limit = 25) {
    if (!this.configured) return [];
    const jobs = await this.collection('jobs');
    return jobs.find(
      {},
      { projection: { _id: 0, urls: 0, options: 0, updatedAt: 0 } },
    ).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async getDashboardData() {
    if (!this.configured) return null;
    const jobs = await this.collection('jobs');
    const properties = await this.collection('properties');
    const [
      totalRuns,
      completedRuns,
      failedRuns,
      savedRecords,
      mappedRecords,
      recordsWithEmail,
      recordsWithPhone,
      recentJobs,
      sourceRows,
    ] = await Promise.all([
      jobs.countDocuments({}),
      jobs.countDocuments({ status: 'completed' }),
      jobs.countDocuments({ status: 'failed' }),
      properties.countDocuments({ kind: 'raw' }),
      properties.countDocuments({ kind: 'mapped' }),
      properties.countDocuments({ kind: 'raw', 'record.contact.emails.0': { $exists: true } }),
      properties.countDocuments({ kind: 'raw', 'record.contact.phones.0': { $exists: true } }),
      this.listJobs(8),
      jobs.aggregate([
        { $unwind: '$results' },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$results.url',
            runs: { $sum: 1 },
            totalRecords: { $sum: { $ifNull: ['$results.count', 0] } },
            latestCount: { $first: { $ifNull: ['$results.count', 0] } },
            latestStatus: { $first: '$results.status' },
            lastRunAt: { $first: '$createdAt' },
            contactCoverage: { $first: '$results.contactCoverage' },
          },
        },
        { $sort: { lastRunAt: -1 } },
        { $limit: 50 },
      ]).toArray(),
    ]);

    return {
      stats: {
        totalRuns,
        completedRuns,
        failedRuns,
        savedRecords,
        mappedRecords,
        recordsWithEmail,
        recordsWithPhone,
        sourceCount: sourceRows.length,
      },
      recentJobs,
      sources: sourceRows.map(({ _id, ...source }) => ({ url: _id, ...source })),
    };
  }

  async listProperties({ page = 1, limit = 25, kind = 'mapped', sourceUrl, search } = {}) {
    if (!this.configured) return { items: [], total: 0, page, limit };
    const properties = await this.collection('properties');
    const query = {};
    if (['raw', 'mapped'].includes(kind)) query.kind = kind;
    if (sourceUrl) query.sourceUrl = sourceUrl;
    if (search) {
      const escaped = String(search).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'i');
      query.$or = [
        { sourceUrl: pattern },
        { 'record.title': pattern },
        { 'record.address': pattern },
        { 'record.city': pattern },
      ];
    }

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      properties.find(query, {
        projection: {
          _id: 0,
          jobId: 1,
          resultIndex: 1,
          sourceUrl: 1,
          kind: 1,
          position: 1,
          savedAt: 1,
          'record.id': 1,
          'record.title': 1,
          'record.price': 1,
          'record.amount': 1,
          'record.currency': 1,
          'record.address': 1,
          'record.city': 1,
          'record.agentEmail': 1,
          'record.agentPhone': 1,
          'record.contact': 1,
          'record._source.contact': 1,
          'record._source.url': 1,
          'record._source.siteUrl': 1,
          'record.sourceUrl': 1,
        },
      }).sort({ savedAt: -1, jobId: -1, position: 1 }).skip(skip).limit(limit).toArray(),
      properties.countDocuments(query),
    ]);
    return { items, total, page, limit };
  }

  async listPropertySources({ kind = 'mapped', search } = {}) {
    if (!this.configured) return [];
    const properties = await this.collection('properties');
    const match = {};
    if (['raw', 'mapped'].includes(kind)) match.kind = kind;
    if (search) {
      const escaped = String(search).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'i');
      match.$or = [
        { sourceUrl: pattern },
        { 'record.title': pattern },
        { 'record.address': pattern },
        { 'record.city': pattern },
      ];
    }
    const rows = await properties.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$sourceUrl',
          count: { $sum: 1 },
          lastSavedAt: { $max: '$savedAt' },
          withEmail: {
            $sum: {
              $cond: [{ $or: [
                { $gt: [{ $size: { $ifNull: ['$record.contact.emails', []] } }, 0] },
                { $gt: [{ $size: { $ifNull: ['$record._source.contact.emails', []] } }, 0] },
                { $ne: [{ $ifNull: ['$record.agentEmail', ''] }, ''] },
              ] }, 1, 0],
            },
          },
          withPhone: {
            $sum: {
              $cond: [{ $or: [
                { $gt: [{ $size: { $ifNull: ['$record.contact.phones', []] } }, 0] },
                { $gt: [{ $size: { $ifNull: ['$record._source.contact.phones', []] } }, 0] },
                { $ne: [{ $ifNull: ['$record.agentPhone', ''] }, ''] },
              ] }, 1, 0],
            },
          },
        },
      },
      { $sort: { lastSavedAt: -1, _id: 1 } },
    ]).toArray();
    return rows.map(({ _id, ...row }) => ({ url: _id, ...row }));
  }

  async saveRecords({ jobId, resultIndex, sourceUrl, kind, records }) {
    if (!this.configured) return false;
    const properties = await this.collection('properties');
    await properties.deleteMany({ jobId, resultIndex, kind });
    const savedAt = new Date();
    for (let offset = 0; offset < records.length; offset += INSERT_BATCH_SIZE) {
      const documents = records.slice(offset, offset + INSERT_BATCH_SIZE).map((record, batchIndex) => ({
        jobId,
        resultIndex,
        sourceUrl,
        kind,
        position: offset + batchIndex,
        savedAt,
        record,
      }));
      if (documents.length) await properties.insertMany(documents, { ordered: false });
    }
    return true;
  }

  async saveReport({ jobId, resultIndex, sourceUrl, report }) {
    if (!this.configured || !report) return false;
    const artifacts = await this.collection('artifacts');
    await artifacts.replaceOne(
      { jobId, resultIndex, kind: 'report' },
      { jobId, resultIndex, kind: 'report', sourceUrl, savedAt: new Date(), data: report },
      { upsert: true },
    );
    return true;
  }

  async writeRecordsJson(response, { jobId, resultIndex, kind }) {
    if (!this.configured) return false;
    const properties = await this.collection('properties');
    const count = await properties.countDocuments({ jobId, resultIndex, kind });
    if (!count) return false;

    response.write('[\n');
    let first = true;
    const cursor = properties.find(
      { jobId, resultIndex, kind },
      { projection: { _id: 0, record: 1 } },
    ).sort({ position: 1 });
    for await (const document of cursor) {
      if (!first) response.write(',\n');
      response.write(JSON.stringify(document.record, null, 2));
      first = false;
    }
    response.end('\n]\n');
    return true;
  }

  async getReport({ jobId, resultIndex }) {
    if (!this.configured) return null;
    const artifacts = await this.collection('artifacts');
    const document = await artifacts.findOne({ jobId, resultIndex, kind: 'report' });
    return document?.data || null;
  }

  async close() {
    await this.client?.close();
    this.client = null;
    this.db = null;
  }
}

module.exports = { MongoStore };
