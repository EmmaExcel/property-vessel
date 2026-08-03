const form = document.querySelector('#run-form');
const submitButton = document.querySelector('#submit-button');
const errorMessage = document.querySelector('#form-error');
const emptyState = document.querySelector('#empty-state');
const jobState = document.querySelector('#job-state');
const statusBadge = document.querySelector('#status-badge');
const progressCopy = document.querySelector('#progress-copy');
const progressBar = document.querySelector('#progress-bar');
const currentUrl = document.querySelector('#current-url');
const results = document.querySelector('#results');
let pollTimer = null;

document.querySelectorAll('.choice input').forEach((input) => {
  input.addEventListener('change', () => {
    document.querySelectorAll('.choice').forEach((choice) => choice.classList.remove('active'));
    input.closest('.choice').classList.add('active');
  });
});

function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return value; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function renderResults(items) {
  results.innerHTML = items.map((item) => {
    const contacts = item.contactCoverage
      ? `${item.contactCoverage.withEmail || 0} email · ${item.contactCoverage.withPhone || 0} phone`
      : 'Contact audit unavailable';
    const links = Object.entries(item.downloads || {}).filter(([, url]) => url).map(([kind, url]) => (
      `<a href="${escapeHtml(url)}">${kind === 'mapped' ? 'Platform JSON' : kind === 'raw' ? 'Raw JSON' : 'Run report'}</a>`
    )).join('');
    return `<article class="result-card">
      <div class="result-top"><h3 title="${escapeHtml(item.url)}">${escapeHtml(hostname(item.url))}</h3><span class="count">${item.count.toLocaleString()} records</span></div>
      <div class="result-meta"><span>${escapeHtml(item.status)}</span><span>${escapeHtml(contacts)}</span><span>${item.needsReview || 0} review</span></div>
      <div class="downloads">${links}</div>
    </article>`;
  }).join('');
}

function renderJob(job) {
  emptyState.classList.add('hidden');
  jobState.classList.remove('hidden');
  const finished = job.status === 'completed' || job.status === 'failed';
  const progress = job.total ? Math.round(((job.currentIndex + (finished ? 0 : .25)) / job.total) * 100) : 0;
  statusBadge.textContent = job.status;
  statusBadge.classList.toggle('failed', job.status === 'failed');
  progressBar.style.width = `${job.status === 'completed' ? 100 : Math.min(progress, 96)}%`;
  progressCopy.textContent = job.status === 'completed'
    ? `${job.results.length} source${job.results.length === 1 ? '' : 's'} completed`
    : job.status === 'failed' ? 'Run stopped' : `Source ${Math.min(job.currentIndex + 1, job.total)} of ${job.total}`;
  currentUrl.textContent = job.error || job.currentUrl || (job.status === 'completed' ? 'Your files are ready to download.' : 'Preparing the first source…');
  renderResults(job.results || []);
  submitButton.disabled = !finished;
  submitButton.querySelector('span').textContent = finished ? 'Start another run' : 'Intake in progress…';
}

async function pollJob(id) {
  try {
    const response = await fetch(`/api/jobs/${id}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not read run status.');
    renderJob(job);
    if (!['completed', 'failed'].includes(job.status)) pollTimer = setTimeout(() => pollJob(id), 1500);
  } catch (error) {
    errorMessage.textContent = error.message;
    submitButton.disabled = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearTimeout(pollTimer);
  errorMessage.textContent = '';
  const urls = document.querySelector('#urls').value.split(/\n/).map((value) => value.trim()).filter(Boolean);
  const aiMode = document.querySelector('input[name="aiMode"]:checked').value;
  submitButton.disabled = true;
  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        urls,
        aiMode,
        platformOnly: true,
        deep: document.querySelector('#deep').checked,
        scopeDiscovery: document.querySelector('#scope').checked,
        maxPages: document.querySelector('#max-pages').value,
        maxDetailPages: document.querySelector('#max-details').value,
      }),
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not start the run.');
    renderJob(job);
    pollJob(job.id);
  } catch (error) {
    errorMessage.textContent = error.message;
    submitButton.disabled = false;
  }
});
