import axios from 'axios';
import { getSettings } from './db.js';
import { sendTestNotification } from './notifier.js';

async function checkAdzuna(appId, appKey, country = 'us') {
  if (!appId || !appKey) return { ok: false, reason: 'Missing credentials' };
  try {
    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1`;
    const res = await axios.get(url, { params: { app_id: appId, app_key: appKey, results_per_page: 1, what: 'developer' }, timeout: 10000 });
    if (res.data && res.data.results) return { ok: true };
    return { ok: false, reason: 'Unexpected response' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function checkDiscord(webhook) {
  if (!webhook) return { ok: false, reason: 'Missing webhook' };
  try {
    const res = await axios.post(webhook, { content: 'Job Notifier: webhook validation ping (no-op)' }, { timeout: 10000 });
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function main() {
  try {
    const settings = await getSettings();
    console.log('Current settings (sensitive values redacted below):');
    const redacted = { ...settings };
    if (redacted.telegram_bot_token) redacted.telegram_bot_token = '<REDACTED>';
    if (redacted.telegram_chat_id) redacted.telegram_chat_id = '<REDACTED>';
    if (redacted.discord_webhook_url) redacted.discord_webhook_url = '<REDACTED>';
    if (redacted.adzuna_app_key) redacted.adzuna_app_key = '<REDACTED>';
    if (redacted.adzuna_app_id) redacted.adzuna_app_id = '<REDACTED>';
    console.log(redacted);

    // 1) Notifications (Telegram / Discord)
    console.log('\nTesting notification endpoints (this will attempt to send a test message if credentials exist)...');
    try {
      await sendTestNotification(settings);
      console.log('Notification test: SUCCESS');
    } catch (err) {
      console.error('Notification test: FAILED ->', err.message || err);
    }

    // 2) Discord raw check (in case webhook present but sendTestNotification didn't cover it)
    if (settings.discord_webhook_url) {
      const dres = await checkDiscord(settings.discord_webhook_url);
      console.log('Discord webhook:', dres);
    }

    // 3) Adzuna API
    console.log('\nTesting Adzuna API credentials...');
    const adz = await checkAdzuna(settings.adzuna_app_id, settings.adzuna_app_key, (settings.country_code || 'us'));
    console.log('Adzuna:', adz);

    console.log('\nChecks complete. Review results above.');
  } catch (err) {
    console.error('Error running checks:', err.message || err);
  }
}

main();
