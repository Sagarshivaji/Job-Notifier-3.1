import { getAllUsers, getSettings, addLog } from './db.js';
import { scrapeJobs } from './scraper.js';

let periodicTimerId = null;
let initialRunTimerId = null;

function clearAllTimers() {
  if (initialRunTimerId) {
    clearTimeout(initialRunTimerId);
    initialRunTimerId = null;
  }
  if (periodicTimerId) {
    clearTimeout(periodicTimerId);
    periodicTimerId = null;
  }
}

// Start the scheduler loop — runs an immediate scrape once, then repeats every 10 minutes.
// Only call this on server boot; use restartScheduler() for settings changes.
export async function startScheduler() {
  clearAllTimers();

  await addLog(null, 'INFO', `Global scheduler started. Checking for jobs every 10 minutes.`);

  initialRunTimerId = setTimeout(async () => {
    initialRunTimerId = null;
    try {
      await scrapeAllUsers();
    } catch (err) {
      console.error('Initial background check failed:', err);
    }
  }, 1000);

  scheduleNextRun();
}

// Stop the scheduler loop entirely
export async function stopScheduler() {
  const wasRunning = Boolean(periodicTimerId || initialRunTimerId);
  clearAllTimers();
  if (wasRunning) {
    await addLog(null, 'INFO', 'Global scheduler stopped.');
  }
}

// Re-arm the periodic timer after a settings change. Deliberately does NOT trigger an
// immediate scrape — it used to, but that meant every autosaved preference edit (keywords,
// location, a source checkbox) kicked off a full multi-platform scrape, and rapid edits
// stacked up into overlapping concurrent scans. Users who want an on-demand scan already
// have the explicit "Scan Jobs Now" button (/api/scrape/trigger), which is unaffected.
export async function restartScheduler() {
  scheduleNextRun();
}

async function scrapeAllUsers() {
  const users = await getAllUsers();
  for (const user of users) {
    try {
      const settings = await getSettings(user.id);
      if (settings.scrape_active === '1') {
        await scrapeJobs(user.id, false); // pass false for isManual
      }
    } catch (err) {
      console.error(`Scrape task failed for user ${user.id}:`, err);
    }
  }
}

function scheduleNextRun() {
  if (periodicTimerId) {
    clearTimeout(periodicTimerId);
  }

  const ms = 10 * 60 * 1000; // Fixed at 10 minutes for multi-user
  periodicTimerId = setTimeout(async () => {
    try {
      await scrapeAllUsers();
    } finally {
      scheduleNextRun();
    }
  }, ms);
}
