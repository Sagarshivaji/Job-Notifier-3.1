import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Detect whether PostgreSQL connection string is provided
const rawUrl = (process.env.DATABASE_URL || '').replace('channel_binding=require', '').replace(/[?&]$/, '').trim();
const isPostgres = Boolean(rawUrl && (rawUrl.startsWith('postgres://') || rawUrl.startsWith('postgresql://')));

let pool = null;
let sqliteDb = null;

if (isPostgres) {
  const { Pool } = pg;
  const poolConfig = {
    connectionString: rawUrl,
    ssl: { rejectUnauthorized: false },
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    max: 5
  };
  pool = new Pool(poolConfig);
  pool.on('error', (err) => {
    console.error('[PG Pool] Unexpected client error:', err.message);
  });
} else {
  // Use existing SQLite database (job_notifier_v2.db or job_notifier.db)
  const v2Path = join(__dirname, 'job_notifier_v2.db');
  const v1Path = join(__dirname, 'job_notifier.db');
  const dbPath = fs.existsSync(v2Path) ? v2Path : v1Path;
  sqliteDb = new DatabaseSync(dbPath);
  sqliteDb.exec('PRAGMA foreign_keys = ON;');
}

function convertSqlToSqlite(sql) {
  // Convert Postgres $1, $2, ... parameters to SQLite ?
  let s = sql.replace(/\$\d+/g, '?');
  // Remove Postgres-specific ::int type casting
  s = s.replace(/::int/g, '');
  return s;
}

// Generic query wrapper - replaces sqlite3 / pg run/get/all
export async function run(sql, params = []) {
  if (isPostgres) {
    const client = await pool.connect();
    try {
      const result = await client.query(sql, params);
      return { lastID: result.rows[0]?.id ?? null, changes: result.rowCount };
    } finally {
      client.release();
    }
  } else {
    const sqliteSql = convertSqlToSqlite(sql);
    const stmt = sqliteDb.prepare(sqliteSql);
    const info = stmt.run(...params);
    return { lastID: info.lastInsertRowid, changes: info.changes };
  }
}

export async function get(sql, params = []) {
  if (isPostgres) {
    const result = await pool.query(sql, params);
    return result.rows[0] || null;
  } else {
    const sqliteSql = convertSqlToSqlite(sql);
    const stmt = sqliteDb.prepare(sqliteSql);
    const row = stmt.get(...params);
    return row || null;
  }
}

export async function all(sql, params = []) {
  if (isPostgres) {
    const result = await pool.query(sql, params);
    return result.rows;
  } else {
    const sqliteSql = convertSqlToSqlite(sql);
    const stmt = sqliteDb.prepare(sqliteSql);
    return stmt.all(...params);
  }
}

const DEFAULT_ENABLED_SOURCES = ['linkedin', 'weworkremotely', 'remoteok', 'remotive', 'workingnomads', 'jobspresso', 'adzuna', 'hackernews'];

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
  return merged.filter(source => DEFAULT_ENABLED_SOURCES.includes(source) || source === 'dice' || source === 'naukri' || source === 'simplyhired' || source === 'adzuna' || source === 'indeed' || source === 'glassdoor' || source === 'google');
}

export async function initDb() {
  if (isPostgres) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        job_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        company TEXT,
        url TEXT NOT NULL,
        source TEXT,
        description TEXT,
        salary TEXT,
        location TEXT,
        discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        notified INTEGER DEFAULT 0,
        applied INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Discovered',
        FOREIGN KEY(user_id) REFERENCES users(id),
        UNIQUE(user_id, job_hash)
      )
    `);

    // Ensure status, match_score, match_reasons columns exist in Postgres
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='status') THEN
          ALTER TABLE jobs ADD COLUMN status TEXT DEFAULT 'Discovered';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='match_score') THEN
          ALTER TABLE jobs ADD COLUMN match_score INTEGER DEFAULT NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='match_reasons') THEN
          ALTER TABLE jobs ADD COLUMN match_reasons TEXT DEFAULT NULL;
        END IF;
      END $$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_resumes (
        user_id INTEGER PRIMARY KEY,
        filename TEXT,
        resume_text TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);
  } else {
    // SQLite table initialization
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        job_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        company TEXT,
        url TEXT NOT NULL,
        source TEXT,
        description TEXT,
        salary TEXT,
        location TEXT,
        discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        notified INTEGER DEFAULT 0,
        applied INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Discovered',
        FOREIGN KEY(user_id) REFERENCES users(id),
        UNIQUE(user_id, job_hash)
      );

      CREATE TABLE IF NOT EXISTS settings (
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS user_resumes (
        user_id INTEGER PRIMARY KEY,
        filename TEXT,
        resume_text TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);

    // Ensure status, match_score, match_reasons columns exist in SQLite
    const cols = sqliteDb.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
    if (!cols.includes('status')) {
      sqliteDb.exec("ALTER TABLE jobs ADD COLUMN status TEXT DEFAULT 'Discovered';");
    }
    if (!cols.includes('match_score')) {
      sqliteDb.exec("ALTER TABLE jobs ADD COLUMN match_score INTEGER DEFAULT NULL;");
    }
    if (!cols.includes('match_reasons')) {
      sqliteDb.exec("ALTER TABLE jobs ADD COLUMN match_reasons TEXT DEFAULT NULL;");
    }
  }

  // Ensure applied jobs have consistent status
  try {
    await run(`UPDATE jobs SET status = 'Applied' WHERE applied = 1 AND (status IS NULL OR status = 'Discovered')`);
  } catch (_) {}

  // Auto-seed admin account: create 'sagar shivaji' if it doesn't exist, then ensure correct password + admin flag
  try {
    const adminPassHash = '$2a$10$KKCI6FRYZHFl80fNpvxUfOIb4s7NRdXcRO0sfcE2YGQWg6uMQiXSi'; // password: 191179152
    
    await run(
      `INSERT INTO users (username, password_hash, is_admin) VALUES ('sagar shivaji', $1, 1)
       ON CONFLICT (username) DO NOTHING`,
      [adminPassHash]
    );

    await run(
      `UPDATE users SET is_admin = 1, password_hash = $1 WHERE LOWER(username) = 'sagar shivaji'`,
      [adminPassHash]
    );

    const adminRow = await get(`SELECT id FROM users WHERE LOWER(username) = 'sagar shivaji'`);
    if (adminRow) {
      const defaults = {
        keywords: 'React, Node, Python, Developer, Engineer',
        telegram_bot_token: '',
        telegram_chat_id: '',
        discord_webhook_url: '',
        scrape_interval_mins: '10',
        enabled_sources: JSON.stringify(DEFAULT_ENABLED_SOURCES),
        scrape_active: '1',
        location: 'India',
        country_code: 'in',
        work_type: 'onsite',
        adzuna_app_id: '',
        adzuna_app_key: '',
        experience_level: 'all',
        date_posted: '24h'
      };
      for (const [key, val] of Object.entries(defaults)) {
        await run(
          `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (user_id, key) DO NOTHING`,
          [adminRow.id, key, val]
        );
      }
    }
  } catch (e) {
    console.error('[DB] Admin seed error:', e.message);
  }

  await addLog(null, 'INFO', `Database initialized successfully (${isPostgres ? 'PostgreSQL' : 'SQLite'}).`);
}

// User helpers
export async function createUser(username, password_hash) {
  const cleanUsername = (username || '').trim();

  let newUserId;
  if (isPostgres) {
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, 0) RETURNING id',
      [cleanUsername, password_hash]
    );
    newUserId = result.rows[0].id;
  } else {
    const info = await run(
      'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, 0)',
      [cleanUsername, password_hash]
    );
    newUserId = Number(info.lastID);
  }

  // Seed default settings for the new user
  const defaults = {
    keywords: 'React, Node, Python, Developer, Engineer',
    telegram_bot_token: '',
    telegram_chat_id: '',
    discord_webhook_url: '',
    scrape_interval_mins: '10',
    enabled_sources: JSON.stringify(DEFAULT_ENABLED_SOURCES),
    scrape_active: '1',
    location: 'India',
    country_code: 'in',
    work_type: 'onsite',
    adzuna_app_id: '',
    adzuna_app_key: '',
    experience_level: 'all',
    date_posted: '24h'
  };

  for (const [key, val] of Object.entries(defaults)) {
    await run(
      `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (user_id, key) DO NOTHING`,
      [newUserId, key, val]
    );
  }
  return newUserId;
}

export async function getUserByUsername(username) {
  const cleanUsername = (username || '').trim();
  return get('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [cleanUsername]);
}

export async function getUserById(id) {
  return get('SELECT * FROM users WHERE id = $1', [id]);
}

export async function getAllUsers() {
  return all(`
    SELECT u.id, u.username, u.is_admin, u.created_at, u.last_login_at,
           COUNT(j.id)::int as job_count
    FROM users u
    LEFT JOIN jobs j ON j.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);
}

export async function getAdminUsers() {
  return all('SELECT * FROM users WHERE is_admin = 1');
}

export async function recordLogin(userId) {
  await run('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [userId]);
}

export async function getUserLogs(userId, limit = 100) {
  return all('SELECT * FROM logs WHERE user_id = $1 ORDER BY timestamp DESC LIMIT $2', [userId, limit]);
}

// Settings helpers
export async function getSettings(userId) {
  const rows = await all('SELECT * FROM settings WHERE user_id = $1', [userId]);
  const settings = {};
  rows.forEach(row => {
    settings[row.key] = row.value;
  });

  if (settings.enabled_sources) {
    settings.enabled_sources = JSON.stringify(normalizeEnabledSources(settings.enabled_sources));
  }
  return settings;
}

export async function updateSetting(userId, key, value) {
  await run(
    `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [userId, key, value]
  );
}

// Log helpers
export async function addLog(userId, level, message) {
  console.log(`[${new Date().toISOString()}] [User:${userId || 'SYSTEM'}] [${level}] ${message}`);
  try {
    if (userId) {
      await run('INSERT INTO logs (user_id, level, message) VALUES ($1, $2, $3)', [userId, level, message]);
      await run(
        `DELETE FROM logs WHERE user_id = $1 AND id NOT IN (
          SELECT id FROM logs WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 1000
        )`,
        [userId]
      );
    } else {
      await run('INSERT INTO logs (level, message) VALUES ($1, $2)', [level, message]);
      await run(
        `DELETE FROM logs WHERE user_id IS NULL AND id NOT IN (
          SELECT id FROM logs WHERE user_id IS NULL ORDER BY timestamp DESC LIMIT 1000
        )`
      );
    }
  } catch (err) {
    console.error('Failed to log to database:', err);
  }
}

export async function getLogs(userId, limit = 100) {
  return all('SELECT * FROM logs WHERE user_id = $1 ORDER BY timestamp DESC LIMIT $2', [userId, limit]);
}

export async function clearLogs(userId) {
  await run('DELETE FROM logs WHERE user_id = $1', [userId]);
  await addLog(userId, 'INFO', 'Logs cleared.');
}

// Jobs helpers
export async function addJob(userId, job) {
  try {
    const jobStatus = job.status || 'Discovered';
    await run(
      `INSERT INTO jobs (user_id, job_hash, title, company, url, source, description, salary, location, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [userId, job.id, job.title, job.company, job.url, job.source, job.description, job.salary || '', job.location || '', jobStatus]
    );
    return true; // Added successfully
  } catch (err) {
    if (err.message && (
      err.message.includes('unique constraint') || 
      err.message.includes('duplicate key') || 
      err.message.includes('UNIQUE constraint') ||
      err.message.includes('PRIMARY KEY')
    )) {
      return false; // Already exists, skipped
    }
    throw err;
  }
}

export async function getJobs(userId, limit = 200) {
  const jobs = await all('SELECT * FROM jobs WHERE user_id = $1 ORDER BY discovered_at DESC LIMIT $2', [userId, limit]);
  // Re-map job_hash back to id for the frontend
  return jobs.map(j => ({
    ...j,
    id: j.id.toString(),
    hash: j.job_hash,
    status: j.status || (j.applied === 1 ? 'Applied' : 'Discovered'),
    match_score: j.match_score !== null && j.match_score !== undefined ? Number(j.match_score) : null,
    match_reasons: j.match_reasons || null
  }));
}

export async function getJobById(userId, id) {
  const isNumeric = !isNaN(Number(id));
  let job = null;
  if (userId) {
    if (isNumeric) {
      job = await get('SELECT * FROM jobs WHERE user_id = $1 AND id = $2', [userId, Number(id)]);
    }
    if (!job) {
      job = await get('SELECT * FROM jobs WHERE user_id = $1 AND job_hash = $2', [userId, String(id)]);
    }
  }
  if (!job) {
    if (isNumeric) {
      job = await get('SELECT * FROM jobs WHERE id = $1', [Number(id)]);
    } else {
      job = await get('SELECT * FROM jobs WHERE job_hash = $1', [String(id)]);
    }
  }
  if (!job) return null;
  return {
    ...job,
    id: job.id.toString(),
    hash: job.job_hash,
    status: job.status || (job.applied === 1 ? 'Applied' : 'Discovered'),
    match_score: job.match_score !== null && job.match_score !== undefined ? Number(job.match_score) : null,
    match_reasons: job.match_reasons || null
  };
}

export async function updateJobStatus(userId, id, status) {
  const validStatuses = ['Discovered', 'Saved', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Archived'];
  const formattedStatus = validStatuses.find(s => s.toLowerCase() === (status || '').toLowerCase()) || status || 'Saved';
  const appliedValue = ['applied', 'interviewing', 'offer'].includes(formattedStatus.toLowerCase()) ? 1 : 0;

  const isNumeric = !isNaN(Number(id));
  let existing = null;
  if (userId) {
    if (isNumeric) {
      existing = await get('SELECT * FROM jobs WHERE user_id = $1 AND id = $2', [userId, Number(id)]);
    }
    if (!existing) {
      existing = await get('SELECT * FROM jobs WHERE user_id = $1 AND job_hash = $2', [userId, String(id)]);
    }
  }
  if (!existing) {
    if (isNumeric) {
      existing = await get('SELECT * FROM jobs WHERE id = $1', [Number(id)]);
    } else {
      existing = await get('SELECT * FROM jobs WHERE job_hash = $1', [String(id)]);
    }
  }

  if (!existing) return null;

  await run(
    'UPDATE jobs SET status = $1, applied = $2 WHERE id = $3',
    [formattedStatus, appliedValue, existing.id]
  );

  await addLog(existing.user_id, 'INFO', `Job #${existing.id} ("${existing.title}") status updated to "${formattedStatus}"`);

  return {
    ...existing,
    id: existing.id.toString(),
    hash: existing.job_hash,
    status: formattedStatus,
    applied: appliedValue
  };
}

export async function getUnnotifiedJobs(userId) {
  return all('SELECT * FROM jobs WHERE user_id = $1 AND notified = 0', [userId]);
}

export async function markJobAsNotified(userId, jobHash) {
  await run('UPDATE jobs SET notified = 1 WHERE user_id = $1 AND job_hash = $2', [userId, jobHash]);
}

export async function toggleJobApplied(userId, id, applied) {
  const status = applied ? 'Applied' : 'Discovered';
  await run('UPDATE jobs SET applied = $1, status = $2 WHERE user_id = $3 AND id = $4', [applied ? 1 : 0, status, userId, id]);
}

export async function deleteJob(userId, id) {
  await run('DELETE FROM jobs WHERE user_id = $1 AND id = $2', [userId, id]);
}

export async function resetJobs(userId) {
  await run('DELETE FROM jobs WHERE user_id = $1', [userId]);
}

// Resume helpers
export async function saveUserResume(userId, filename, text) {
  await run(
    `INSERT INTO user_resumes (user_id, filename, resume_text, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET filename = EXCLUDED.filename, resume_text = EXCLUDED.resume_text, updated_at = CURRENT_TIMESTAMP`,
    [userId, filename, text]
  );
  await addLog(userId, 'INFO', `Resume "${filename || 'resume.txt'}" saved (${text.length} chars).`);
  return { user_id: userId, filename, length: text.length };
}

export async function getUserResume(userId) {
  return get('SELECT user_id, filename, resume_text, updated_at FROM user_resumes WHERE user_id = $1', [userId]);
}

export async function updateJobMatch(userId, id, matchScore, matchReasons) {
  const isNumeric = !isNaN(Number(id));
  let existing = null;
  if (userId) {
    if (isNumeric) {
      existing = await get('SELECT * FROM jobs WHERE user_id = $1 AND id = $2', [userId, Number(id)]);
    }
    if (!existing) {
      existing = await get('SELECT * FROM jobs WHERE user_id = $1 AND job_hash = $2', [userId, String(id)]);
    }
  }
  if (!existing) {
    if (isNumeric) {
      existing = await get('SELECT * FROM jobs WHERE id = $1', [Number(id)]);
    } else {
      existing = await get('SELECT * FROM jobs WHERE job_hash = $1', [String(id)]);
    }
  }
  if (!existing) return null;

  const score = Math.max(0, Math.min(100, Math.round(Number(matchScore) || 0)));
  await run(
    'UPDATE jobs SET match_score = $1, match_reasons = $2 WHERE id = $3',
    [score, matchReasons || '', existing.id]
  );

  await addLog(existing.user_id, 'INFO', `Job #${existing.id} ("${existing.title}") match score evaluated: ${score}%`);

  return {
    ...existing,
    id: existing.id.toString(),
    hash: existing.job_hash,
    match_score: score,
    match_reasons: matchReasons || ''
  };
}
