/**
 * background.js — Job Notifier Extension Service Worker
 * Handles badge updates, auto-import fetch calls, and background messaging.
 */

const STORAGE_KEYS = { backendUrl: 'jn_backend_url', token: 'jn_auth_token' };

// ── Badge helpers ─────────────────────────────────────────────────────────────

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Content script reports job count for badge display
  if (message.action === 'updateBadge' && sender.tab) {
    const count = message.count || 0;
    setBadge(sender.tab.id, count > 0 ? String(count) : '', '#6366f1');
    return;
  }

  // Content script requests auto-import (fire-and-forget from content perspective)
  if (message.action === 'autoImportJobs') {
    const { jobs } = message;

    // Run async without blocking the message channel
    (async () => {
      try {
        // Load saved credentials
        const data = await chrome.storage.local.get([STORAGE_KEYS.backendUrl, STORAGE_KEYS.token]);
        const backendUrl = (data[STORAGE_KEYS.backendUrl] || '').replace(/\/$/, '');
        const token = data[STORAGE_KEYS.token] || '';

        if (!backendUrl || !token) {
          // No credentials yet — show a hint badge
          if (sender.tab) setBadge(sender.tab.id, '!', '#f59e0b');
          sendResponse({ success: false, reason: 'no_credentials' });
          return;
        }

        if (!jobs || jobs.length === 0) {
          sendResponse({ success: false, reason: 'no_jobs' });
          return;
        }

        // Show "sending" badge
        if (sender.tab) setBadge(sender.tab.id, '…', '#6366f1');

        const res = await fetch(`${backendUrl}/api/jobs/import`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ jobs })
        });

        const result = await res.json();

        if (res.ok && result.success) {
          const added = result.added || 0;
          // Show green checkmark or count of new jobs
          if (sender.tab) {
            setBadge(sender.tab.id, added > 0 ? `+${added}` : '✓', '#22c55e');
            // Clear badge after 6 seconds
            setTimeout(() => clearBadge(sender.tab.id), 6000);
          }
          sendResponse({ success: true, added: result.added, skipped: result.skipped });
        } else {
          const errMsg = result.error || 'Unknown error';
          console.warn('[Job Notifier] Auto-import failed:', errMsg);
          if (res.status === 401 || res.status === 403) {
            if (sender.tab) setBadge(sender.tab.id, '🔒', '#ef4444');
          } else {
            if (sender.tab) setBadge(sender.tab.id, 'ERR', '#ef4444');
          }
          sendResponse({ success: false, reason: errMsg });
        }
      } catch (err) {
        console.warn('[Job Notifier] Auto-import fetch error:', err.message);
        if (sender.tab) setBadge(sender.tab.id, '!', '#ef4444');
        sendResponse({ success: false, reason: err.message });
      }
    })();

    return true; // Keep channel open for async sendResponse
  }
});
