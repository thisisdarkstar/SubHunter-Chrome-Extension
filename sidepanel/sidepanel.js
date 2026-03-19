let state = {
  isScanning: false,
  results: [],
  liveResults: [],
  deadResults: [],
  domain: '',
  progress: 0,
  phase: '',
  startTime: null
};

let currentFilter = 'all';
let searchQuery = '';

document.addEventListener('DOMContentLoaded', async () => {
  await loadOptions();
  initializeUI();
  loadLastScan();
  startStatePolling();
});

async function loadOptions() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_OPTIONS' });
    if (response) {
      document.getElementById('enableCT').checked = response.enableCT ?? true;
      document.getElementById('enableBruteforce').checked = response.enableBruteforce ?? false;
      document.getElementById('checkLive').checked = response.checkLive ?? true;
    }
  } catch (err) {
    console.error('Failed to load options:', err);
  }
}

function initializeUI() {
  const domainInput = document.getElementById('domainInput');
  const scanBtn = document.getElementById('scanBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const exportBtn = document.getElementById('exportBtn');
  const exportFormat = document.getElementById('exportFormat');
  const clearBtn = document.getElementById('clearBtn');
  const copyAllBtn = document.getElementById('copyAllBtn');
  const searchInput = document.getElementById('searchInput');
  const filterBtns = document.querySelectorAll('.filter-btn');
  const enableCT = document.getElementById('enableCT');
  const enableBruteforce = document.getElementById('enableBruteforce');
  const checkLive = document.getElementById('checkLive');

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

  exportBtn.addEventListener('click', () => {
    exportResults(exportFormat.value);
  });

  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_RESULTS' }, () => {
      state = { ...state, results: [], liveResults: [], deadResults: [], domain: '' };
      updateUI();
    });
  });

  copyAllBtn.addEventListener('click', () => {
    const items = getFilteredItems();
    const text = items.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      showToast(`Copied ${items.length} subdomains`, 'success');
    }).catch(() => {
      showToast('Failed to copy', 'error');
    });
  });

  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    renderResults();
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
  const enableCT = document.getElementById('enableCT');
  const enableBruteforce = document.getElementById('enableBruteforce');
  const checkLive = document.getElementById('checkLive');

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
  state.startTime = Date.now();
  updateUI();

  try {
    const results = await chrome.runtime.sendMessage({
      type: 'START_SCAN',
      domain: domain,
      options: {
        enableCT: enableCT.checked,
        enableCertspotter: true,
        enableBruteforce: enableBruteforce.checked,
        bruteforceSize: 100,
        checkLive: checkLive.checked,
        concurrency: 10
      }
    });

    if (results.success) {
      state.results = results.results.results || [];
      state.liveResults = results.results.liveResults || [];
      state.deadResults = results.results.deadResults || [];
      updateUI();
      showToast(`Found ${state.results.length} subdomains`, 'success');
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
  }, 300);
}

function updateUI() {
  const scanBtn = document.getElementById('scanBtn');
  const btnText = scanBtn.querySelector('.btn-text');
  const spinner = scanBtn.querySelector('.spinner-icon');
  const progressSection = document.getElementById('progressSection');
  const progressFill = document.getElementById('progressFill');
  const progressPercent = document.getElementById('progressPercent');
  const elapsedTime = document.getElementById('elapsedTime');
  const phaseText = document.getElementById('phaseText');
  const totalCount = document.getElementById('totalCount');
  const liveCount = document.getElementById('liveCount');
  const deadCount = document.getElementById('deadCount');
  const exportBtn = document.getElementById('exportBtn');
  const exportFormat = document.getElementById('exportFormat');
  const clearBtn = document.getElementById('clearBtn');
  const copyAllBtn = document.getElementById('copyAllBtn');
  const currentDomain = document.getElementById('currentDomain');

  if (state.isScanning) {
    scanBtn.classList.add('scanning');
    btnText.textContent = 'Stop';
    spinner.classList.remove('hidden');
    progressSection.classList.remove('hidden');
    progressFill.style.width = `${state.progress}%`;
    progressPercent.textContent = `${state.progress}%`;
    
    if (state.startTime) {
      const elapsed = Math.round((Date.now() - state.startTime) / 1000);
      elapsedTime.textContent = `${elapsed}s`;
    }
    
    phaseText.textContent = state.phase;
  } else {
    scanBtn.classList.remove('scanning');
    btnText.textContent = 'Scan';
    spinner.classList.add('hidden');
    progressSection.classList.add('hidden');
  }

  totalCount.textContent = state.results.length;
  liveCount.textContent = state.liveResults.length;
  deadCount.textContent = state.deadResults.length;

  if (state.domain) {
    currentDomain.textContent = state.domain;
  } else {
    currentDomain.textContent = '';
  }

  const hasResults = state.results.length > 0;
  exportBtn.disabled = !hasResults;
  exportFormat.disabled = !hasResults;
  clearBtn.disabled = !hasResults;
  copyAllBtn.disabled = !hasResults;

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

  if (searchQuery) {
    items = items.filter(item => item.toLowerCase().includes(searchQuery));
  }

  if (items.length === 0) {
    const message = state.domain 
      ? (searchQuery ? 'No matching subdomains found' : 'No subdomains found')
      : 'Enter a domain to start scanning';
    
    resultsList.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.35-4.35"/>
        </svg>
        <p>${message}</p>
        ${state.domain && !searchQuery ? '<p class="hint">Try enabling more scan options</p>' : ''}
      </div>
    `;
    return;
  }

  const isLiveCheck = state.liveResults.length > 0 || state.deadResults.length > 0;

  resultsList.innerHTML = items.map(subdomain => {
    const isLive = state.liveResults.includes(subdomain);
    const statusClass = isLiveCheck ? (isLive ? 'live' : 'dead') : '';
    
    return `
      <div class="result-item ${statusClass}" data-domain="${subdomain}">
        <div class="domain-info">
          <span class="status-indicator"></span>
          <span class="domain" title="${subdomain}">${subdomain}</span>
        </div>
        <div class="actions">
          <button class="action-btn visit-btn" title="Visit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </button>
          <button class="action-btn copy-btn" title="Copy">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }).join('');

  resultsList.querySelectorAll('.result-item').forEach(item => {
    const domain = item.dataset.domain;
    
    item.querySelector('.copy-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(domain).then(() => {
        showToast('Copied to clipboard', 'success');
      });
    });

    item.querySelector('.visit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`https://${domain}`, '_blank', 'noopener,noreferrer');
    });
  });
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
  if (searchQuery) {
    items = items.filter(item => item.toLowerCase().includes(searchQuery));
  }
  return items;
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
  }, 2500);
}
