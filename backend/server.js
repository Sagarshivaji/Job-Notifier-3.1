import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import authRouter, { requireAuth, requireAdmin } from './auth.js';
import { 
  initDb, 
  getJobs, 
  getSettings, 
  updateSetting, 
  getLogs, 
  clearLogs, 
  toggleJobApplied, 
  updateJobStatus,
  updateJobMatch,
  saveUserResume,
  getUserResume,
  deleteJob,
  resetJobs,
  addLog,
  getAllUsers,
  getUserLogs,
  addJob,
  markJobAsNotified,
  getJobById
} from './db.js';

import { scrapeJobs, getScanStatus } from './scraper.js';
import { startScheduler, restartScheduler } from './scheduler.js';
import { sendTestNotification, sendJobNotification } from './notifier.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { server as mcpServer } from './mcp-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;
const isVercelRuntime = Boolean(process.env.VERCEL);
let initializationPromise = null;

// Allow requests from the browser extension (chrome-extension://) and any web origin.
// This is important so the extension popup and content-script can reach the API
// even when the backend is hosted on a different domain (e.g. Render / Vercel).
app.use(cors({
  origin: (origin, callback) => {
    // Allow: no origin (curl, Postman), chrome-extension://, and any http/https origin
    if (!origin || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://') || origin.startsWith('http://') || origin.startsWith('https://')) {
      return callback(null, true);
    }
    callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.options('*', cors()); // Enable pre-flight for all routes
app.use(express.json());

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

app.use(async (req, res, next) => {
  try {
    await initializeApp();
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Auth Routes
app.use('/api/auth', authRouter);

// Public health check — used by Render to verify the server is alive
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 1. Get job feeds
app.get('/api/jobs', requireAuth, async (req, res) => {
  try {
    const jobs = await getJobs(req.user.id, 200);
    res.json({ success: true, data: jobs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Toggle job applied status
app.post('/api/jobs/:id/applied', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { applied } = req.body;
  try {
    await toggleJobApplied(req.user.id, id, applied);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2.1 Update job status (e.g. Saved, Applied, Interviewing, Offer, Rejected)
app.post('/api/jobs/:id/status', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ success: false, error: 'Status is required' });
  }
  try {
    const updated = await updateJobStatus(req.user.id, id, status);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    res.json({ success: true, job: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/jobs/:id/status', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ success: false, error: 'Status is required' });
  }
  try {
    const updated = await updateJobStatus(req.user.id, id, status);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    res.json({ success: true, job: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2.2 Update job match score (evaluated by Claude via MCP or API)
app.post('/api/jobs/:id/match', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { match_score, match_reasons } = req.body;
  try {
    const updated = await updateJobMatch(req.user.id, id, match_score, match_reasons);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    res.json({ success: true, job: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2.3 User Resume Endpoints
app.get('/api/resume', requireAuth, async (req, res) => {
  try {
    const resume = await getUserResume(req.user.id);
    res.json({ success: true, resume: resume || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/resume', requireAuth, async (req, res) => {
  const { filename, text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ success: false, error: 'Resume text is required' });
  }
  try {
    const saved = await saveUserResume(req.user.id, filename || 'resume.txt', text);
    res.json({ success: true, resume: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: Locate Claude Desktop configuration path
function getClaudeConfigPath() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else {
    return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  }
}

// 2.4 MCP Connection Management
app.get('/api/mcp/status', requireAuth, async (req, res) => {
  try {
    const configPath = getClaudeConfigPath();
    const serverPath = path.resolve(__dirname, 'mcp-server.js');
    let connected = false;
    let configExists = false;

    if (fs.existsSync(configPath)) {
      configExists = true;
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.mcpServers && parsed.mcpServers['job-pulse']) {
          connected = true;
        }
      } catch {}
    }

    res.json({
      success: true,
      connected,
      configExists,
      configPath,
      serverPath
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mcp/connect', requireAuth, async (req, res) => {
  try {
    const configPath = getClaudeConfigPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let config = {};
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {
        config = {};
      }
    }

    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers['job-pulse'] = {
      command: 'node',
      args: [path.resolve(__dirname, 'mcp-server.js')],
      env: {
        NODE_ENV: 'development'
      }
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    res.json({
      success: true,
      connected: true,
      message: 'Connected to Claude Desktop successfully! Please restart Claude Desktop to use your Job Pulse tools.',
      configPath
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mcp/disconnect', requireAuth, async (req, res) => {
  try {
    const configPath = getClaudeConfigPath();
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.mcpServers && parsed.mcpServers['job-pulse']) {
        delete parsed.mcpServers['job-pulse'];
        fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
      }
    }
    res.json({ success: true, connected: false, message: 'Disconnected from Claude Desktop' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Quick match score calculation (Comprehensive ATS Skill & Title Matching Engine)
app.post('/api/jobs/:id/quick-match', requireAuth, async (req, res) => {
  try {
    const job = await getJobById(req.user.id, req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    const userResume = await getUserResume(req.user.id);
    if (!userResume || !userResume.resume_text) {
      return res.status(400).json({ success: false, error: 'Please upload or save your resume first in Resume & Match' });
    }

    const rText = userResume.resume_text.toLowerCase();
    const jTitle = job.title.toLowerCase();
    const jDesc = (job.description || '').toLowerCase();
    const jFull = `${jTitle} ${job.company || ''} ${jDesc}`.toLowerCase();

    // Comprehensive skills and technologies taxonomy
    const techCatalog = [
      // Languages
      'typescript', 'javascript', 'python', 'java', 'c++', 'c#', 'golang', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'sql',
      // Frontend
      'react', 'next.js', 'vue', 'angular', 'svelte', 'tailwind', 'html', 'css', 'redux', 'webpack', 'vite',
      // Backend & APIs
      'node.js', 'node', 'express', 'nest.js', 'django', 'fastapi', 'flask', 'spring boot', 'asp.net', 'graphql', 'rest api', 'grpc', 'microservices',
      // Databases & Caching
      'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'dynamodb', 'cassandra', 'sqlite',
      // Cloud, Infrastructure & DevOps
      'aws', 'azure', 'gcp', 'google cloud', 'docker', 'kubernetes', 'terraform', 'ci/cd', 'linux', 'kafka', 'rabbitmq',
      // Methodologies & Practices
      'agile', 'scrum', 'system design', 'unit testing', 'jest', 'cypress', 'git', 'github', 'security', 'monitoring'
    ];

    // Seniority & Role Levels
    const seniorityLevels = ['intern', 'junior', 'mid', 'senior', 'lead', 'staff', 'principal', 'manager', 'director', 'architect'];

    // 1. Core Technical Skill Overlap
    const jobSkills = techCatalog.filter(s => jFull.includes(s));
    const resumeSkills = techCatalog.filter(s => rText.includes(s));
    const matchedSkills = jobSkills.filter(s => resumeSkills.includes(s));
    const missingSkills = jobSkills.filter(s => !resumeSkills.includes(s));

    // 2. Title & Role Keyword Overlap
    const titleWords = jTitle.split(/[\s,/-]+/).filter(w => w.length > 3 && !['with', 'from', 'jobs', 'role', 'team'].includes(w));
    const matchedTitleWords = titleWords.filter(w => rText.includes(w));
    const titleScore = titleWords.length > 0 ? (matchedTitleWords.length / titleWords.length) : 0.5;

    // 3. Seniority Fit
    const jobSeniority = seniorityLevels.find(lvl => jTitle.includes(lvl));
    const resumeSeniority = seniorityLevels.find(lvl => rText.includes(lvl));
    const seniorityMatch = (!jobSeniority || !resumeSeniority) ? 0.8 : (jobSeniority === resumeSeniority ? 1.0 : 0.65);

    // 4. Calculate Weighted Match Score
    let skillRatio = 0.5;
    if (jobSkills.length > 0) {
      skillRatio = matchedSkills.length / jobSkills.length;
    } else if (matchedSkills.length > 0) {
      skillRatio = Math.min(1.0, matchedSkills.length / 5);
    }

    // Weights: 60% Skills Overlap, 25% Title Match, 15% Seniority Alignment
    const rawScore = (skillRatio * 60) + (titleScore * 25) + (seniorityMatch * 15);
    
    // Normalize into a realistic, honest 35% - 96% range
    let score = Math.round(Math.min(96, Math.max(35, rawScore)));

    // Generate comprehensive evaluation summary
    const matchedFormatted = matchedSkills.map(s => s.toUpperCase());
    const missingFormatted = missingSkills.slice(0, 5).map(s => s.toUpperCase());

    const reasons = [
      `• Match Rating: ${score}% fit for "${job.title}" at ${job.company || 'Company'}.`,
      matchedFormatted.length > 0
        ? `• Confirmed Matching Skills (${matchedFormatted.length}): ${matchedFormatted.join(', ')}`
        : `• Skills Assessment: Found limited direct keyword matches in primary stack.`,
      missingFormatted.length > 0
        ? `• Missing or High-Priority JD Requirements (${missingFormatted.length}): ${missingFormatted.join(', ')}`
        : `• Requirements Check: Meets all primary technical requirements mentioned in posting.`,
      score >= 80 
        ? `• Application Recommendation: Strong candidate fit! Prioritize applying now.`
        : score >= 60 
          ? `• Application Recommendation: Moderate fit. Highlight transferable projects covering ${missingFormatted.slice(0, 2).join(' and ') || 'key requirements'}.`
          : `• Application Recommendation: Low direct overlap. Tailor resume heavily to target missing skills before applying.`,
      `• AI Verification: Claude Desktop or Claude Connector can perform deep conversational interview prep and cover letter generation via MCP.`
    ].filter(Boolean).join('\n');

    const updated = await updateJobMatch(req.user.id, req.params.id, score, reasons);
    res.json({ success: true, score, reasons, job: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================================
// 2.5 MCP HTTP & SSE Endpoints for Claude Custom Connector
// =============================================================================
const mcpTransports = new Map();

// SSE endpoint for Claude custom connector: GET /mcp or GET /sse
app.get(['/mcp', '/sse'], async (req, res) => {
  try {
    const transport = new SSEServerTransport('/mcp/messages', res);
    mcpTransports.set(transport.sessionId, transport);

    transport.onclose = () => {
      mcpTransports.delete(transport.sessionId);
    };

    await mcpServer.connect(transport);
  } catch (err) {
    console.error('Error establishing MCP SSE connection:', err);
    if (!res.headersSent) {
      res.status(500).send('Error connecting to MCP');
    }
  }
});

// Messages endpoint for SSE transport: POST /mcp/messages or POST /sse/messages
app.post(['/mcp/messages', '/sse/messages'], async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = mcpTransports.get(sessionId);
  if (!transport) {
    return res.status(404).send('MCP session not found or expired');
  }
  await transport.handlePostMessage(req, res);
});

// Direct JSON-RPC endpoint for Claude or custom connector
app.post('/mcp', async (req, res) => {
  if (req.query.sessionId && mcpTransports.has(req.query.sessionId)) {
    return mcpTransports.get(req.query.sessionId).handlePostMessage(req, res);
  }
  const { jsonrpc, id, method, params } = req.body || {};
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id: id || 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'job-pulse-mcp-server', version: '1.0.0' }
      }
    });
  }
  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id: id || 1,
      result: {
        tools: [
          {
            name: 'trigger_job_scan',
            description: 'Triggers live job scan across platforms (LinkedIn, Adzuna, etc.) and updates database/feed.',
            inputSchema: {
              type: 'object',
              properties: {
                keywords: { type: 'string', description: 'Comma-separated job keywords' },
                location: { type: 'string', description: 'Location preference' }
              }
            }
          },
          {
            name: 'update_job_status',
            description: 'Updates a job status (Saved, Applied, Interviewing, Offer, Rejected).',
            inputSchema: {
              type: 'object',
              properties: {
                job_id: { type: ['string', 'number'] },
                status: { type: 'string', enum: ['Saved', 'Applied', 'Interviewing', 'Offer', 'Rejected'] }
              },
              required: ['job_id', 'status']
            }
          },
          {
            name: 'get_user_resume',
            description: 'Fetches the user resume for JD match evaluations.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'save_job_match',
            description: 'Saves the Claude-evaluated match percentage score and explanation to the job.',
            inputSchema: {
              type: 'object',
              properties: {
                job_id: { type: ['string', 'number'] },
                score: { type: 'number' },
                reasons: { type: 'string' }
              },
              required: ['job_id', 'score']
            }
          },
          {
            name: 'analyze_job_fit',
            description: 'Returns candidate resume and job description side-by-side for fit evaluation.',
            inputSchema: {
              type: 'object',
              properties: { job_id: { type: ['string', 'number'] } },
              required: ['job_id']
            }
          },
          {
            name: 'add_job',
            description: 'Adds a specific job opening directly into the user\'s Job Pulse feed and dashboard so it appears immediately in the application.',
            inputSchema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Job title' },
                company: { type: 'string', description: 'Company name' },
                url: { type: 'string', description: 'Application or job URL' },
                location: { type: 'string', description: 'Location (e.g. Remote, India)' },
                salary: { type: 'string', description: 'Salary or compensation info' },
                description: { type: 'string', description: 'Job description' },
                match_score: { type: 'number', description: 'Match score percentage 0-100' },
                status: { type: 'string', enum: ['Discovered', 'Saved', 'Applied', 'Interviewing'] }
              },
              required: ['title', 'company']
            }
          },
          {
            name: 'list_jobs',
            description: 'Lists all available jobs in the feed.',
            inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }
          }
        ]
      }
    });
  }

  // Handle direct JSON-RPC tools/call
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    let targetUserId = 22;
    try {
      const users = await getAllUsers();
      if (users && users.length > 0) {
        const sorted = [...users].sort((a, b) => {
          const timeA = a.last_login_at ? new Date(a.last_login_at).getTime() : 0;
          const timeB = b.last_login_at ? new Date(b.last_login_at).getTime() : 0;
          return timeB - timeA;
        });
        targetUserId = sorted[0].id;
      }
    } catch {}

    if (name === 'add_job') {
      const hash = `claude_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const jobPayload = {
        id: hash,
        title: args?.title || 'Untitled Opening',
        company: args?.company || 'Unknown Company',
        url: args?.url || `https://www.google.com/search?q=${encodeURIComponent((args?.title || '') + ' ' + (args?.company || '') + ' jobs')}`,
        location: args?.location || 'Remote',
        salary: args?.salary || '',
        description: args?.description || 'Added via Claude MCP connector',
        source: args?.source || 'Claude AI',
        status: args?.status || 'Discovered'
      };
      await addJob(targetUserId, jobPayload);
      await addLog(targetUserId, 'INFO', `[Claude AI] Added new job: "${jobPayload.title}" at "${jobPayload.company}" (${jobPayload.location || 'Remote'})`);
      if (args?.match_score !== undefined) {
        const userJobs = await getJobs(targetUserId, 5);
        const savedJob = userJobs.find(j => j.title === jobPayload.title && j.company === jobPayload.company);
        if (savedJob) {
          await updateJobMatch(targetUserId, savedJob.id, args.match_score, args.match_reasons || `Evaluated by Claude: ${args.match_score}% fit.`);
        }
      }
      return res.json({
        jsonrpc: '2.0',
        id: id || 1,
        result: {
          content: [{ type: 'text', text: `Job "${jobPayload.title}" at "${jobPayload.company}" added directly to user ${targetUserId}'s Job Pulse dashboard!` }]
        }
      });
    }

    if (name === 'trigger_job_scan') {
      await addLog(targetUserId, 'INFO', `[Claude AI] Initiated live job scan for: "${args?.keywords || 'Default profile keywords'}" in "${args?.location || 'All locations'}"`);
      const scanResult = await scrapeJobs(targetUserId, true, {
        keywords: args?.keywords,
        location: args?.location,
        sources: args?.sources,
        savePreferences: true
      });
      await addLog(targetUserId, 'INFO', `[Claude AI] Scan complete: ${scanResult.totalDiscovered} jobs discovered, ${scanResult.newJobsCount} new jobs added to your feed.`);
      return res.json({
        jsonrpc: '2.0',
        id: id || 1,
        result: {
          content: [{
            type: 'text',
            text: `Scan complete: ${scanResult.totalDiscovered} discovered, ${scanResult.newJobsCount} new jobs added to user ${targetUserId}'s Job Pulse dashboard.`
          }]
        }
      });
    }

    if (name === 'update_job_status') {
      const updated = await updateJobStatus(targetUserId, args?.job_id, args?.status);
      await addLog(targetUserId, 'INFO', `[Claude AI] Updated job #${args?.job_id} status to "${args?.status}"`);
      return res.json({
        jsonrpc: '2.0',
        id: id || 1,
        result: {
          content: [{ type: 'text', text: updated ? `Job status updated to ${updated.status}` : 'Job not found' }]
        }
      });
    }

    if (name === 'get_user_resume') {
      const resume = await getUserResume(targetUserId);
      await addLog(targetUserId, 'INFO', `[Claude AI] Fetched candidate resume for JD match evaluation`);
      return res.json({
        jsonrpc: '2.0',
        id: id || 1,
        result: {
          content: [{ type: 'text', text: resume?.resume_text || 'No resume saved on file.' }]
        }
      });
    }

    if (name === 'save_job_match') {
      const updated = await updateJobMatch(targetUserId, args?.job_id, args?.score, args?.reasons);
      await addLog(targetUserId, 'INFO', `[Claude AI] Saved fit analysis for job #${args?.job_id}: ${args?.score}% Match`);
      return res.json({
        jsonrpc: '2.0',
        id: id || 1,
        result: {
          content: [{ type: 'text', text: updated ? `Saved match score ${args?.score}% for job ${args?.job_id}` : 'Job not found' }]
        }
      });
    }

    if (name === 'list_jobs') {
      const jobs = await getJobs(targetUserId, args?.limit || 20);
      return res.json({
        jsonrpc: '2.0',
        id: id || 1,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify(jobs.map(j => ({ id: j.id, title: j.title, company: j.company, status: j.status, match_score: j.match_score })))
          }]
        }
      });
    }
  }

  return res.json({ jsonrpc: '2.0', id: id || 1, error: { code: -32601, message: 'Method not found' } });
});

// 2.5 Delete single job
app.delete('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    await deleteJob(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2.6 Reset all jobs
app.delete('/api/jobs', requireAuth, async (req, res) => {
  try {
    await resetJobs(req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Get configuration settings
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings(req.user.id);
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Update configuration settings
app.post('/api/settings', requireAuth, async (req, res) => {
  const settings = req.body;
  try {
    for (const [key, value] of Object.entries(settings)) {
      await updateSetting(req.user.id, key, String(value));
    }
    await addLog(req.user.id, 'INFO', 'Settings updated.');
    await restartScheduler();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Trigger a test notification
app.post('/api/settings/test-notification', requireAuth, async (req, res) => {
  const settings = req.body;
  try {
    await sendTestNotification(settings);
    res.json({ success: true, message: 'Test notification sent successfully!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 6. Get system logs
app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const logs = await getLogs(req.user.id, 150);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Clear system logs
app.post('/api/logs/clear', requireAuth, async (req, res) => {
  try {
    await clearLogs(req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7.5 Import jobs from browser extension
app.post('/api/jobs/import', requireAuth, async (req, res) => {
  const { jobs: rawJobs = [] } = req.body;
  if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
    return res.status(400).json({ success: false, error: 'No jobs provided.' });
  }

  try {
    const settings = await getSettings(req.user.id);
    const keywords = (settings.keywords || '')
      .split(/,|\n/)
      .map(k => k.trim())
      .filter(k => k.length > 0);
    const location = settings.location || '';
    const countryCode = settings.country_code || 'us';
    const workType = settings.work_type || 'all';

    // Check if DB is empty for this user (first-run: index silently)
    const countRow = await get('SELECT COUNT(*) as count FROM jobs WHERE user_id = $1', [req.user.id]);
    const isFirstRun = countRow.count === 0;

    let added = 0;
    let skipped = 0;

    for (const raw of rawJobs) {
      // Normalize
      const job = {
        id: raw.id || ('ext_' + Math.abs(hashStr(raw.url || raw.title || String(Date.now()))).toString(36)),
        title: (raw.title || '').trim(),
        company: (raw.company || 'Unknown').trim(),
        url: (raw.url || '').trim(),
        source: (raw.source || 'Browser Extension').trim(),
        description: (raw.description || '').substring(0, 1000),
        salary: raw.salary || '',
        location: (raw.location || '').trim(),
      };

      if (!job.title || !job.url) { skipped++; continue; }

      // Keyword filter — title only. Matching description text too would let a single-word
      // search like "Product" match almost any job whose description happens to mention it.
      if (keywords.length > 0) {
        const text = job.title.toLowerCase();
        const matches = keywords.some(kw => text.includes(kw.toLowerCase()));
        if (!matches) { skipped++; continue; }
      }

      const isNew = await addJob(req.user.id, job);
      if (isNew) {
        added++;
        if (!isFirstRun) {
          try {
            await sendJobNotification(req.user.id, job, settings);
            await markJobAsNotified(req.user.id, job.id);
          } catch (_) {}
        }
      } else {
        skipped++;
      }
    }

    await addLog(req.user.id, 'INFO', `Browser Extension import: ${added} new jobs added, ${skipped} skipped (duplicates/filtered).`);
    res.json({ success: true, added, skipped });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function hashStr(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash;
}

// 8. Trigger manual scrape run
app.post('/api/scrape/trigger', requireAuth, async (req, res) => {
  try {
    await addLog(req.user.id, 'INFO', `Manual scan requested by user ${req.user.username}`);
    scrapeJobs(req.user.id, true).catch(err => console.error('Manual scraping run failed:', err));
    res.json({ success: true, message: 'Manual sync triggered in the background.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8.2 Live scan status — polled by the frontend so "Scan Jobs Now" reflects whether a scan
// is actually still fetching or has completed, instead of guessing with a fixed timeout.
app.get('/api/scrape/status', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, ...getScanStatus(req.user.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8.5 Cron Scrape Trigger (for Vercel/Render scheduled jobs)
app.post('/api/scrape/cron', async (req, res) => {
  // Optional security: check for CRON_SECRET if configured
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorized cron request' });
  }
  
  try {
    await addLog(null, 'INFO', 'Cron triggered background scrape for all active users.');
    const users = await getAllUsers();
    
    // Fire and forget - don't await so the response returns immediately
    for (const u of users) {
      scrapeJobs(u.id, false).catch(err => console.error('Cron scraping failed for user ' + u.id + ':', err));
    }
    
    res.json({ success: true, message: 'Cron scraping initiated.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Admin: Get all users and their safe (scrubbed) settings
// requireAuth ensures a valid JWT; requireAdmin ensures admin status
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  // Fields that must NEVER be exposed in API responses
  const SENSITIVE_KEYS = new Set([
    'otp_code', 'otp_expires_at', 'otp_attempts', 'otp_last_sent_at',
    'login_otp_code', 'login_otp_expires',
    'telegram_bot_token', 'discord_webhook_url',
    'adzuna_app_key'
  ]);

  try {
    const users = await getAllUsers();
    const usersWithSettings = await Promise.all(users.map(async (u) => {
      const settings = await getSettings(u.id);
      // Remove all sensitive keys before sending to client
      const safeSettings = Object.fromEntries(
        Object.entries(settings).filter(([k]) => !SENSITIVE_KEYS.has(k))
      );
      // Determine active status: last login within 7 days
      const lastLogin = u.last_login_at ? new Date(u.last_login_at) : null;
      const isActive = lastLogin && (Date.now() - lastLogin.getTime()) < 7 * 24 * 60 * 60 * 1000;
      return {
        ...u,
        is_admin: Boolean(u.is_admin === 1),
        keywords: safeSettings.keywords || '',
        location: safeSettings.location || '',
        background_scan: safeSettings.scrape_active === 'true' || safeSettings.scrape_active === '1',
        is_active: Boolean(isActive),
        settings: safeSettings
      };
    }));
    res.json({ success: true, users: usersWithSettings });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// 10. Admin: Get logs for a specific user
app.get('/api/admin/logs/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);
    if (isNaN(targetUserId)) {
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }
    const logs = await getUserLogs(targetUserId, 150);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch user logs' });
  }
});

// 10. Serve static frontend (for production deployment)
const frontendPath = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendPath));

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Initialize server
export async function startServer() {
  try {
    await initializeApp();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Job Notifier Backend running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to initialize or launch Express server:', err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test' && !isVercelRuntime) {
  startServer();
}

export { app };
