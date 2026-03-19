const DEFAULT_OPTIONS = {
  enableCT: true,
  enableCertspotter: true,
  enableBruteforce: false,
  bruteforceSize: 100,
  concurrency: 10,
  checkLive: true,
  defaultExportFormat: 'txt'
};

let currentOptions = { ...DEFAULT_OPTIONS };

document.addEventListener('DOMContentLoaded', () => {
  loadOptions();
  initializeUI();
});

function initializeUI() {
  const enableBruteforce = document.getElementById('enableBruteforce');
  const bruteforceOptions = document.getElementById('bruteforceOptions');
  const saveBtn = document.getElementById('saveBtn');
  const resetBtn = document.getElementById('resetBtn');

  enableBruteforce.addEventListener('change', (e) => {
    bruteforceOptions.style.display = e.target.checked ? 'block' : 'none';
  });

  saveBtn.addEventListener('click', saveOptions);
  resetBtn.addEventListener('click', resetOptions);
}

async function loadOptions() {
  try {
    const data = await chrome.storage.local.get(['scanOptions']);
    currentOptions = { ...DEFAULT_OPTIONS, ...data.scanOptions };
    applyOptionsToUI();
  } catch (err) {
    console.error('Failed to load options:', err);
    currentOptions = { ...DEFAULT_OPTIONS };
    applyOptionsToUI();
  }
}

function applyOptionsToUI() {
  document.getElementById('enableCT').checked = currentOptions.enableCT;
  document.getElementById('enableCertspotter').checked = currentOptions.enableCertspotter;
  document.getElementById('enableBruteforce').checked = currentOptions.enableBruteforce;
  document.getElementById('bruteforceSize').value = currentOptions.bruteforceSize;
  document.getElementById('concurrency').value = currentOptions.concurrency;
  document.getElementById('checkLive').checked = currentOptions.checkLive;
  document.getElementById('defaultExportFormat').value = currentOptions.defaultExportFormat;

  const bruteforceOptions = document.getElementById('bruteforceOptions');
  bruteforceOptions.style.display = currentOptions.enableBruteforce ? 'block' : 'none';
}

function getOptionsFromUI() {
  return {
    enableCT: document.getElementById('enableCT').checked,
    enableCertspotter: document.getElementById('enableCertspotter').checked,
    enableBruteforce: document.getElementById('enableBruteforce').checked,
    bruteforceSize: parseInt(document.getElementById('bruteforceSize').value, 10),
    concurrency: parseInt(document.getElementById('concurrency').value, 10),
    checkLive: document.getElementById('checkLive').checked,
    defaultExportFormat: document.getElementById('defaultExportFormat').value
  };
}

async function saveOptions() {
  const options = getOptionsFromUI();
  
  try {
    await chrome.storage.local.set({ scanOptions: options });
    currentOptions = options;
    showToast('Settings saved successfully', 'success');
  } catch (err) {
    console.error('Failed to save options:', err);
    showToast('Failed to save settings', 'error');
  }
}

async function resetOptions() {
  try {
    await chrome.storage.local.set({ scanOptions: DEFAULT_OPTIONS });
    currentOptions = { ...DEFAULT_OPTIONS };
    applyOptionsToUI();
    showToast('Settings reset to defaults', 'success');
  } catch (err) {
    console.error('Failed to reset options:', err);
    showToast('Failed to reset settings', 'error');
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
  }, 2500);
}
