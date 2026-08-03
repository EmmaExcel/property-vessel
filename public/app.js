const elements = {
  loginScreen: document.querySelector('#login-screen'),
  loginForm: document.querySelector('#login-form'),
  loginError: document.querySelector('#login-error'),
  appShell: document.querySelector('#app-shell'),
  logoutButton: document.querySelector('#logout-button'),
  userPill: document.querySelector('#user-pill'),
  pageTitle: document.querySelector('#page-title'),
  pageKicker: document.querySelector('#page-kicker'),
  globalError: document.querySelector('#global-error'),
  metricGrid: document.querySelector('#metric-grid'),
  recentRuns: document.querySelector('#recent-runs'),
  sourceSummary: document.querySelector('#source-summary'),
  sourcesGrid: document.querySelector('#sources-grid'),
  sourceCountChip: document.querySelector('#source-count-chip'),
  historyList: document.querySelector('#history-list'),
  storageDot: document.querySelector('#storage-dot'),
  storageLabel: document.querySelector('#storage-label'),
  storageCopy: document.querySelector('#storage-copy'),
  runForm: document.querySelector('#run-form'),
  submitButton: document.querySelector('#submit-button'),
  formError: document.querySelector('#form-error'),
  emptyState: document.querySelector('#empty-state'),
  jobState: document.querySelector('#job-state'),
  statusBadge: document.querySelector('#status-badge'),
  progressCopy: document.querySelector('#progress-copy'),
  progressPercent: document.querySelector('#progress-percent'),
  progressBar: document.querySelector('#progress-bar'),
  currentUrl: document.querySelector('#current-url'),
  results: document.querySelector('#results'),
  dataFilters: document.querySelector('#data-filters'),
  propertySearch: document.querySelector('#property-search'),
  propertyKind: document.querySelector('#property-kind'),
  propertyGroups: document.querySelector('#property-groups'),
  selectedSourceName: document.querySelector('#selected-source-name'),
  selectedSourceCount: document.querySelector('#selected-source-count'),
  propertyRows: document.querySelector('#property-rows'),
  recordCountChip: document.querySelector('#record-count-chip'),
  previousPage: document.querySelector('#previous-page'),
  nextPage: document.querySelector('#next-page'),
  pageCopy: document.querySelector('#page-copy'),
  nutlipCountChip: document.querySelector('#nutlip-count-chip'),
  nutlipSourceList: document.querySelector('#nutlip-source-list'),
  nutlipRecordList: document.querySelector('#nutlip-record-list'),
  nutlipPrevious: document.querySelector('#nutlip-previous'),
  nutlipNext: document.querySelector('#nutlip-next'),
  nutlipPageCopy: document.querySelector('#nutlip-page-copy'),
  nutlipEmpty: document.querySelector('#nutlip-empty'),
  nutlipDetail: document.querySelector('#nutlip-detail'),
  nutlipTitle: document.querySelector('#nutlip-title'),
  nutlipQuality: document.querySelector('#nutlip-quality'),
  nutlipFields: document.querySelector('#nutlip-fields'),
  nutlipJson: document.querySelector('#nutlip-json'),
  copyNutlip: document.querySelector('#copy-nutlip'),
  downloadNutlip: document.querySelector('#download-nutlip'),
};

const viewNames = {
  overview: ['Operations', 'Overview'],
  scrape: ['Collection', 'New scrape'],
  history: ['Audit trail', 'Run history'],
  sources: ['Coverage', 'Source websites'],
  data: ['MongoDB', 'Data library'],
  nutlip: ['Platform schema', 'Nutlip output'],
};

let dashboardData = null;
let pollTimer = null;
let propertyPage = 1;
let propertyTotal = 0;
let selectedPropertySource = '';
const propertyLimit = 25;
let nutlipSource = '';
let nutlipPage = 1;
let nutlipTotal = 0;
let nutlipGroups = [];
let selectedNutlipRecord = null;
const nutlipLimit = 20;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return value || 'Unknown source'; }
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-GB').format(Number(value) || 0);
}

function formatDate(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatPrice(record) {
  const amount = record.price ?? record.amount;
  if (amount === null || amount === undefined || amount === '') return 'Not stated';
  if (typeof amount === 'string' && /[^\d.,]/.test(amount)) return amount;
  const number = Number(String(amount).replace(/,/g, ''));
  if (!Number.isFinite(number)) return String(amount);
  const currency = String(record.currency || 'GBP').toUpperCase();
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(number); } catch { return `${currency} ${formatNumber(number)}`; }
}

function totalRecords(job) {
  return (job.results || []).reduce((sum, result) => sum + (Number(result.count) || 0), 0);
}

function contactCoverage(job) {
  return (job.results || []).reduce((coverage, result) => ({
    withEmail: coverage.withEmail + (Number(result.contactCoverage?.withEmail) || 0),
    withPhone: coverage.withPhone + (Number(result.contactCoverage?.withPhone) || 0),
  }), { withEmail: 0, withPhone: 0 });
}

function showError(message) {
  elements.globalError.textContent = message || '';
  elements.globalError.classList.toggle('hidden', !message);
}

function showLogin() {
  clearTimeout(pollTimer);
  elements.appShell.classList.add('hidden');
  elements.loginScreen.classList.remove('hidden');
  document.querySelector('#login-username').focus();
}

function showApp(username) {
  elements.userPill.textContent = username || 'private user';
  elements.loginScreen.classList.add('hidden');
  elements.appShell.classList.remove('hidden');
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  if (response.status === 401) {
    showLogin();
    throw new Error('Your session has ended. Sign in again.');
  }
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error || body || 'The request could not be completed.');
  return body;
}

function switchView(view) {
  const selected = viewNames[view] ? view : 'overview';
  document.querySelectorAll('[data-view-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.viewPanel === selected));
  document.querySelectorAll('.nav-item[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === selected));
  [elements.pageKicker.textContent, elements.pageTitle.textContent] = viewNames[selected];
  showError('');
  if (selected === 'history') loadHistory();
  if (selected === 'sources' && dashboardData) renderSources(dashboardData.sources || []);
  if (selected === 'data') loadPropertyGroups();
  if (selected === 'nutlip') loadNutlipSources();
}

function metricCard(label, value, note) {
  return `<article class="metric-card"><div class="metric-top"><span>${escapeHtml(label)}</span></div><strong class="metric-value">${formatNumber(value)}</strong><span class="metric-note">${escapeHtml(note)}</span></article>`;
}

function renderRecentRuns(jobs) {
  if (!jobs.length) {
    elements.recentRuns.innerHTML = '<div class="inline-empty">No scraper runs yet.</div>';
    return;
  }
  elements.recentRuns.innerHTML = jobs.slice(0, 6).map((job) => {
    const firstUrl = job.results?.[0]?.url || job.currentUrl || 'Run preparing';
    const count = totalRecords(job);
    return `<article class="activity-row"><div class="activity-main"><strong title="${escapeHtml(firstUrl)}">${escapeHtml(hostname(firstUrl))}</strong><small>${escapeHtml(formatDate(job.createdAt))} · <span class="status-dot ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span></small></div><strong class="row-count">${formatNumber(count)}</strong></article>`;
  }).join('');
}

function renderSourceSummary(sources) {
  if (!sources.length) {
    elements.sourceSummary.innerHTML = '<div class="inline-empty">Sources appear after the first completed run.</div>';
    return;
  }
  elements.sourceSummary.innerHTML = sources.slice(0, 6).map((source) => `<article class="source-row"><div class="source-main"><strong title="${escapeHtml(source.url)}">${escapeHtml(hostname(source.url))}</strong><small>${formatNumber(source.runs)} run${source.runs === 1 ? '' : 's'} · ${escapeHtml(formatDate(source.lastRunAt))}</small></div><strong class="row-count">${formatNumber(source.latestCount)}</strong></article>`).join('');
}

function renderSources(sources) {
  elements.sourceCountChip.textContent = `${formatNumber(sources.length)} source${sources.length === 1 ? '' : 's'}`;
  if (!sources.length) {
    elements.sourcesGrid.innerHTML = '<div class="inline-empty">No source websites have been saved yet.</div>';
    return;
  }
  elements.sourcesGrid.innerHTML = sources.map((source) => {
    const domain = hostname(source.url);
    const email = source.contactCoverage?.withEmail || 0;
    const phone = source.contactCoverage?.withPhone || 0;
    return `<article class="source-card"><div class="source-card-top"><h4 title="${escapeHtml(domain)}">${escapeHtml(domain)}</h4><span class="status-dot ${escapeHtml(source.latestStatus)}">${escapeHtml(source.latestStatus || 'unknown')}</span></div><span class="source-url" title="${escapeHtml(source.url)}">${escapeHtml(source.url)}</span><div class="source-metrics"><div><strong>${formatNumber(source.latestCount)}</strong><small>Latest</small></div><div><strong>${formatNumber(email)}</strong><small>Emails</small></div><div><strong>${formatNumber(phone)}</strong><small>Phones</small></div></div><div class="source-last">${formatNumber(source.runs)} total runs · Last ${escapeHtml(formatDate(source.lastRunAt))}</div></article>`;
  }).join('');
}

async function loadDashboard() {
  try {
    const data = await api('/api/dashboard');
    dashboardData = data;
    const stats = data.stats || {};
    elements.metricGrid.innerHTML = [
      metricCard('Raw records', stats.savedRecords, `${formatNumber(stats.sourceCount)} source websites`),
      metricCard('Platform mapped', stats.mappedRecords, 'Schema-ready records'),
      metricCard('Emails preserved', stats.recordsWithEmail, 'Raw records with email'),
      metricCard('Phones preserved', stats.recordsWithPhone, `${formatNumber(stats.completedRuns)} completed runs`),
    ].join('');
    renderRecentRuns(data.recentJobs || []);
    renderSourceSummary(data.sources || []);
    renderSources(data.sources || []);
    const active = (data.recentJobs || []).find((job) => ['queued', 'running'].includes(job.status));
    if (active) {
      renderJob(active);
      pollJob(active.id);
    }
  } catch (error) {
    showError(error.message);
  }
}

async function loadStorage() {
  try {
    const storage = await api('/api/storage');
    const usingMongo = storage.mode === 'mongodb';
    elements.storageDot.classList.toggle('online', usingMongo);
    elements.storageLabel.textContent = usingMongo ? 'MongoDB connected' : 'Local storage';
    elements.storageCopy.textContent = usingMongo ? (storage.mongodb.database || 'Persistent database') : 'Files on this server';
  } catch (error) {
    elements.storageLabel.textContent = 'Storage unavailable';
    elements.storageCopy.textContent = error.message;
  }
}

function renderResults(items) {
  elements.results.innerHTML = items.map((item) => {
    const contacts = item.contactCoverage ? `${item.contactCoverage.withEmail || 0} email · ${item.contactCoverage.withPhone || 0} phone` : 'Contact audit unavailable';
    const links = Object.entries(item.downloads || {}).filter(([, url]) => url).map(([kind, url]) => `<a href="${escapeHtml(url)}">${kind === 'mapped' ? 'Platform JSON' : kind === 'raw' ? 'Raw JSON' : 'Run report'}</a>`).join('');
    return `<article class="result-card"><div class="result-top"><h4 title="${escapeHtml(item.url)}">${escapeHtml(hostname(item.url))}</h4><span class="count">${formatNumber(item.count)} records</span></div><div class="result-meta"><span>${escapeHtml(item.status)}</span><span>${escapeHtml(contacts)}</span><span>${formatNumber(item.needsReview)} review</span></div><div class="downloads">${links}</div></article>`;
  }).join('');
}

function renderJob(job) {
  elements.emptyState.classList.add('hidden');
  elements.jobState.classList.remove('hidden');
  const finished = ['completed', 'partial', 'failed'].includes(job.status);
  const sourceFraction = Math.max(0, Math.min(100, Number(job.sourceProgress) || 0)) / 100;
  const progress = job.total ? Math.round(((job.currentIndex + (finished ? 0 : sourceFraction)) / job.total) * 100) : 0;
  const percent = ['completed', 'partial'].includes(job.status) ? 100 : Math.min(progress, 96);
  elements.statusBadge.textContent = job.status;
  elements.statusBadge.className = `status-badge ${job.status}`;
  elements.progressBar.style.width = `${percent}%`;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressCopy.textContent = job.status === 'completed' ? `${job.results.length} source${job.results.length === 1 ? '' : 's'} completed` : job.status === 'partial' ? 'Run completed with some source errors' : job.status === 'failed' ? 'Run stopped' : `${job.stageMessage || 'Working'} · Source ${Math.min(job.currentIndex + 1, job.total)} of ${job.total}`;
  const elapsedMinutes = job.startedAt ? Math.max(1, Math.floor((Date.now() - new Date(job.startedAt).getTime()) / 60_000)) : 0;
  elements.currentUrl.textContent = job.error || (job.currentUrl ? `${job.currentUrl}${!finished ? ` · ${elapsedMinutes} min elapsed` : ''}` : (job.status === 'completed' ? 'Outputs are saved and ready to download.' : 'Preparing the first source…'));
  renderResults(job.results || []);
  elements.submitButton.disabled = !finished;
  elements.submitButton.querySelector('span').textContent = finished ? 'Start another run' : 'Scrape in progress…';
}

async function pollJob(id) {
  clearTimeout(pollTimer);
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    renderJob(job);
    if (!['completed', 'partial', 'failed'].includes(job.status)) {
      pollTimer = setTimeout(() => pollJob(id), 1500);
    } else {
      await Promise.all([loadDashboard(), loadStorage()]);
    }
  } catch (error) {
    elements.formError.textContent = error.message;
    elements.submitButton.disabled = false;
  }
}

async function loadHistory() {
  elements.historyList.innerHTML = '<tr><td colspan="6">Loading run history…</td></tr>';
  try {
    const jobs = await api('/api/jobs?limit=50');
    if (!jobs.length) {
      elements.historyList.innerHTML = '<tr><td colspan="6">No saved runs yet.</td></tr>';
      return;
    }
    elements.historyList.innerHTML = jobs.map((job) => {
      const source = job.results?.[0]?.url || job.currentUrl || 'Run without completed source';
      const sourceCount = Math.max(job.results?.length || 0, job.total || 0);
      const coverage = contactCoverage(job);
      const downloads = (job.results || []).flatMap((result) => Object.entries(result.downloads || {}).filter(([, url]) => url).map(([kind, url]) => ({ kind, url })));
      const moreSources = sourceCount > 1 ? ` +${sourceCount - 1} more` : '';
      return `<tr><td class="history-main"><strong title="${escapeHtml(source)}">${escapeHtml(hostname(source))}${escapeHtml(moreSources)}</strong><small>Run ${escapeHtml(job.id)}</small></td><td>${escapeHtml(formatDate(job.createdAt))}</td><td><strong>${formatNumber(totalRecords(job))}</strong></td><td class="history-contact"><span>${formatNumber(coverage.withEmail)} email</span><span>${formatNumber(coverage.withPhone)} phone</span></td><td><span class="status-label ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>${job.error ? `<small class="history-error" title="${escapeHtml(job.error)}">${escapeHtml(job.error)}</small>` : ''}</td><td><div class="history-actions">${downloads.slice(0, 3).map(({ kind, url }) => `<a href="${escapeHtml(url)}">${kind === 'mapped' ? 'Mapped' : kind === 'raw' ? 'Raw' : 'Report'}</a>`).join('') || '<span>—</span>'}</div></td></tr>`;
    }).join('');
  } catch (error) {
    elements.historyList.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;
  }
}

function firstContact(record, type) {
  const singular = type === 'emails' ? record.agentEmail : record.agentPhone;
  const direct = record.contact?.[type]?.[0];
  const source = record._source?.contact?.[type]?.[0];
  return singular || direct || source || '';
}

function renderPropertyGroups(groups) {
  elements.propertyGroups.innerHTML = groups.map((group) => `<button type="button" class="property-group${group.url === selectedPropertySource ? ' active' : ''}" data-source="${escapeHtml(group.url)}"><span><strong>${escapeHtml(hostname(group.url))}</strong><small>${formatNumber(group.withEmail)} email · ${formatNumber(group.withPhone)} phone</small></span><b>${formatNumber(group.count)}</b></button>`).join('');
  elements.propertyGroups.querySelectorAll('.property-group').forEach((button) => button.addEventListener('click', () => {
    selectedPropertySource = button.dataset.source;
    propertyPage = 1;
    renderPropertyGroups(groups);
    loadProperties();
  }));
}

async function loadPropertyGroups() {
  elements.propertyGroups.innerHTML = '<div class="inline-empty">Loading websites…</div>';
  const params = new URLSearchParams({ kind: elements.propertyKind.value });
  if (elements.propertySearch.value.trim()) params.set('search', elements.propertySearch.value.trim());
  try {
    const groups = await api(`/api/property-sources?${params}`);
    const allRecords = groups.reduce((sum, group) => sum + (group.count || 0), 0);
    elements.recordCountChip.textContent = `${formatNumber(allRecords)} record${allRecords === 1 ? '' : 's'}`;
    if (!groups.length) {
      selectedPropertySource = '';
      elements.propertyGroups.innerHTML = '<div class="inline-empty">No websites match these filters.</div>';
      elements.selectedSourceName.textContent = 'No website selected';
      elements.selectedSourceCount.textContent = '';
      elements.propertyRows.innerHTML = '<tr><td colspan="4">No saved properties match these filters.</td></tr>';
      return;
    }
    if (!groups.some((group) => group.url === selectedPropertySource)) selectedPropertySource = groups[0].url;
    renderPropertyGroups(groups);
    await loadProperties();
  } catch (error) {
    elements.propertyGroups.innerHTML = `<div class="inline-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadProperties() {
  if (!selectedPropertySource) return;
  elements.propertyRows.innerHTML = '<tr><td colspan="4">Loading saved data…</td></tr>';
  const params = new URLSearchParams({ page: propertyPage, limit: propertyLimit, kind: elements.propertyKind.value });
  if (elements.propertySearch.value.trim()) params.set('search', elements.propertySearch.value.trim());
  params.set('sourceUrl', selectedPropertySource);
  try {
    const data = await api(`/api/properties?${params}`);
    propertyTotal = data.total || 0;
    elements.selectedSourceName.textContent = hostname(selectedPropertySource);
    elements.selectedSourceCount.textContent = `${formatNumber(propertyTotal)} ${elements.propertyKind.value} record${propertyTotal === 1 ? '' : 's'}`;
    const totalPages = Math.max(1, Math.ceil(propertyTotal / propertyLimit));
    elements.pageCopy.textContent = `Page ${data.page} of ${totalPages}`;
    elements.previousPage.disabled = propertyPage <= 1;
    elements.nextPage.disabled = propertyPage >= totalPages;
    if (!data.items.length) {
      elements.propertyRows.innerHTML = '<tr><td colspan="4">No saved properties match these filters.</td></tr>';
      return;
    }
    elements.propertyRows.innerHTML = data.items.map((item) => {
      const record = item.record || {};
      const email = firstContact(record, 'emails');
      const phone = firstContact(record, 'phones');
      const title = record.title || record.address || 'Untitled property';
      const address = record.address || record.city || 'Address not captured';
      return `<tr><td class="property-title"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><small title="${escapeHtml(address)}">${escapeHtml(address)}</small></td><td>${escapeHtml(formatPrice(record))}</td><td class="contact-stack">${email ? `<span title="${escapeHtml(email)}">${escapeHtml(email)}</span>` : ''}${phone ? `<span title="${escapeHtml(phone)}">${escapeHtml(phone)}</span>` : ''}${!email && !phone ? '<span>Not captured</span>' : ''}</td><td>${escapeHtml(formatDate(item.savedAt))}</td></tr>`;
    }).join('');
  } catch (error) {
    elements.propertyRows.innerHTML = `<tr><td colspan="4">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderNutlipSources() {
  elements.nutlipSourceList.innerHTML = nutlipGroups.map((group) => `<button type="button" class="property-group${group.url === nutlipSource ? ' active' : ''}" data-source="${escapeHtml(group.url)}"><span><strong>${escapeHtml(hostname(group.url))}</strong><small>${formatNumber(group.withEmail)} email · ${formatNumber(group.withPhone)} phone</small></span><b>${formatNumber(group.count)}</b></button>`).join('');
  elements.nutlipSourceList.querySelectorAll('.property-group').forEach((button) => button.addEventListener('click', () => {
    nutlipSource = button.dataset.source;
    nutlipPage = 1;
    selectedNutlipRecord = null;
    renderNutlipSources();
    loadNutlipRecords();
  }));
}

async function loadNutlipSources() {
  elements.nutlipSourceList.innerHTML = '<div class="inline-empty">Loading websites…</div>';
  try {
    nutlipGroups = await api('/api/property-sources?kind=mapped');
    const total = nutlipGroups.reduce((sum, group) => sum + (group.count || 0), 0);
    elements.nutlipCountChip.textContent = `${formatNumber(total)} mapped record${total === 1 ? '' : 's'}`;
    if (!nutlipGroups.length) {
      nutlipSource = '';
      elements.nutlipSourceList.innerHTML = '<div class="inline-empty">No mapped websites yet.</div>';
      elements.nutlipRecordList.innerHTML = '<div class="inline-empty">Run a source in reusable mapping or AI per-record mode first.</div>';
      return;
    }
    if (!nutlipGroups.some((group) => group.url === nutlipSource)) nutlipSource = nutlipGroups[0].url;
    renderNutlipSources();
    await loadNutlipRecords();
  } catch (error) {
    elements.nutlipSourceList.innerHTML = `<div class="inline-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadNutlipRecords() {
  if (!nutlipSource) return;
  elements.nutlipRecordList.innerHTML = '<div class="inline-empty">Loading mapped properties…</div>';
  const params = new URLSearchParams({ kind: 'mapped', sourceUrl: nutlipSource, page: nutlipPage, limit: nutlipLimit });
  try {
    const data = await api(`/api/properties?${params}`);
    nutlipTotal = data.total || 0;
    const pages = Math.max(1, Math.ceil(nutlipTotal / nutlipLimit));
    elements.nutlipPageCopy.textContent = `Page ${data.page} of ${pages}`;
    elements.nutlipPrevious.disabled = nutlipPage <= 1;
    elements.nutlipNext.disabled = nutlipPage >= pages;
    if (!data.items.length) {
      elements.nutlipRecordList.innerHTML = '<div class="inline-empty">No mapped properties for this website.</div>';
      return;
    }
    elements.nutlipRecordList.innerHTML = data.items.map((item) => {
      const record = item.record || {};
      const title = record.title || record.address || 'Untitled property';
      const key = `${item.jobId}:${item.resultIndex}:${item.position}`;
      const activeKey = selectedNutlipRecord ? `${selectedNutlipRecord.jobId}:${selectedNutlipRecord.resultIndex}:${selectedNutlipRecord.position}` : '';
      return `<button type="button" class="nutlip-record${key === activeKey ? ' active' : ''}" data-job="${escapeHtml(item.jobId)}" data-result="${item.resultIndex}" data-position="${item.position}"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><span>${escapeHtml(formatPrice(record))}</span><small>${escapeHtml(record.address || record.city || 'Address not captured')}</small></button>`;
    }).join('');
    elements.nutlipRecordList.querySelectorAll('.nutlip-record').forEach((button) => button.addEventListener('click', () => loadNutlipRecord({
      jobId: button.dataset.job,
      resultIndex: Number(button.dataset.result),
      position: Number(button.dataset.position),
    })));
    if (!selectedNutlipRecord) {
      const first = data.items[0];
      await loadNutlipRecord({ jobId: first.jobId, resultIndex: first.resultIndex, position: first.position });
    }
  } catch (error) {
    elements.nutlipRecordList.innerHTML = `<div class="inline-empty">${escapeHtml(error.message)}</div>`;
  }
}

function schemaValue(value) {
  if (value === null || value === undefined || value === '') return '<span class="schema-empty">Not provided</span>';
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="schema-empty">None</span>';
    return `<div class="schema-array">${value.slice(0, 12).map((item) => `<span>${escapeHtml(typeof item === 'object' ? JSON.stringify(item) : item)}</span>`).join('')}${value.length > 12 ? `<span>+${value.length - 12} more</span>` : ''}</div>`;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
  return escapeHtml(value);
}

function renderNutlipInspector(storedProperty) {
  const record = storedProperty.record || {};
  selectedNutlipRecord = storedProperty;
  elements.nutlipEmpty.classList.add('hidden');
  elements.nutlipDetail.classList.remove('hidden');
  elements.nutlipTitle.textContent = record.title || record.address || 'Untitled property';
  const normalization = record._normalization || {};
  const confidence = Number.isFinite(Number(normalization.confidence)) ? `${Math.round(Number(normalization.confidence) * 100)}% confidence` : 'Confidence unavailable';
  const review = normalization.requiresReview ? 'Needs review' : 'Ready';
  elements.nutlipQuality.innerHTML = `<span class="${normalization.requiresReview ? 'review' : 'ready'}">${escapeHtml(review)}</span><span>${escapeHtml(confidence)}</span><span>${escapeHtml(record.salesPlatform || hostname(storedProperty.sourceUrl))}</span>`;
  const excluded = new Set(['_source', '_normalization']);
  const fields = Object.entries(record).filter(([key]) => !excluded.has(key));
  elements.nutlipFields.innerHTML = fields.map(([key, value]) => `<div class="nutlip-field"><dt>${escapeHtml(key)}</dt><dd>${schemaValue(value)}</dd></div>`).join('');
  const sourceContact = record._source?.contact || {};
  elements.nutlipFields.innerHTML += `<div class="nutlip-field nutlip-contact-field"><dt>Preserved source contact</dt><dd>${schemaValue([...(sourceContact.emails || []), ...(sourceContact.phones || [])])}</dd></div>`;
  elements.nutlipJson.textContent = JSON.stringify(record, null, 2);
  document.querySelectorAll('.nutlip-record').forEach((button) => button.classList.toggle('active', button.dataset.job === storedProperty.jobId && Number(button.dataset.result) === storedProperty.resultIndex && Number(button.dataset.position) === storedProperty.position));
}

async function loadNutlipRecord(identifier) {
  try {
    const document = await api(`/api/properties/${encodeURIComponent(identifier.jobId)}/${identifier.resultIndex}/${identifier.position}?kind=mapped`);
    renderNutlipInspector(document);
  } catch (error) {
    showError(error.message);
  }
}

async function initialiseWorkspace(username) {
  showApp(username);
  switchView('overview');
  await Promise.all([loadDashboard(), loadStorage()]);
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.loginError.textContent = '';
  const button = elements.loginForm.querySelector('button');
  button.disabled = true;
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: document.querySelector('#login-username').value, password: document.querySelector('#login-password').value }) });
    document.querySelector('#login-password').value = '';
    await initialiseWorkspace(result.username);
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

elements.logoutButton.addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* The local UI still signs out. */ }
  showLogin();
});

document.querySelectorAll('[data-view], [data-view-target]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view || button.dataset.viewTarget)));
document.querySelectorAll('.choice input').forEach((input) => input.addEventListener('change', () => {
  document.querySelectorAll('.choice').forEach((choice) => choice.classList.remove('active'));
  input.closest('.choice').classList.add('active');
}));

elements.runForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearTimeout(pollTimer);
  elements.formError.textContent = '';
  const urls = document.querySelector('#urls').value.split(/\n/).map((value) => value.trim()).filter(Boolean);
  elements.submitButton.disabled = true;
  try {
    const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({
      urls,
      aiMode: document.querySelector('input[name="aiMode"]:checked').value,
      platformOnly: true,
      deep: document.querySelector('#deep').checked,
      scopeDiscovery: document.querySelector('#scope').checked,
      maxPages: document.querySelector('#max-pages').value,
      maxDetailPages: document.querySelector('#max-details').value,
    }) });
    renderJob(job);
    pollJob(job.id);
  } catch (error) {
    elements.formError.textContent = error.message;
    elements.submitButton.disabled = false;
  }
});

elements.dataFilters.addEventListener('submit', (event) => { event.preventDefault(); propertyPage = 1; loadPropertyGroups(); });
elements.previousPage.addEventListener('click', () => { if (propertyPage > 1) { propertyPage -= 1; loadProperties(); } });
elements.nextPage.addEventListener('click', () => { if (propertyPage * propertyLimit < propertyTotal) { propertyPage += 1; loadProperties(); } });
elements.nutlipPrevious.addEventListener('click', () => { if (nutlipPage > 1) { nutlipPage -= 1; selectedNutlipRecord = null; loadNutlipRecords(); } });
elements.nutlipNext.addEventListener('click', () => { if (nutlipPage * nutlipLimit < nutlipTotal) { nutlipPage += 1; selectedNutlipRecord = null; loadNutlipRecords(); } });
elements.copyNutlip.addEventListener('click', async () => {
  if (!selectedNutlipRecord) return;
  await navigator.clipboard.writeText(JSON.stringify(selectedNutlipRecord.record, null, 2));
  elements.copyNutlip.textContent = 'Copied';
  setTimeout(() => { elements.copyNutlip.textContent = 'Copy JSON'; }, 1500);
});
elements.downloadNutlip.addEventListener('click', () => {
  if (!selectedNutlipRecord) return;
  const blob = new Blob([`${JSON.stringify(selectedNutlipRecord.record, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = Object.assign(document.createElement('a'), { href: url, download: `${hostname(selectedNutlipRecord.sourceUrl)}-${selectedNutlipRecord.position}-nutlip.json` });
  anchor.click();
  URL.revokeObjectURL(url);
});
document.querySelector('#refresh-dashboard').addEventListener('click', () => Promise.all([loadDashboard(), loadStorage()]));
document.querySelector('#refresh-history').addEventListener('click', loadHistory);

(async function boot() {
  try {
    const status = await api('/api/auth/status');
    if (status.authenticated) await initialiseWorkspace(status.username);
    else showLogin();
  } catch (error) {
    elements.loginError.textContent = error.message;
    showLogin();
  }
}());
