#!/usr/bin/env node

/**
 * =============================================================================
 * JOB PULSE MCP SERVER (Model Context Protocol)
 * =============================================================================
 * 
 * Job Pulse Model Context Protocol (MCP) Server:
 * - ZERO INTERNAL AI: No OpenAI, Anthropic, or proprietary LLM API keys embedded in the server.
 * - EXTERNAL AGENT INTEGRATION: Claude Desktop acts as the AI intelligence layer,
 *   communicating with this application via Model Context Protocol (MCP).
 * - STDIO TRANSPORT: Communicates cleanly over standard input/output with Claude Desktop.
 * - CORE TOOLS EXPOSED:
 *   1. trigger_job_scan: Triggers background scrapers (LinkedIn, Adzuna, WeWorkRemotely,
 *      RemoteOK, etc.) and updates database/feed.
 *   2. update_job_status: Updates job record status (Saved, Applied, Interviewing, etc.)
 *      and synchronizes with UI dashboard.
 *   3. list_jobs: Lists and filters existing jobs in the feed with their IDs and statuses.
 *   4. get_job_details: Retrieves full job description, salary, and metadata.
 *   5. get_scan_status: Inspects current scraper activity and status.
 *   6. get_user_resume: Retrieves the candidate resume for JD match evaluations.
 *   7. save_job_match: Persists match score and match reasons.
 *   8. analyze_job_fit: Provides JD text and resume for Claude to calculate match score.
 * =============================================================================
 */

// 1. CRITICAL: Redirect all stdout logging to stderr
// The MCP stdio transport requires stdout to be strictly reserved for JSON-RPC messages.
// Any plain text printed to stdout will corrupt protocol frames and disconnect Claude Desktop.
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;

console.log = (...args) => {
  process.stderr.write(`[MCP LOG] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`);
};
console.info = (...args) => {
  process.stderr.write(`[MCP INFO] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`);
};
console.warn = (...args) => {
  process.stderr.write(`[MCP WARN] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`);
};

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  initDb,
  getJobs,
  getJobById,
  updateJobStatus,
  updateJobMatch,
  getUserResume,
  saveUserResume,
  getAllUsers,
  getSettings,
  addLog,
  addJob
} from './db.js';

import { scrapeJobs, getScanStatus } from './scraper.js';

// Helper: Resolve active user ID (prioritizes active logged-in user)
async function resolveTargetUserId(requestedUserId) {
  if (requestedUserId) {
    const parsed = Number(requestedUserId);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  if (process.env.TARGET_USER_ID) {
    const parsed = Number(process.env.TARGET_USER_ID);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  try {
    const users = await getAllUsers();
    if (users && users.length > 0) {
      // Prioritize the user who logged in most recently (active session)
      const sorted = [...users].sort((a, b) => {
        const timeA = a.last_login_at ? new Date(a.last_login_at).getTime() : 0;
        const timeB = b.last_login_at ? new Date(b.last_login_at).getTime() : 0;
        return timeB - timeA;
      });
      return sorted[0].id;
    }
  } catch (err) {
    process.stderr.write(`[MCP] Warning: could not resolve user list: ${err.message}\n`);
  }
  return 1;
}

// 2. Initialize MCP Server instance
const server = new McpServer({
  name: 'job-pulse-mcp-server',
  version: '1.0.0'
});

// =============================================================================
// TOOL 1: trigger_job_scan
// =============================================================================
server.tool(
  'trigger_job_scan',
  'Triggers a live job scan across web platforms (LinkedIn, Adzuna, WeWorkRemotely, RemoteOK, Remotive, etc.), parses listings matching given keywords and location, populates the database, and updates the dashboard feed.',
  {
    keywords: z.string().optional().describe('Job titles or skill keywords to search for, comma-separated (e.g., "Full Stack Developer, React, Node.js")'),
    location: z.string().optional().describe('Geographic location or remote preference (e.g., "Remote", "India", "San Francisco, CA")'),
    sources: z.union([z.array(z.string()), z.string()]).optional().describe('Platforms to scan (e.g., ["linkedin", "adzuna", "weworkremotely", "remoteok", "remotive", "hackernews"])'),
    userId: z.number().optional().describe('Target user ID to populate jobs for (defaults to active/admin user)'),
    savePreferences: z.boolean().optional().describe('Whether to persist these keywords and location into the user dashboard settings (default: true)')
  },
  async ({ keywords, location, sources, userId, savePreferences = true }) => {
    try {
      await initDb();
      const targetUserId = await resolveTargetUserId(userId);

      process.stderr.write(`[MCP Tool] trigger_job_scan called for user ${targetUserId} (keywords="${keywords || 'default'}", location="${location || 'default'}")\n`);

      const scanResult = await scrapeJobs(targetUserId, true, {
        keywords,
        location,
        sources,
        savePreferences
      });

      if (scanResult && scanResult.success !== false) {
        await addLog(targetUserId, 'INFO', `[Claude AI] Scanned jobs across platforms: ${scanResult.totalDiscovered} discovered, ${scanResult.newJobsCount} new jobs added to your feed.`);
      }

      if (!scanResult || scanResult.success === false) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Job scan failed: ${scanResult?.error || 'Unknown error occurred during scrape execution'}`
          }]
        };
      }

      const lines = [
        `###  Job Scan Completed Successfully`,
        `- **User ID:** ${targetUserId}`,
        `- **Active Keywords:** ${scanResult.keywords || 'Default profile settings'}`,
        `- **Location Target:** ${scanResult.location || 'Default profile settings'}`,
        `- **Sources Scanned:** ${(scanResult.sources || []).join(', ')}`,
        `- **Total Listings Discovered:** ${scanResult.totalDiscovered}`,
        `- **New Jobs Added to Database:** ${scanResult.newJobsCount}`,
        `- **Platform Breakdown:** ${scanResult.platformBreakdown?.join(' | ') || 'N/A'}`
      ];

      if (scanResult.addedJobs && scanResult.addedJobs.length > 0) {
        lines.push(`\n#### Newly Discovered Listings:`);
        scanResult.addedJobs.forEach((job, idx) => {
          lines.push(`${idx + 1}. **${job.title}** at *${job.company}* (${job.location || 'Remote'})`);
          lines.push(`   - **Job ID:** \`${job.id}\` | **Source:** ${job.source}`);
          lines.push(`   - **URL:** ${job.url}`);
        });
      } else if (scanResult.newJobsCount === 0) {
        lines.push(`\n*Note: All discovered listings were either already present in the database or filtered by title criteria.*`);
      }

      lines.push(`\n> **Live UI Dashboard:** The web UI at http://localhost:5173 has been updated with these listings.`);

      return {
        content: [{
          type: 'text',
          text: lines.join('\n')
        }]
      };
    } catch (err) {
      process.stderr.write(`[MCP Tool Error] trigger_job_scan: ${err.message}\n`);
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Error executing trigger_job_scan: ${err.message}`
        }]
      };
    }
  }
);

// =============================================================================
// TOOL: add_job (Allows Claude to add any opening directly to the feed)
// =============================================================================
server.tool(
  'add_job',
  'Adds a new job opening directly into the user\'s Job Pulse feed and dashboard so it appears immediately in the application.',
  {
    title: z.string().describe('Job title (e.g. "Senior React Developer")'),
    company: z.string().describe('Company or organization name'),
    url: z.string().optional().describe('URL to apply or view the job posting'),
    location: z.string().optional().describe('Job location (e.g. "Remote", "Bengaluru", "New York")'),
    salary: z.string().optional().describe('Salary or compensation information if available'),
    description: z.string().optional().describe('Job description, responsibilities, or requirements'),
    source: z.string().optional().describe('Origin or platform (default: "Claude AI")'),
    match_score: z.number().optional().describe('Calculated match percentage (0-100) based on user resume'),
    match_reasons: z.string().optional().describe('Explanation of why candidate is a fit'),
    status: z.enum(['Discovered', 'Saved', 'Applied', 'Interviewing']).optional().describe('Application status (default: "Discovered")'),
    userId: z.number().optional().describe('Target user ID (defaults to active user)')
  },
  async ({ title, company, url, location, salary, description, source = 'Claude AI', match_score, match_reasons, status = 'Discovered', userId }) => {
    try {
      await initDb();
      const targetUserId = await resolveTargetUserId(userId);
      const hash = `claude_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      
      const jobPayload = {
        id: hash,
        title,
        company,
        url: url || `https://www.google.com/search?q=${encodeURIComponent(title + ' ' + company + ' jobs')}`,
        location: location || 'Remote',
        salary: salary || '',
        description: description || `Recommended by Claude for profile match.`,
        source,
        status
      };

      const added = await addJob(targetUserId, jobPayload);
      await addLog(targetUserId, 'INFO', `[Claude AI] Added new job: "${jobPayload.title}" at "${jobPayload.company}" (${jobPayload.location || 'Remote'})`);
      if (added && match_score !== undefined) {
        const userJobs = await getJobs(targetUserId, 5);
        const savedJob = userJobs.find(j => j.title === title && j.company === company);
        if (savedJob) {
          await updateJobMatch(targetUserId, savedJob.id, match_score, match_reasons || `Evaluated by Claude: ${match_score}% fit.`);
        }
      }

      return {
        content: [{
          type: 'text',
          text: [
            `### ✅ Job Opening Added to Dashboard!`,
            `- **Title:** **${title}** at *${company}*`,
            `- **Location:** ${location || 'Remote'}`,
            `- **Status:** ${status}`,
            match_score !== undefined ? `- **Match Score:** ${match_score}%` : '',
            `- **User ID:** ${targetUserId}`,
            `\n> **Live in App:** This job is now visible in your Job Feed and Dashboard at http://localhost:5173.`
          ].filter(Boolean).join('\n')
        }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Failed to add job to dashboard: ${err.message}`
        }]
      };
    }
  }
);

// =============================================================================
// TOOL 2: update_job_status
// =============================================================================
server.tool(
  'update_job_status',
  'Updates the status of a job (e.g., Saved, Applied, Interviewing, Offer, Rejected, Archived) in the database so it reflects in the frontend dashboard UI.',
  {
    job_id: z.union([z.string(), z.number()]).describe('The numeric ID or unique hash of the job to update (e.g., 14 or "li_4443562587")'),
    status: z.enum([
      'Discovered',
      'Saved',
      'Applied',
      'Interviewing',
      'Offer',
      'Rejected',
      'Archived'
    ]).describe('The new status to assign to the job'),
    user_id: z.number().optional().describe('Optional target user ID (defaults to active/admin user)')
  },
  async ({ job_id, status, user_id }) => {
    try {
      await initDb();
      const targetUserId = await resolveTargetUserId(user_id);

      process.stderr.write(`[MCP Tool] update_job_status called for job "${job_id}" -> status: "${status}"\n`);

      const updatedJob = await updateJobStatus(targetUserId, job_id, status);

      if (!updatedJob) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Job with ID "${job_id}" could not be found for user ID ${targetUserId}.`
          }]
        };
      }

      await addLog(targetUserId, 'INFO', `[Claude AI] Updated job #${job_id} ("${updatedJob.title}") status to "${status}"`);

      const lines = [
        `###  Job Status Updated Successfully`,
        `- **Job ID:** \`${updatedJob.id}\``,
        `- **Title:** **${updatedJob.title}**`,
        `- **Company:** *${updatedJob.company}*`,
        `- **Location:** ${updatedJob.location || 'N/A'}`,
        `- **Source:** ${updatedJob.source || 'N/A'}`,
        `- **New Status:** **${updatedJob.status}**`,
        `- **Applied Flag:** ${updatedJob.applied ? ' 1 (Applied)' : ' 0 (Not applied)'}`,
        `- **URL:** ${updatedJob.url}`,
        `\n> **Live UI Dashboard:** The change is now stored in the database and visible on http://localhost:5173.`
      ];

      return {
        content: [{
          type: 'text',
          text: lines.join('\n')
        }]
      };
    } catch (err) {
      process.stderr.write(`[MCP Tool Error] update_job_status: ${err.message}\n`);
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Error updating job status: ${err.message}`
        }]
      };
    }
  }
);

// =============================================================================
// TOOL 3: list_jobs (Companion tool for exploring feed)
// =============================================================================
server.tool(
  'list_jobs',
  'Lists jobs currently stored in the database feed with their IDs, titles, companies, locations, and statuses. Useful to inspect available jobs before updating status.',
  {
    status: z.string().optional().describe('Optional filter by status (e.g. "all", "Saved", "Applied", "Interviewing", "Discovered")'),
    search: z.string().optional().describe('Optional keyword search against job title or company'),
    limit: z.number().optional().describe('Maximum number of jobs to return (default: 20, max: 100)'),
    userId: z.number().optional().describe('Target user ID (defaults to active user)')
  },
  async ({ status, search, limit = 20, userId }) => {
    try {
      await initDb();
      const targetUserId = await resolveTargetUserId(userId);
      const allJobs = await getJobs(targetUserId, 200);

      const maxLimit = Math.min(Math.max(limit, 1), 100);
      let filtered = allJobs;

      if (status && status.toLowerCase() !== 'all') {
        const targetStatus = status.toLowerCase();
        filtered = filtered.filter(j => (j.status || '').toLowerCase() === targetStatus);
      }

      if (search && search.trim()) {
        const query = search.trim().toLowerCase();
        filtered = filtered.filter(j =>
          (j.title || '').toLowerCase().includes(query) ||
          (j.company || '').toLowerCase().includes(query) ||
          (j.location || '').toLowerCase().includes(query)
        );
      }

      const count = filtered.length;
      const paginated = filtered.slice(0, maxLimit);

      const lines = [
        `###  Current Jobs in Feed (${paginated.length} of ${count} matching)`,
        `- **User ID:** ${targetUserId}`,
        `- **Filter:** status="${status || 'all'}", search="${search || 'none'}"\n`
      ];

      if (paginated.length === 0) {
        lines.push(`*No jobs match the given criteria in the database feed.*`);
      } else {
        paginated.forEach((j, i) => {
          lines.push(`${i + 1}. **${j.title}** at *${j.company}*`);
          lines.push(`   - **ID:** \`${j.id}\` | **Status:** **${j.status || 'Discovered'}** | **Location:** ${j.location || 'Remote'}`);
          lines.push(`   - **Source:** ${j.source} | **URL:** ${j.url}`);
        });
      }

      return {
        content: [{
          type: 'text',
          text: lines.join('\n')
        }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Error listing jobs: ${err.message}`
        }]
      };
    }
  }
);

// =============================================================================
// TOOL 4: get_job_details
// =============================================================================
server.tool(
  'get_job_details',
  'Retrieves full details for a specific job by its ID, including full description, salary, location, source, and status.',
  {
    job_id: z.union([z.string(), z.number()]).describe('The numeric ID or job hash'),
    user_id: z.number().optional().describe('Target user ID (defaults to active user)')
  },
  async ({ job_id, user_id }) => {
    try {
      await initDb();
      const targetUserId = await resolveTargetUserId(user_id);
      const job = await getJobById(targetUserId, job_id);

      if (!job) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Job with ID "${job_id}" was not found.`
          }]
        };
      }

      const lines = [
        `###  Job Details: ${job.title}`,
        `- **Job ID:** \`${job.id}\``,
        `- **Company:** ${job.company || 'Unknown'}`,
        `- **Status:** **${job.status || 'Discovered'}**`,
        `- **Location:** ${job.location || 'Not specified'}`,
        `- **Salary:** ${job.salary || 'Not listed'}`,
        `- **Source:** ${job.source || 'Direct'}`,
        `- **Discovered At:** ${job.discovered_at}`,
        `- **URL:** ${job.url}`,
        `\n#### Description:`,
        job.description ? job.description.replace(/<[^>]*>/g, '') : '*No description available.*'
      ];

      return {
        content: [{
          type: 'text',
          text: lines.join('\n')
        }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Error getting job details: ${err.message}`
        }]
      };
    }
  }
);

// =============================================================================
// TOOL 5: get_scan_status
// =============================================================================
server.tool(
  'get_scan_status',
  'Checks whether a job scan is currently in progress and retrieves the last scan summary.',
  {
    user_id: z.number().optional().describe('Target user ID (defaults to active user)')
  },
  async ({ user_id }) => {
    try {
      await initDb();
      const targetUserId = await resolveTargetUserId(user_id);
      const status = getScanStatus(targetUserId);

      const lines = [
        `###  Job Scraper Status`,
        `- **User ID:** ${targetUserId}`,
        `- **Currently Scanning:** ${status.scanning ? ' YES (In progress)' : ' NO (Idle)'}`
      ];

      if (status.lastResult) {
        lines.push(`\n**Last Scan Result:**`);
        lines.push(`- Finished: ${status.lastResult.finishedAt ? new Date(status.lastResult.finishedAt).toLocaleTimeString() : 'N/A'}`);
        lines.push(`- New Jobs Added: ${status.lastResult.newJobsCount ?? 0}`);
        lines.push(`- Total Discovered: ${status.lastResult.totalDiscovered ?? 0}`);
        if (status.lastResult.platformBreakdown) {
          lines.push(`- Platform Breakdown: ${status.lastResult.platformBreakdown.join(' | ')}`);
        }
      }

      return {
        content: [{
          type: 'text',
          text: lines.join('\n')
        }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Error checking scan status: ${err.message}`
        }]
      };
    }
  }
);

// =============================================================================
// TOOL 6: get_user_resume
// =============================================================================
server.tool(
  'get_user_resume',
  'Retrieves the user uploaded resume text, skills, and background so Claude can review candidate qualifications and evaluate job fit.',
  {
    user_id: z.number().optional().describe('Target user ID (defaults to active user)')
  },
  async ({ user_id }) => {
    try {
      await initDb();
      const targetUserId = await resolveTargetUserId(user_id);
      const resume = await getUserResume(targetUserId);

      if (!resume || !resume.resume_text) {
        return {
          content: [{
            type: 'text',
            text: `No resume found for user ID ${targetUserId}. Please advise the user to upload their resume in the web dashboard at http://localhost:5173 (under the "Resume & Profile" tab).`
          }]
        };
      }

      return {
        content: [{
          type: 'text',
          text: [
            `###  User Resume Profile`,
            `- **User ID:** ${targetUserId}`,
            `- **Filename:** ${resume.filename || 'resume.txt'}`,
            `- **Last Updated:** ${resume.updated_at || 'Recently'}`,
            `\n#### Resume Content:`,
            resume.resume_text
          ].join('\n')
        }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Error retrieving user resume: ${err.message}`
        }]
      };
    }
  }
);

// =============================================================================
// TOOL 7: save_job_match
// =============================================================================
server.tool(
  'save_job_match',
  'Saves the match percentage score (0-100) and evaluation analysis generated by Claude for a specific job into the database so it displays in the frontend UI dashboard.',
  {
    job_id: z.union([z.string(), z.number()]).describe('The numeric ID or job hash of the listing being evaluated'),
    match_score: z.number().min(0).max(100).describe('Calculated match percentage (0-100) between candidate resume and job requirements'),
    match_reasons: z.string().describe('Bullet points describing pros, matching skills, missing skills, and recommendations'),
    user_id: z.number().optional().describe('Target user ID (defaults to active user)')
  },
  async ({ job_id, match_score, match_reasons, user_id }) => {
    try {
      await initDb();
      const targetUserId = await resolveTargetUserId(user_id);
      const updated = await updateJobMatch(targetUserId, job_id, match_score, match_reasons);

      if (!updated) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Job with ID "${job_id}" could not be found for user ID ${targetUserId}.`
          }]
        };
      }

      await addLog(targetUserId, 'INFO', `[Claude AI] Saved fit analysis for job #${job_id}: ${match_score}% Match`);

      return {
        content: [{
          type: 'text',
          text: [
            `###  Job Match Score Saved Successfully`,
            `- **Job ID:** \`${updated.id}\``,
            `- **Title:** **${updated.title}** (${updated.company || 'Unknown'})`,
            `- **Match Score:** **${updated.match_score}%**`,
            `\n#### Match Analysis:`,
            updated.match_reasons,
            `\n> **Live UI Dashboard:** This match badge (${updated.match_score}%) is now visible on the job card in http://localhost:5173.`
          ].join('\n')
        }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Error saving job match score: ${err.message}`
        }]
      };
    }
  }
);

// =============================================================================
// TOOL 8: analyze_job_fit
// =============================================================================
server.tool(
  'analyze_job_fit',
  'Retrieves both the Job Description and the candidate Resume together in one call, ready for Claude to calculate match score and skill gaps.',
  {
    job_id: z.union([z.string(), z.number()]).describe('The numeric ID or job hash of the job to evaluate'),
    user_id: z.number().optional().describe('Target user ID (defaults to active user)')
  },
  async ({ job_id, user_id }) => {
    try {
      await initDb();
      const targetUserId = await resolveTargetUserId(user_id);
      const job = await getJobById(targetUserId, job_id);
      const resume = await getUserResume(targetUserId);

      if (!job) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Job with ID "${job_id}" was not found.`
          }]
        };
      }

      if (!resume || !resume.resume_text) {
        return {
          content: [{
            type: 'text',
            text: `No resume on file for user ID ${targetUserId}. Please ask the user to upload their resume in http://localhost:5173 under the Resume tab first.`
          }]
        };
      }

      const lines = [
        `###  Context for Job Fit Evaluation`,
        `#### Target Job: ${job.title} at ${job.company || 'Unknown'}`,
        `- **Job ID:** \`${job.id}\` | **Current Status:** ${job.status || 'Discovered'}`,
        `- **Location:** ${job.location || 'Remote'} | **Salary:** ${job.salary || 'N/A'}`,
        `- **URL:** ${job.url}`,
        `\n#### Job Description:`,
        job.description ? job.description.replace(/<[^>]*>/g, '') : 'No JD text available.',
        `\n---\n`,
        `#### Candidate Resume (${resume.filename || 'resume.txt'}):`,
        resume.resume_text,
        `\n---\n`,
        `*Instructions for Claude:* Compare candidate skills/experience with the requirements above. Determine a match percentage (0-100), note matching qualifications and missing requirements, and call \`save_job_match\` to save this analysis back to the dashboard database.`
      ];

      return {
        content: [{
          type: 'text',
          text: lines.join('\n')
        }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Error preparing job fit analysis: ${err.message}`
        }]
      };
    }
  }
);

// =============================================================================
// Connect MCP Server via Stdio Transport
// =============================================================================
async function startMcpServer() {
  try {
    await initDb();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('[MCP SERVER] Job Pulse MCP Server running cleanly on stdio transport.\n');
  } catch (err) {
    process.stderr.write(`[MCP SERVER ERROR] Failed to start stdio server: ${err.message}\n`);
    process.exit(1);
  }
}

// Graceful termination handling
process.on('SIGINT', () => {
  process.stderr.write('[MCP SERVER] Received SIGINT. Shutting down.\n');
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.stderr.write('[MCP SERVER] Received SIGTERM. Shutting down.\n');
  process.exit(0);
});

// Only auto-start stdio transport when run directly as a script
const isDirectRun = process.argv[1] && (process.argv[1].endsWith('mcp-server.js') || process.argv[1].endsWith('mcp-server'));
if (isDirectRun) {
  startMcpServer();
}

export { server, startMcpServer };
