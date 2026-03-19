let state = {
  isScanning: false,
  results: [],
  liveResults: [],
  deadResults: [],
  domain: '',
  progress: 0,
  phase: ''
};

let currentFilter = 'all';

document.addEventListener('DOMContentLoaded', () => {
  initializeUI();
  loadLastScan();
  startStatePolling();
});

function initializeUI() {
  const domainInput = document.getElementById('domainInput');
  const scanBtn = document.getElementById('scanBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const sidepanelBtn = document.getElementById('sidepanelBtn');
  const exportBtn = document.getElementById('exportBtn');
  const exportFormat = document.getElementById('exportFormat');
  const clearBtn = document.getElementById('clearBtn');
  const filterBtns = document.querySelectorAll('.filter-btn');

  domainInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !state.isScanning) {
      startScan();
    }
  });

  scanBtn.addEventListener('click', () => {
    if (state.isScanning) {
      stopScan();
    } else {
      startScan();
    }
  });

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  sidepanelBtn.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
      if (response.success) {
        window.close();
      } else {
        showToast('Failed to open side panel', 'error');
      }
    } catch (err) {
      showToast('Failed to open side panel', 'error');
    }
  });

  exportBtn.addEventListener('click', () => {
    exportResults(exportFormat.value);
  });

  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_RESULTS' }, () => {
      state = { ...state, results: [], liveResults: [], deadResults: [], domain: '' };
      updateUI();
    });
  });

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.filter;
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderResults();
    });
  });
}

async function startScan() {
  const domainInput = document.getElementById('domainInput');
  const domain = normalizeDomain(domainInput.value.trim());

  if (!domain) {
    showToast('Please enter a valid domain', 'error');
    return;
  }

  if (!isValidDomain(domain)) {
    showToast('Invalid domain format', 'error');
    return;
  }

  state.isScanning = true;
  state.domain = domain;
  state.progress = 0;
  state.phase = 'Starting...';
  updateUI();

  try {
    const results = await chrome.runtime.sendMessage({
      type: 'START_SCAN',
      domain: domain,
      options: {}
    });

    if (results.success) {
      state.results = results.results.results || [];
      state.liveResults = results.results.liveResults || [];
      state.deadResults = results.results.deadResults || [];
      updateUI();
    } else {
      showToast(results.error || 'Scan failed', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Scan failed', 'error');
  }

  state.isScanning = false;
  updateUI();
}

async function stopScan() {
  await chrome.runtime.sendMessage({ type: 'STOP_SCAN' });
  state.isScanning = false;
  state.phase = 'Stopped';
  updateUI();
}

async function loadLastScan() {
  try {
    const data = await chrome.storage.local.get(['lastScanResults']);
    if (data.lastScanResults) {
      state.results = data.lastScanResults.results || [];
      state.liveResults = data.lastScanResults.liveResults || [];
      state.deadResults = data.lastScanResults.deadResults || [];
      state.domain = data.lastScanResults.domain || '';
      updateUI();
    }
  } catch (err) {
    console.error('Failed to load last scan:', err);
  }
}

function startStatePolling() {
  setInterval(async () => {
    if (state.isScanning) {
      try {
        const newState = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
        if (newState) {
          state = { ...state, ...newState };
          updateUI();
        }
      } catch (err) {
        console.error('State poll failed:', err);
      }
    }
  }, 500);
}

function updateUI() {
  const scanBtn = document.getElementById('scanBtn');
  const btnText = scanBtn.querySelector('.btn-text');
  const btnLoading = scanBtn.querySelector('.btn-loading');
  const progressContainer = document.getElementById('progressContainer');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const phaseText = document.getElementById('phaseText');
  const resultsSummary = document.getElementById('resultsSummary');
  const totalCount = document.getElementById('totalCount');
  const liveCount = document.getElementById('liveCount');
  const deadCount = document.getElementById('deadCount');
  const resultsList = document.getElementById('resultsList');
  const exportBtn = document.getElementById('exportBtn');
  const exportFormat = document.getElementById('exportFormat');
  const clearBtn = document.getElementById('clearBtn');

  if (state.isScanning) {
    scanBtn.classList.add('scanning');
    btnText.textContent = 'Stop';
    btnLoading.classList.remove('hidden');
    progressContainer.classList.remove('hidden');
    progressFill.style.width = `${state.progress}%`;
    progressText.textContent = `${state.progress}%`;
    phaseText.textContent = state.phase;
  } else {
    scanBtn.classList.remove('scanning');
    btnText.textContent = 'Scan';
    btnLoading.classList.add('hidden');
    progressContainer.classList.add('hidden');
  }

  if (state.results.length > 0 || state.liveResults.length > 0) {
    resultsSummary.classList.remove('hidden');
    totalCount.textContent = state.results.length;
    liveCount.textContent = state.liveResults.length;
    deadCount.textContent = state.deadResults.length;
    exportBtn.disabled = false;
    exportFormat.disabled = false;
    clearBtn.disabled = false;
  } else {
    resultsSummary.classList.add('hidden');
    exportBtn.disabled = true;
    exportFormat.disabled = true;
    clearBtn.disabled = true;
  }

  renderResults();
}

function renderResults() {
  const resultsList = document.getElementById('resultsList');
  let items = [];

  switch (currentFilter) {
    case 'live':
      items = state.liveResults;
      break;
    case 'dead':
      items = state.deadResults;
      break;
    default:
      items = state.results;
  }

  if (items.length === 0) {
    resultsList.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.35-4.35"/>
        </svg>
        <p>${state.domain ? 'No subdomains found' : 'Enter a domain and click Scan'}</p>
      </div>
    `;
    return;
  }

  const isLiveCheck = state.liveResults.length > 0 || state.deadResults.length > 0;

  resultsList.innerHTML = items.map(subdomain => {
    const isLive = state.liveResults.includes(subdomain);
    const statusClass = isLiveCheck ? (isLive ? 'live' : 'dead') : '';
    const statusLabel = isLiveCheck ? (isLive ? 'Live' : 'Dead') : 'Found';
    
    return `
      <div class="result-item ${statusClass}" data-domain="${subdomain}">
        <span class="domain" title="${subdomain}">${subdomain}</span>
        <div class="result-actions">
          <span class="status">
            <span class="status-dot"></span>
            ${statusLabel}
          </span>
          <div class="actions">
            <button class="visit-btn" title="Visit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </button>
            <button class="copy-btn" title="Copy">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  resultsList.querySelectorAll('.result-item').forEach(item => {
    const domain = item.dataset.domain;
    const copyBtn = item.querySelector('.copy-btn');
    const visitBtn = item.querySelector('.visit-btn');

    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(domain);
    });

    visitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`https://${domain}`, '_blank');
    });
  });
}

async function exportResults(format) {
  const items = getFilteredItems();
  let content = '';
  let filename = '';
  let mimeType = '';
  const filterLabel = currentFilter === 'all' ? 'all' : currentFilter;

  switch (format) {
    case 'json':
      content = JSON.stringify({
        domain: state.domain,
        scanDate: new Date().toISOString(),
        filter: filterLabel,
        totalFound: state.results.length,
        liveCount: state.liveResults.length,
        exportedCount: items.length,
        subdomains: items
      }, null, 2);
      filename = `subhunter-${state.domain}-${filterLabel}-${Date.now()}.json`;
      mimeType = 'application/json';
      break;
    case 'csv':
      const csvItems = items.map(s => ({
        subdomain: s,
        live: state.liveResults.includes(s)
      }));
      content = 'subdomain,live\n' + csvItems.map(s => `${s.subdomain},${s.live}`).join('\n');
      filename = `subhunter-${state.domain}-${filterLabel}-${Date.now()}.csv`;
      mimeType = 'text/csv';
      break;
    default:
      content = items.join('\n');
      filename = `subhunter-${state.domain}-${filterLabel}-${Date.now()}.txt`;
      mimeType = 'text/plain';
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`Exported ${items.length} subdomains (${filterLabel})`, 'success');
}

function getFilteredItems() {
  let items = [];
  switch (currentFilter) {
    case 'live':
      items = state.liveResults;
      break;
    case 'dead':
      items = state.deadResults;
      break;
    default:
      items = state.results;
  }
  return items;
}

function normalizeDomain(domain) {
  domain = domain.toLowerCase().trim();
  domain = domain.replace(/^(https?:\/\/)?/, '');
  domain = domain.replace(/^www\./, '');
  domain = domain.replace(/\/.*$/, '');
  return domain;
}

function isValidDomain(domain) {
  const pattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i;
  return pattern.test(domain);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success');
  } catch (err) {
    showToast('Failed to copy', 'error');
  }
}

function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}
