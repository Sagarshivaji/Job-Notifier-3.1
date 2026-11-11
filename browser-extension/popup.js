/**
 * popup.js — Job Notifier Browser Extension
 * Drives the popup UI: shows auto-import status, lets user save credentials,
 * and allows manual re-scan / send.
 */

const STORAGE_KEYS = { backendUrl: 'jn_backend_url', token: 'jn_auth_token' };

let detectedJobs = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $main               = document.getElementById('main-content');
const $unsupported         = document.getElementById('unsupported');
const $unsupportedSettings = document.getElementById('unsupported-settings');
const $badge              = document.getElementById('site-badge');
const $count              = document.getElementById('job-count');
const $preview            = document.getElementById('preview-list');
const $backendUrl         = document.getElementById('backend-url');
const $authToken          = document.getElementById('auth-token');
const $sendBtn            = document.getElementById('send-btn');
const $saveBtn            = document.getElementById('save-btn');
const $refreshBtn         = document.getElementById('refresh-btn');
const $status             = document.getElementById('status-msg');
const $autoStatus         = document.getElementById('auto-status');
// Alt inputs (shown on unsupported pages)
const $backendUrlAlt      = document.getElementById('backend-url-alt');
const $authTokenAlt       = document.getElementById('auth-token-alt');
const $saveBtnAlt         = document.getElementById('save-btn-alt');
const $statusAlt          = document.getElementById('status-msg-alt');

// ── Helpers ───────────────────────────────────────────────────────────────────

function showStatus(msg, type = 'info') {
  $status.textContent = msg;
  $status.className = `status ${type}`;
}

function clearStatus() {
  $status.className = 'status';
}

function getSiteInfo(hostname) {
  if (hostname.includes('indeed.com'))   return { label: '🔵 Indeed',   cls: 'indeed' };
  if (hostname.includes('naukri.com'))   return { label: '🟢 Naukri',   cls: 'naukri' };
  if (hostname.includes('linkedin.com')) return { label: '🟣 LinkedIn', cls: 'linkedin' };
  if (hostname.includes('glassdoor.'))   return { label: '🟠 Glassdoor', cls: 'glassdoor' };
  return null;
}

function renderPreview(jobs) {
  $preview.innerHTML = '';
  if (!jobs.length) return;
  const top = jobs.slice(0, 8);
  top.forEach(j => {
    const div = document.createElement('div');
    div.className = 'preview-item';
    div.innerHTML = `<div class="ji-title">${escHtml(j.title)}</div><div class="ji-company">${escHtml(j.company)} · ${escHtml(j.location || '')}</div>`;
    $preview.appendChild(div);
  });
  if (jobs.length > 8) {
    const more = document.createElement('div');
    more.className = 'preview-item';
    more.style.color = '#475569';
    more.style.fontSize = '10px';
    more.textContent = `...and ${jobs.length - 8} more`;
    $preview.appendChild(more);
  }
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Auto-import status display ────────────────────────────────────────────────

function updateAutoStatus(hasCredentials) {
  if (!$autoStatus) return;
  if (hasCredentials) {
    $autoStatus.innerHTML = `<span class="auto-dot active"></span> Auto-import <strong>ON</strong> — jobs sent automatically when you browse job sites`;
    $autoStatus.className = 'auto-status active';
  } else {
    $autoStatus.innerHTML = `<span class="auto-dot inactive"></span> Auto-import <strong>OFF</strong> — save your backend URL &amp; token below to enable`;
    $autoStatus.className = 'auto-status inactive';
  }
}

// ── Load saved settings ───────────────────────────────────────────────────────

async function loadSettings() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.backendUrl, STORAGE_KEYS.token]);
  const savedUrl   = data[STORAGE_KEYS.backendUrl] || '';
  const savedToken = data[STORAGE_KEYS.token] || '';
  $backendUrl.value = savedUrl || 'http://localhost:5000';
  $authToken.value  = savedToken;
  // Sync alt inputs too
  if ($backendUrlAlt) $backendUrlAlt.value = savedUrl || 'http://localhost:5000';
  if ($authTokenAlt)  $authTokenAlt.value  = savedToken;
  // Update auto-import status pill
  updateAutoStatus(!!(savedUrl && savedToken));
}

async function saveSettings() {
  const url   = $backendUrl.value.trim().replace(/\/$/, '');
  const token = $authToken.value.trim();
  await chrome.storage.local.set({
    [STORAGE_KEYS.backendUrl]: url,
    [STORAGE_KEYS.token]:      token
  });
  return { url, token };
}

// ── Save button handler ───────────────────────────────────────────────────────

async function handleSaveSettings(fromAlt = false) {
  // If called from alt panel, sync values to main inputs first
  if (fromAlt && $backendUrlAlt && $authTokenAlt) {
    $backendUrl.value = $backendUrlAlt.value;
    $authToken.value  = $authTokenAlt.value;
  }
  const { url, token } = await saveSettings();
  const successMsg = '✅ Settings saved! Auto-import is now active.';
  const errorMsg   = '⚠️ Please enter both Backend URL and Auth Token.';
  if (!url || !token) {
    if (fromAlt && $statusAlt) { $statusAlt.textContent = errorMsg; $statusAlt.className = 'status error'; }
    else showStatus(errorMsg, 'error');
    return;
  }
  updateAutoStatus(true);
  if (fromAlt && $statusAlt) { $statusAlt.textContent = successMsg; $statusAlt.className = 'status success'; }
  else showStatus(successMsg, 'success');
  // Sync alt inputs
  if ($backendUrlAlt) $backendUrlAlt.value = url;
  if ($authTokenAlt)  $authTokenAlt.value  = token;
  // Enable send button if we have jobs
  if (detectedJobs.length > 0) $sendBtn.disabled = false;
}

// ── Extract jobs from active tab ──────────────────────────────────────────────

async function scanPage() {
  clearStatus();
  $count.textContent = '...';
  $sendBtn.disabled = true;
  $preview.innerHTML = '';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) { showStatus('No active tab found.', 'error'); return; }

  let hostname = '';
  try { hostname = new URL(tab.url || '').hostname; } catch (_) {}
  const siteInfo = getSiteInfo(hostname);

  if (!siteInfo) {
    $main.style.display = 'none';
    $unsupported.style.display = 'block';
    if ($unsupportedSettings) $unsupportedSettings.style.display = 'block';
    return;
  }

  $main.style.display = 'block';
  $unsupported.style.display = 'none';
  if ($unsupportedSettings) $unsupportedSettings.style.display = 'none';
  $badge.textContent = siteInfo.label;
  $badge.className   = `site-badge ${siteInfo.cls}`;

  try {
    // Ensure content script is injected (handles non-matching paths)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    }).catch(() => {}); // ignore if already injected

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'extractJobs' });
    detectedJobs = (response && response.jobs) ? response.jobs : [];
  } catch (err) {
    detectedJobs = [];
    showStatus('Could not read page. Try refreshing it, then click Re-scan.', 'error');
  }

  $count.textContent = detectedJobs.length;
  renderPreview(detectedJobs);

  const data = await chrome.storage.local.get([STORAGE_KEYS.backendUrl, STORAGE_KEYS.token]);
  const hasCredentials = !!(data[STORAGE_KEYS.backendUrl] && data[STORAGE_KEYS.token]);

  if (detectedJobs.length > 0) {
    $sendBtn.disabled = !hasCredentials;
    if (hasCredentials) {
      showStatus(`Found ${detectedJobs.length} job(s). Auto-import is active — they are sent automatically. Click "Send Now" to import immediately.`, 'info');
    } else {
      showStatus(`Found ${detectedJobs.length} job(s). Save your credentials below to enable auto-import.`, 'info');
    }
  } else {
    showStatus('No job listings found. Scroll down to load more jobs, then click Re-scan.', 'info');
  }
}

// ── Send jobs to backend (manual) ─────────────────────────────────────────────

async function sendJobs() {
  if (!detectedJobs.length) return;

  const { url: backendUrl, token } = await saveSettings();

  if (!backendUrl) { showStatus('Please enter your backend URL.', 'error'); return; }
  if (!token)      { showStatus('Please enter your auth token.', 'error'); return; }

  $sendBtn.disabled = true;
  $sendBtn.textContent = 'Sending...';
  showStatus('Sending jobs to your dashboard...', 'info');

  try {
    const res = await fetch(`${backendUrl}/api/jobs/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ jobs: detectedJobs })
    });

    const data = await res.json();

    if (res.ok && data.success) {
      showStatus(`✅ Done! ${data.added} new job(s) added, ${data.skipped} already existed or filtered.`, 'success');
      updateAutoStatus(true);
    } else {
      const msg = data.error || 'Unknown error from server.';
      if (res.status === 401 || res.status === 403) {
        showStatus(`❌ Auth failed. Check your token. (${msg})`, 'error');
      } else {
        showStatus(`❌ Server error: ${msg}`, 'error');
      }
    }
  } catch (err) {
    showStatus(`❌ Could not reach backend: ${err.message}. Is it running?`, 'error');
  } finally {
    $sendBtn.disabled = false;
    $sendBtn.textContent = 'Send Now';
  }
}

// ── Event Listeners ───────────────────────────────────────────────────────────

$sendBtn.addEventListener('click', sendJobs);
$saveBtn.addEventListener('click', () => handleSaveSettings(false));
$refreshBtn.addEventListener('click', scanPage);
if ($saveBtnAlt) $saveBtnAlt.addEventListener('click', () => handleSaveSettings(true));

// Auto-update button state when credentials are typed
[$backendUrl, $authToken].forEach(el => {
  el.addEventListener('input', () => {
    if (detectedJobs.length > 0 && $authToken.value.trim() && $backendUrl.value.trim()) {
      $sendBtn.disabled = false;
    }
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  await loadSettings();
  await scanPage();
})();
