import sqlite3 from 'sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Vercel's serverless runtime has a read-only filesystem — only /tmp is writable.
// Use /tmp when deployed on Vercel, and the local project dir otherwise.
const isVercel = Boolean(process.env.VERCEL);
const dbPath = isVercel
  ? '/tmp/job_notifier.db'
  : join(__dirname, 'job_notifier.db');

const db = new sqlite3.Database(dbPath);

// Helper to run query as promise
export function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// Helper to get single row
export function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Helper to get all rows
export function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

const DEFAULT_ENABLED_SOURCES = ['linkedin', 'weworkremotely', 'dice', 'naukri', 'simplyhired'];

export function normalizeEnabledSources(enabledSources) {
  let parsed = [];
  if (Array.isArray(enabledSources)) {
    parsed = enabledSources;
  } else if (typeof enabledSources === 'string') {
    try {
      parsed = JSON.parse(enabledSources);
    } catch (e) {
      parsed = [];
    }
  }

  const normalized = Array.isArray(parsed) ? parsed : [];
  const merged = [...new Set([...normalized, ...DEFAULT_ENABLED_SOURCES])];
  return merged.filter(source =>
    DEFAULT_ENABLED_SOURCES.includes(source) ||
    source === 'linkedin' ||
    source === 'adzuna' ||
    source === 'weworkremotely' ||
    source === 'remoteok' ||
    source === 'workingnomads'
  );
}

// Initialize tables and seed defaults
export async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      company TEXT,
      url TEXT UNIQUE NOT NULL,
      source TEXT,
      description TEXT,
      salary TEXT,
      location TEXT,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notified INTEGER DEFAULT 0,
      applied INTEGER DEFAULT 0
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);

  const defaults = {
    keywords: 'React, Node, Python, Developer, Engineer',
    telegram_bot_token: '',
    telegram_chat_id: '',
    discord_webhook_url: '',
    scrape_interval_mins: '10',
    enabled_sources: JSON.stringify(DEFAULT_ENABLED_SOURCES),
    scrape_active: '1',
    location: 'United States',
    country_code: 'us',
    work_type: 'onsite',
    adzuna_app_id: '',
    adzuna_app_key: ''
  };

  for (const [key, val] of Object.entries(defaults)) {
    await run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, val]);
  }

  await addLog('INFO', 'Database initialized successfully.');
}

function getEnvSettings() {
  return {
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
    telegram_chat_id: process.env.TELEGRAM_CHAT_ID || '',
    discord_webhook_url: process.env.DISCORD_WEBHOOK_URL || '',
    adzuna_app_id: process.env.ADZUNA_APP_ID || '',
    adzuna_app_key: process.env.ADZUNA_APP_KEY || '',
    country_code: process.env.ADZUNA_COUNTRY_CODE || ''
  };
}

// Settings helpers
export async function getSettings() {
  const rows = await all('SELECT * FROM settings');
  const settings = {};
  rows.forEach(row => {
    settings[row.key] = row.value;
  });

  // Override with environment variables if set (useful for Vercel env config)
  const envSettings = getEnvSettings();
  for (const [key, value] of Object.entries(envSettings)) {
    if (value) {
      settings[key] = value;
    }
  }

  if (settings.enabled_sources) {
    settings.enabled_sources = JSON.stringify(normalizeEnabledSources(settings.enabled_sources));
  }

  return settings;
}

export async function updateSetting(key, value) {
  await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

// Log helpers
export async function addLog(level, message) {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
  try {
    await run('INSERT INTO logs (level, message) VALUES (?, ?)', [level, message]);
    // Limit logs to the last 1000 entries to prevent DB bloat
    await run('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY timestamp DESC LIMIT 1000)');
  } catch (err) {
    console.error('Failed to log to database:', err);
  }
}

export async function getLogs(limit = 100) {
  return all('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?', [limit]);
}

export async function clearLogs() {
  await run('DELETE FROM logs');
  await addLog('INFO', 'Logs cleared.');
}

// Jobs helpers
export async function addJob(job) {
  try {
    await run(
      `INSERT INTO jobs (id, title, company, url, source, description, salary, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [job.id, job.title, job.company, job.url, job.source, job.description, job.salary || '', job.location || '']
    );
    return true; // Added successfully
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return false; // Already exists, skipped
    }
    throw err;
  }
}

export async function getJobs(limit = 100) {
  return all('SELECT * FROM jobs ORDER BY discovered_at DESC LIMIT ?', [limit]);
}

export async function getUnnotifiedJobs() {
  return all('SELECT * FROM jobs WHERE notified = 0');
}

export async function markJobAsNotified(id) {
  await run('UPDATE jobs SET notified = 1 WHERE id = ?', [id]);
}

export async function toggleJobApplied(id, applied) {
  await run('UPDATE jobs SET applied = ? WHERE id = ?', [applied ? 1 : 0, id]);
}

export async function deleteJob(id) {
  await run('DELETE FROM jobs WHERE id = ?', [id]);
}

export async function getJob(id) {
  return get('SELECT * FROM jobs WHERE id = ?', [id]);
}

export async function clearJobs() {
  await run('DELETE FROM jobs');
  await addLog('INFO', 'All jobs have been cleared.');
}
