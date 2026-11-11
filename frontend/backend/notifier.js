import axios from 'axios';
import { addLog } from './db.js';

// Helper to escape HTML characters for Telegram HTML parse mode
function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveNotificationSettings(settings = {}) {
  return {
    telegram_bot_token: settings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || '',
    telegram_chat_id: settings.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || '',
    discord_webhook_url: settings.discord_webhook_url || process.env.DISCORD_WEBHOOK_URL || ''
  };
}

// Send test notification to verify credentials
export async function sendTestNotification(settings) {
  const { telegram_bot_token, telegram_chat_id, discord_webhook_url } = resolveNotificationSettings(settings);
  let sent = false;

  if (telegram_bot_token && telegram_chat_id) {
    try {
      const text = `🔔 <b>Job Notifier Test</b>\n\nYour job alert system is successfully configured! You will receive notifications here when matching jobs are found.`;
      const url = `https://api.telegram.org/bot${telegram_bot_token}/sendMessage`;
      await axios.post(url, {
        chat_id: telegram_chat_id,
        text: text,
        parse_mode: 'HTML'
      });
      await addLog('INFO', 'Test notification sent to Telegram.');
      sent = true;
    } catch (err) {
      await addLog('ERROR', `Failed to send Telegram test notification: ${err.message}`);
      throw new Error(`Telegram error: ${err.response?.data?.description || err.message}`);
    }
  }

  if (discord_webhook_url) {
    try {
      await axios.post(discord_webhook_url, {
        content: `🔔 **Job Notifier Test**\nYour job alert system is successfully configured! You will receive notifications here when matching jobs are found.`
      });
      await addLog('INFO', 'Test notification sent to Discord.');
      sent = true;
    } catch (err) {
      await addLog('ERROR', `Failed to send Discord test notification: ${err.message}`);
      throw new Error(`Discord error: ${err.message}`);
    }
  }

  if (!sent) {
    throw new Error('No notification credentials provided. Please configure Telegram or Discord settings.');
  }

  return true;
}

// Send job notification
export async function sendJobNotification(job, settings) {
  const { telegram_bot_token, telegram_chat_id, discord_webhook_url } = resolveNotificationSettings(settings);
  
  if (!telegram_bot_token && !telegram_chat_id && !discord_webhook_url) {
    // No notifications configured, skip silently (user can see it in dashboard)
    return;
  }

  const title = job.title;
  const company = job.company || 'Unknown';
  const location = job.location || 'Remote / Unspecified';
  const source = job.source || 'Direct';
  const applyUrl = job.url;
  const salary = job.salary ? `💰 <b>Salary:</b> ${job.salary}\n` : '';

  // 1. Telegram Send
  if (telegram_bot_token && telegram_chat_id) {
    try {
      const text = `🚨 <b>New Job Found!</b>\n\n` +
                   `💼 <b>Title:</b> ${escapeHTML(title)}\n` +
                   `🏢 <b>Company:</b> ${escapeHTML(company)}\n` +
                   `📍 <b>Location:</b> ${escapeHTML(location)}\n` +
                   `${escapeHTML(salary)}` +
                   `🌐 <b>Source:</b> ${escapeHTML(source)}\n\n` +
                   `🔗 <a href="${applyUrl}">Apply Here</a>`;

      await axios.post(`https://api.telegram.org/bot${telegram_bot_token}/sendMessage`, {
        chat_id: telegram_chat_id,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      });
    } catch (err) {
      await addLog('ERROR', `Telegram notify failed for job "${title}": ${err.message}`);
    }
  }

  // 2. Discord Send
  if (discord_webhook_url) {
    try {
      await axios.post(discord_webhook_url, {
        content: `🚨 **New Job Found!**`,
        embeds: [
          {
            title: title,
            url: applyUrl,
            color: 5814783, // Elegant purple color
            fields: [
              { name: '🏢 Company', value: company, inline: true },
              { name: '📍 Location', value: location, inline: true },
              { name: '🌐 Source', value: source, inline: true },
              ...(job.salary ? [{ name: '💰 Salary', value: job.salary, inline: true }] : [])
            ],
            footer: {
              text: `Discovered at ${new Date().toLocaleTimeString()}`
            }
          }
        ]
      });
    } catch (err) {
      await addLog('ERROR', `Discord notify failed for job "${title}": ${err.message}`);
    }
  }
}
