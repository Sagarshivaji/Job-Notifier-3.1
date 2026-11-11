import { getSettings, addLog } from './db.js';
import { scrapeJobs } from './scraper.js';

let timerId = null;
let currentIntervalMins = 10;

export async function startScheduler() {
  await stopScheduler();

  const settings = await getSettings();
  const intervalMins = parseInt(settings.scrape_interval_mins || '10', 10);
  const isActive = settings.scrape_active === '1';

  if (!isActive) {
    await addLog('INFO', 'Scheduler is disabled in settings. Background scrape paused.');
    return;
  }

  currentIntervalMins = intervalMins;
  await addLog('INFO', `Scheduler started. Checking for jobs every ${intervalMins} minute(s).`);

  setTimeout(async () => {
    try {
      await scrapeJobs();
    } catch (err) {
      console.error('Initial background check failed:', err);
    }
  }, 1000);

  scheduleNextRun();
}

export async function stopScheduler() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
    await addLog('INFO', 'Scheduler stopped.');
  }
}

export async function restartScheduler() {
  await addLog('INFO', 'Restarting scheduler...');
  await startScheduler();
}

function scheduleNextRun() {
  if (timerId) {
    clearTimeout(timerId);
  }

  const ms = currentIntervalMins * 60 * 1000;
  timerId = setTimeout(async () => {
    try {
      const settings = await getSettings();
      if (settings.scrape_active === '1') {
        await scrapeJobs();
        scheduleNextRun();
      } else {
        await stopScheduler();
      }
    } catch (err) {
      console.error('Scheduled scrape task failed:', err);
      scheduleNextRun();
    }
  }, ms);
}
