import 'dotenv/config';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { addLog, getSettings, getAdminUsers } from './db.js';

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

// Send Admin OTP Email
export async function sendLoginOTP(otpCode) {
  // Support both old (SMTP_USER/SMTP_PASS) and new (EMAIL_USER/EMAIL_APP_PASSWORD) env var names
  const smtpUser = process.env.EMAIL_USER || process.env.SMTP_USER;
  const smtpPass = process.env.EMAIL_APP_PASSWORD || process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    console.warn('[OTP EMAIL] ❌ No email credentials found. Please configure EMAIL_USER and EMAIL_APP_PASSWORD in your hosting provider environment variables (e.g. Render / Vercel dashboard).');
    return false;
  }

  console.log(`[OTP EMAIL] Attempting to send code to: ${smtpUser}`);

  const mailOptions = {
    from: `"Job Notification Admin" <${smtpUser}>`,
    to: smtpUser,
    subject: 'Your Admin Login Code',
    text: `Your one-time login code is: ${otpCode}\n\nIt expires in 5 minutes.`,
    html: `<h2>Job Notification Login</h2><p>Your one-time login code is: <strong>${otpCode}</strong></p><p>It expires in 5 minutes.</p>`
  };

  // Optional: HTTP API fallback (Resend) if configured (bypasses SMTP port blocking completely)
  if (process.env.RESEND_API_KEY) {
    try {
      await axios.post('https://api.resend.com/emails', {
        from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
        to: [smtpUser],
        subject: 'Your Admin Login Code',
        html: `<h2>Job Notification Login</h2><p>Your one-time login code is: <strong>${otpCode}</strong></p><p>It expires in 5 minutes.</p>`
      }, {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }
      });
      console.log(`[OTP EMAIL] ✅ Email sent via Resend API to ${smtpUser}`);
      return true;
    } catch (apiErr) {
      console.error(`[OTP EMAIL] ⚠️ Resend API failed: ${apiErr.response?.data?.message || apiErr.message}`);
    }
  }

  // Attempt 1: Port 465 (Direct SSL)
  try {
    const transporter465 = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: 465,
      secure: true,
      connectionTimeout: 8000,
      greetingTimeout: 5000,
      socketTimeout: 8000,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });

    await transporter465.sendMail(mailOptions);
    console.log(`[OTP EMAIL] ✅ Email sent successfully via Port 465 to ${smtpUser}`);
    return true;
  } catch (error) {
    console.error(`[OTP EMAIL] ⚠️ Port 465 failed (Code: ${error.code || 'UNKNOWN'}, Message: ${error.message})`);

    // Attempt 2: Port 587 (TLS / STARTTLS fallback)
    try {
      console.log(`[OTP EMAIL] 🔄 Retrying via Port 587 (STARTTLS)...`);
      const transporter587 = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: 587,
        secure: false,
        requireTLS: true,
        connectionTimeout: 8000,
        greetingTimeout: 5000,
        socketTimeout: 8000,
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      });

      await transporter587.sendMail(mailOptions);
      console.log(`[OTP EMAIL] ✅ Email sent successfully via Port 587 to ${smtpUser}`);
      return true;
    } catch (fallbackError) {
      console.error(`[OTP EMAIL] ❌ Port 587 fallback also failed.`);
      console.error(`[OTP EMAIL] Error code: ${fallbackError.code}`);
      console.error(`[OTP EMAIL] Error message: ${fallbackError.message}`);
      if (fallbackError.response) console.error(`[OTP EMAIL] SMTP response: ${fallbackError.response}`);
      return false;
    }
  }
}

// Send user login notification (for Discord & Telegram)
export async function sendLoginNotification(userId, username, ipAddress = '') {
  try {
    const settings = await getSettings(userId);
    const { telegram_bot_token, telegram_chat_id, discord_webhook_url } = resolveNotificationSettings(settings);
    const nowStr = new Date().toLocaleString();
    const keywords = settings.keywords || 'None';
    const location = settings.location || 'None';

    // 1. Telegram
    if (telegram_bot_token && telegram_chat_id) {
      const text = `🔐 <b>User Login Event</b>\n\n` +
                   `👤 <b>User:</b> ${escapeHTML(username)} (ID: ${userId})\n` +
                   `🔍 <b>Keywords:</b> ${escapeHTML(keywords)}\n` +
                   `📍 <b>Location:</b> ${escapeHTML(location)}\n` +
                   `🕒 <b>Time:</b> ${escapeHTML(nowStr)}\n` +
                   (ipAddress ? `🌐 <b>IP:</b> ${escapeHTML(ipAddress)}\n` : '');

      await axios.post(`https://api.telegram.org/bot${telegram_bot_token}/sendMessage`, {
        chat_id: telegram_chat_id,
        text: text,
        parse_mode: 'HTML'
      }).catch(() => {});
    }

    // 2. Discord
    if (discord_webhook_url) {
      await axios.post(discord_webhook_url, {
        embeds: [{
          title: '🔐 User Login Event',
          color: 3447003, // Blue color
          fields: [
            { name: '👤 Username', value: username, inline: true },
            { name: '🆔 User ID', value: String(userId), inline: true },
            { name: '🔍 Keywords', value: keywords, inline: true },
            { name: '📍 Location', value: location, inline: true },
            { name: '🕒 Time', value: nowStr, inline: false },
            ...(ipAddress ? [{ name: '🌐 IP Address', value: ipAddress, inline: true }] : [])
          ],
          timestamp: new Date().toISOString()
        }]
      }).catch(() => {});
    }

    // Always send copy to admin notification
    await sendAdminNotification(`User logged in: ${username} (ID: ${userId}) [Keywords: ${keywords}, Location: ${location}] at ${nowStr}`);
  } catch (err) {
    console.error('Failed to send login notification:', err.message);
  }
}

// Send job search scan notification
export async function sendSearchNotification(userId, searchInfo) {
  try {
    const settings = await getSettings(userId);
    const { telegram_bot_token, telegram_chat_id, discord_webhook_url } = resolveNotificationSettings(settings);
    const nowStr = new Date().toLocaleString();
    const { keywords, location, totalDiscovered, newAdded } = searchInfo;

    // 1. Telegram
    if (telegram_bot_token && telegram_chat_id) {
      const text = `🔍 <b>Job Scan Completed</b>\n\n` +
                   `🏷️ <b>Keywords:</b> ${escapeHTML(keywords || 'All')}\n` +
                   `📍 <b>Location:</b> ${escapeHTML(location || 'Global')}\n` +
                   `📊 <b>Discovered:</b> ${totalDiscovered} potential jobs\n` +
                   `✨ <b>New Added:</b> ${newAdded} new jobs\n` +
                   `🕒 <b>Time:</b> ${escapeHTML(nowStr)}`;

      await axios.post(`https://api.telegram.org/bot${telegram_bot_token}/sendMessage`, {
        chat_id: telegram_chat_id,
        text: text,
        parse_mode: 'HTML'
      }).catch(() => {});
    }

    // 2. Discord
    if (discord_webhook_url) {
      await axios.post(discord_webhook_url, {
        embeds: [{
          title: '🔍 Job Scan Completed',
          color: 3066993, // Green color
          fields: [
            { name: '🏷️ Keywords', value: keywords || 'All', inline: true },
            { name: '📍 Location', value: location || 'Global', inline: true },
            { name: '📊 Discovered', value: String(totalDiscovered), inline: true },
            { name: '✨ New Added', value: String(newAdded), inline: true }
          ],
          footer: { text: `Executed at ${nowStr}` },
          timestamp: new Date().toISOString()
        }]
      }).catch(() => {});
    }
  } catch (err) {
    console.error('Failed to send search notification:', err.message);
  }
}

// Send test notification to verify credentials
export async function sendTestNotification(userId, settings) {
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
      await addLog(userId, 'INFO', 'Test notification sent to Telegram.');
      sent = true;
    } catch (err) {
      await addLog(userId, 'ERROR', `Failed to send Telegram test notification: ${err.message}`);
      throw new Error(`Telegram error: ${err.response?.data?.description || err.message}`);
    }
  }

  if (discord_webhook_url) {
    try {
      await axios.post(discord_webhook_url, {
        content: `🔔 **Job Notifier Test**\nYour job alert system is successfully configured! You will receive notifications here when matching jobs are found.`
      });
      await addLog(userId, 'INFO', 'Test notification sent to Discord.');
      sent = true;
    } catch (err) {
      await addLog(userId, 'ERROR', `Failed to send Discord test notification: ${err.message}`);
      throw new Error(`Discord error: ${err.message}`);
    }
  }

  if (!sent) {
    throw new Error('No notification credentials provided. Please configure Telegram or Discord settings.');
  }

  return true;
}

// Helper to pause execution briefly for rate-limiting
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Send single job notification
export async function sendJobNotification(userId, job, settings) {
  const { telegram_bot_token, telegram_chat_id, discord_webhook_url } = resolveNotificationSettings(settings);
  
  if (!telegram_bot_token && !telegram_chat_id && !discord_webhook_url) {
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
      await addLog(userId, 'ERROR', `Telegram notify failed for job "${title}": ${err.message}`);
    }
  }

  // 2. Discord Send with 300ms delay to prevent HTTP 429 rate limit
  if (discord_webhook_url) {
    try {
      await sleep(300);
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
      await addLog(userId, 'ERROR', `Discord notify failed for job "${title}": ${err.message}`);
    }
  }
}

// Send admin notification when other users perform actions
export async function sendAdminNotification(message) {
  // Dedicated ops webhook (ADMIN_DISCORD_WEBHOOK_URL) — separate from any user's personal
  // discord_webhook_url setting, so this only ever carries app-wide events (new signups,
  // logins), never gets mixed with — or accidentally receives — another user's job alerts.
  const adminWebhook = process.env.ADMIN_DISCORD_WEBHOOK_URL;
  if (adminWebhook) {
    try {
      await axios.post(adminWebhook, {
        embeds: [{
          title: '👑 Job Notifier — App Update',
          description: message,
          color: 16766720,
          timestamp: new Date().toISOString()
        }]
      });
    } catch (err) {
      console.error('Failed to send admin ops webhook notification:', err.message);
    }
  }

  try {
    const admins = await getAdminUsers();
    if (!admins || admins.length === 0) return;

    for (const admin of admins) {
      try {
        const adminSettings = await getSettings(admin.id);
        if (!adminSettings) continue;

        const { telegram_bot_token, telegram_chat_id, discord_webhook_url } = resolveNotificationSettings(adminSettings);
        
        // 1. Telegram
        if (telegram_bot_token && telegram_chat_id) {
          const text = `👑 <b>Admin Alert:</b>\n\n${escapeHTML(message)}`;
          await axios.post(`https://api.telegram.org/bot${telegram_bot_token}/sendMessage`, {
            chat_id: telegram_chat_id,
            text: text,
            parse_mode: 'HTML'
          }).catch(() => {});
        }

        // 2. Discord
        if (discord_webhook_url) {
          await axios.post(discord_webhook_url, {
            embeds: [{
              title: '👑 Admin Alert',
              description: message,
              color: 16766720, // Gold color
              timestamp: new Date().toISOString()
            }]
          }).catch(() => {});
        }
      } catch (adminErr) {
        console.error(`Failed to send admin notification to admin ID ${admin.id}:`, adminErr.message);
      }
    }
  } catch (err) {
    console.error('Failed to send admin notification:', err.message);
  }
}
