import express from 'express';
import cors from 'cors';
import {
  initDb,
  getJobs,
  getJob,
  deleteJob,
  clearJobs,
  getSettings,
  updateSetting,
  getLogs,
  clearLogs,
  toggleJobApplied,
  addLog
} from './db.js';
import { scrapeJobs } from './scraper.js';
import { startScheduler, restartScheduler } from './scheduler.js';
import { sendTestNotification, sendJobNotification } from './notifier.js';

const app = express();
const isVercelRuntime = Boolean(process.env.VERCEL);
let initializationPromise = null;

app.use(cors());
app.use(express.text({ type: ['application/json', 'application/*+json'], limit: '1mb' }));
app.use((req, res, next) => {
  const contentType = String(req.headers['content-type'] || '');
  if (contentType.includes('application/json')) {
    if (typeof req.body === 'string') {
      try {
        req.body = req.body ? JSON.parse(req.body) : {};
      } catch (err) {
        console.error('Invalid JSON payload:', err, 'rawBody=', req.body);
        return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
      }
    }
  }
  next();
});

// Initialize DB before handling any request (critical for Vercel cold starts)
app.use(async (req, res, next) => {
  try {
    await initializeApp();
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await getJobs(200);
    res.json({ success: true, data: jobs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/jobs/:id/applied', async (req, res) => {
  const { id } = req.params;
  const { applied } = req.body;
  try {
    await toggleJobApplied(id, applied);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/jobs', async (req, res) => {
  try {
    await clearJobs();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await deleteJob(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  const settings = req.body;
  try {
    for (const [key, value] of Object.entries(settings)) {
      await updateSetting(key, String(value));
    }
    await addLog('INFO', 'Settings updated.');
    await restartScheduler();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings/test-notification', async (req, res) => {
  const settings = req.body;
  try {
    await sendTestNotification(settings);
    res.json({ success: true, message: 'Test notification sent successfully!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const logs = await getLogs(150);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/logs/clear', async (req, res) => {
  try {
    await clearLogs();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/scrape/trigger', async (req, res) => {
  try {
    if (isVercelRuntime) {
      await scrapeJobs(true);
      res.json({ success: true, message: 'Manual sync completed.' });
    } else {
      scrapeJobs(true).catch(err => console.error('Manual scraping run failed:', err));
      res.json({ success: true, message: 'Manual sync triggered in the background.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export async function initializeApp() {
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    await initDb();
    if (!isVercelRuntime) {
      await startScheduler();
    }
  })();

  return initializationPromise;
}

export { app };


export async function startServer() {
  try {
    await initializeApp();
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`Job Notifier Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to initialize or launch Express server:', err);
    process.exit(1);
  }
}

if (!isVercelRuntime && process.env.NODE_ENV !== 'test') {
  startServer();
}
