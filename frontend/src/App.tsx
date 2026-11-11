import { useState, useEffect, useMemo, useRef } from 'react';
import Auth from './Auth';

const DEFAULT_SETTINGS = {
  keywords: '',
  telegram_bot_token: '',
  telegram_chat_id: '',
  discord_webhook_url: '',
  scrape_interval_mins: '10',
  enabled_sources: '["linkedin", "weworkremotely", "remoteok", "adzuna", "hackernews"]',
  scrape_active: '1',
  location: 'India',
  country_code: 'in',
  work_type: 'onsite',
  experience_level: 'all',
  adzuna_app_id: '',
  adzuna_app_key: ''
};

// Sources known to be aggressively blocked by anti-bot/CAPTCHA protection when scraped directly.
// Surfaced in the UI so users aren't surprised when these return few/no jobs.
const UNRELIABLE_SOURCES = new Set(['indeed', 'glassdoor', 'naukri', 'dice', 'simplyhired', 'google']);

// Small "Saving.../Saved" indicator shown next to preference controls so autosave is visible
// without needing a toast for every change.
function AutosaveIndicator({ status }: { status: 'idle' | 'saving' | 'saved' }) {
  if (status === 'idle') return null;
  const saving = status === 'saving';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: saving ? 'var(--text-muted)' : 'var(--success)' }}>
      <span className="material-symbols-outlined" style={{ fontSize: '0.95rem' }}>{saving ? 'sync' : 'check_circle'}</span>
      {saving ? 'Saving...' : 'Saved'}
    </span>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'feed' | 'dashboard' | 'resume' | 'mcp' | 'settings' | 'logs' | 'admin'>('feed');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [jobs, setJobs] = useState<any[]>([]);
  const [resume, setResume] = useState<{ filename: string; text: string; updated_at?: string } | null>(null);
  const [resumeDraft, setResumeDraft] = useState('');
  const [isSavingResume, setIsSavingResume] = useState(false);
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);
  // Load settings from localStorage on init — persists across Vercel cold starts
  const [settings, setSettings] = useState<any>(() => {
    try {
      const saved = localStorage.getItem('jp_settings');
      if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    } catch {}
    return DEFAULT_SETTINGS;
  });
  const [logs, setLogs] = useState<any[]>([]);
  
  // UI states
  const [searchQuery, setSearchQuery] = useState(() => localStorage.getItem('jp_search_query') || '');
  const [statusFilter, setStatusFilter] = useState<'all' | 'claude' | 'saved' | 'applied' | 'interviewing'>(() => 
    (localStorage.getItem('jp_status_filter') || 'all') as any
  );
  const [logFilterTab, setLogFilterTab] = useState<'all' | 'claude' | 'sync' | 'errors'>('all');
  const [dateFilter, setDateFilter] = useState<'all' | '24h' | '3d' | '7d' | '14d'>(() => 
    (localStorage.getItem('jp_date_filter') || 'all') as any
  );
  const [sourceFilter, setSourceFilter] = useState(() => localStorage.getItem('jp_source_filter') || 'all');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatusText, setSyncStatusText] = useState('');
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isTestingNotify, setIsTestingNotify] = useState(false);
  const [toast, setToast] = useState<{ message: string; show: boolean }>({ message: '', show: false });
  const [isPrefPanelOpen, setIsPrefPanelOpen] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Share feature state
  const [openShareId, setOpenShareId] = useState<string | null>(null);    // per-card dropdown
  const [openMoreJobId, setOpenMoreJobId] = useState<string | null>(null);  // per-card more dropdown
  const [isSelectMode, setIsSelectMode] = useState(false);                // multi-select toggle
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set()); // selected cards
  const [isBulkShareOpen, setIsBulkShareOpen] = useState(false);          // bulk dropdown
  const [mcpStatus, setMcpStatus] = useState<{ connected: boolean; configPath: string; loading: boolean }>({
    connected: false,
    configPath: '',
    loading: true
  });
  const [isConnectingMcp, setIsConnectingMcp] = useState(false);
  // Guards against autosaving the initial localStorage/default settings back to the server
  // before the real settings have finished loading from the API.
  const settingsLoadedRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shareDropdownRef = useRef<HTMLDivElement | null>(null);

  // Close share & more dropdowns when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest('.share-wrapper') && !target.closest('.bulk-share-bar')) {
        setOpenShareId(null);
        setIsBulkShareOpen(false);
      }
      if (!target.closest('.more-actions-wrapper')) {
        setOpenMoreJobId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Exit select mode when feed tab changes
  useEffect(() => {
    setIsSelectMode(false);
    setSelectedJobIds(new Set());
    setOpenShareId(null);
    setIsBulkShareOpen(false);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem('jp_search_query', searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    localStorage.setItem('jp_status_filter', statusFilter);
  }, [statusFilter]);

  useEffect(() => {
    localStorage.setItem('jp_date_filter', dateFilter);
  }, [dateFilter]);

  useEffect(() => {
    localStorage.setItem('jp_source_filter', sourceFilter);
  }, [sourceFilter]);

  const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

  const [token, setToken] = useState<string | null>(localStorage.getItem('jp_token'));
  const [username, setUsername] = useState<string>(localStorage.getItem('jp_username') || '');
  const [userId, setUserId] = useState<number | null>(
    localStorage.getItem('jp_userId') ? parseInt(localStorage.getItem('jp_userId')!) : null
  );
  const [userIsAdmin, setUserIsAdmin] = useState<boolean>(
    localStorage.getItem('jp_isAdmin') === 'true'
  );

  // Admin Data
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [adminSelectedUser, setAdminSelectedUser] = useState<any | null>(null);
  const [adminUserLogs, setAdminUserLogs] = useState<any[]>([]);
  const [adminLogsLoading, setAdminLogsLoading] = useState(false);
  const [adminActiveFilter, setAdminActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const isAdmin = userIsAdmin || userId === 1;

  const handleLogin = (newToken: string, newUsername: string, newUserId: number, is_admin?: boolean) => {
    setToken(newToken);
    setUsername(newUsername);
    setUserId(newUserId);
    const adminFlag = Boolean(is_admin || newUserId === 1);
    setUserIsAdmin(adminFlag);
    localStorage.setItem('jp_token', newToken);
    localStorage.setItem('jp_username', newUsername);
    localStorage.setItem('jp_userId', newUserId.toString());
    localStorage.setItem('jp_isAdmin', String(adminFlag));
  };

  const handleLogout = () => {
    setToken('');
    setUsername('');
    setUserId(null);
    setUserIsAdmin(false);
    localStorage.removeItem('jp_token');
    localStorage.removeItem('jp_username');
    localStorage.removeItem('jp_userId');
    localStorage.removeItem('jp_isAdmin');
    localStorage.removeItem('jp_settings');
  };

  const fetchApi = async (url: string, options: any = {}) => {
    if (token) {
      options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`
      };
    }
    const res = await fetch(url, options);
    if (res.status === 401) {
      handleLogout();
      throw new Error('Unauthorized');
    }
    return res;
  };

  // Show a brief notification popup
  const showToast = (message: string) => {
    setToast({ message, show: true });
    setTimeout(() => {
      setToast(prev => ({ ...prev, show: false }));
    }, 4000);
  };

  // Fetch jobs
  const fetchJobs = async () => {
    try {
      const res = await fetchApi(`${API_BASE}/jobs`);
      const data = await res.json();
      if (data.success) {
        setJobs(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch jobs:', err);
    }
  };

  // Fetch settings from the API and synchronize them with the local state/cache.
  // Retries a couple of times before giving up — free-tier hosts (Render/Neon) can take a
  // few seconds to wake from cold-start right after login, which previously looked like
  // "my saved preferences disappeared" when really the very first request just failed.
  const fetchSettings = async (retryCount = 0) => {
    try {
      const res = await fetchApi(`${API_BASE}/settings`);
      const data = await res.json();
      if (data.success) {
        const merged = { ...DEFAULT_SETTINGS, ...data.data };
        setSettings(merged);
        localStorage.setItem('jp_settings', JSON.stringify(merged));
        // Only allow autosave to kick in once we have the real server settings in hand.
        settingsLoadedRef.current = true;
        return;
      }
      throw new Error(data.error || 'Failed to load settings');
    } catch (err) {
      console.error('Failed to fetch settings:', err);
      if (retryCount < 3) {
        setTimeout(() => fetchSettings(retryCount + 1), 1500 * (retryCount + 1));
      } else {
        showToast('Could not reach the server to load your saved preferences. Showing your last-known local settings — check your connection and try again.');
      }
    }
  };

  // Fetch logs
  const fetchLogs = async () => {
    try {
      const res = await fetchApi(`${API_BASE}/logs`);
      const data = await res.json();
      if (data.success) {
        setLogs(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    }
  };

  // Fetch Admin Users
  const fetchAdminUsers = async () => {
    if (!isAdmin) return;
    try {
      const res = await fetchApi(`${API_BASE}/admin/users`);
      const data = await res.json();
      if (data.success) {
        setAdminUsers(data.users);
      }
    } catch (err) {
      console.error('Failed to fetch admin users:', err);
    }
  };

  // Fetch logs for a specific user (admin only)
  const fetchAdminUserLogs = async (targetUserId: number) => {
    setAdminLogsLoading(true);
    setAdminUserLogs([]);
    try {
      const res = await fetchApi(`${API_BASE}/admin/logs/${targetUserId}`);
      const data = await res.json();
      if (data.success) {
        setAdminUserLogs(data.logs);
      }
    } catch (err) {
      console.error('Failed to fetch user logs:', err);
    } finally {
      setAdminLogsLoading(false);
    }
  };

  // Fetch user resume
  const fetchResume = async () => {
    if (!token) return;
    try {
      const res = await fetchApi(`${API_BASE}/resume`);
      const data = await res.json();
      if (data.success && data.resume) {
        setResume({
          filename: data.resume.filename || 'resume.txt',
          text: data.resume.resume_text || '',
          updated_at: data.resume.updated_at
        });
        setResumeDraft(data.resume.resume_text || '');
      }
    } catch (err) {
      console.error('Failed to fetch resume:', err);
    }
  };

  // Save user resume
  const saveResume = async (filename?: string, text?: string) => {
    const textToSave = text !== undefined ? text : resumeDraft;
    const nameToSave = filename || resume?.filename || 'my_resume.txt';
    if (!textToSave.trim()) {
      showToast('Please enter or upload resume content');
      return;
    }
    setIsSavingResume(true);
    try {
      const res = await fetchApi(`${API_BASE}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: nameToSave, text: textToSave })
      });
      const data = await res.json();
      if (data.success) {
        setResume({ filename: nameToSave, text: textToSave, updated_at: new Date().toISOString() });
        showToast('Resume saved! Claude Desktop can now evaluate your JD match percentages.');
      } else {
        showToast('Failed to save resume: ' + data.error);
      }
    } catch (err) {
      showToast('Connection error saving resume');
    } finally {
      setIsSavingResume(false);
    }
  };

  // Handle resume file upload
  const handleResumeFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = (event.target?.result as string) || '';
      if (content) {
        setResumeDraft(content);
        await saveResume(file.name, content);
      }
    };
    reader.readAsText(file);
  };

  // Copy Claude match prompt for a specific job
  const copyClaudeMatchPrompt = (job: any) => {
    const prompt = `Claude, please evaluate my uploaded resume against job #${job.id} ("${job.title}" at "${job.company || 'Unknown'}") using the job-pulse MCP tools. Calculate my match percentage (0-100), identify matching skills and missing qualifications, and use the save_job_match tool to save the score to my dashboard.`;
    navigator.clipboard.writeText(prompt);
    showToast(`Copied Claude match prompt for "${job.title}"! Paste it into Claude Desktop.`);
  };

  // Copy Claude Desktop configuration JSON
  const copyClaudeConfig = () => {
    const config = JSON.stringify({
      mcpServers: {
        "job-pulse": {
          "command": "node",
          "args": [
            "C:\\Users\\Sagar\\Downloads\\volopay\\Job-Notifier2-main\\Job-Notifier2-main\\backend\\mcp-server.js"
          ],
          "env": {
            "NODE_ENV": "development"
          }
        }
      }
    }, null, 2);
    navigator.clipboard.writeText(config);
    showToast('Copied Claude Desktop configuration to clipboard!');
  };

  // Download claude_desktop_config.json
  const downloadClaudeConfig = () => {
    const config = JSON.stringify({
      mcpServers: {
        "job-pulse": {
          "command": "node",
          "args": [
            "C:\\Users\\Sagar\\Downloads\\volopay\\Job-Notifier2-main\\Job-Notifier2-main\\backend\\mcp-server.js"
          ],
          "env": {
            "NODE_ENV": "development"
          }
        }
      }
    }, null, 2);
    const blob = new Blob([config], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'claude_desktop_config.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Downloaded claude_desktop_config.json!');
  };

  // Check MCP connection status with Claude
  const fetchMcpStatus = async () => {
    try {
      const res = await fetchApi(`${API_BASE}/mcp/status`);
      const data = await res.json();
      if (data.success) {
        setMcpStatus({
          connected: Boolean(data.connected),
          configPath: data.configPath || '',
          loading: false
        });
      }
    } catch {
      setMcpStatus(prev => ({ ...prev, loading: false }));
    }
  };

  // 1-Click Connect to Claude Desktop
  const connectClaude = async () => {
    setIsConnectingMcp(true);
    try {
      const res = await fetchApi(`${API_BASE}/mcp/connect`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setMcpStatus({ connected: true, configPath: data.configPath, loading: false });
        showToast('Connected to Claude Desktop successfully! Please restart Claude Desktop.');
      } else {
        showToast('Connection failed: ' + data.error);
      }
    } catch (err: any) {
      showToast('Error connecting Claude: ' + err.message);
    } finally {
      setIsConnectingMcp(false);
    }
  };

  // Disconnect from Claude Desktop
  const disconnectClaude = async () => {
    try {
      const res = await fetchApi(`${API_BASE}/mcp/disconnect`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setMcpStatus(prev => ({ ...prev, connected: false }));
        showToast('Disconnected from Claude Desktop.');
      }
    } catch {
      showToast('Error disconnecting Claude.');
    }
  };

  // Instant Quick Match calculation
  const triggerQuickMatch = async (jobId: string | number) => {
    if (!resume || !resumeDraft.trim()) {
      showToast('Please save your resume first in Resume & Match to get match scores!');
      setActiveTab('resume');
      return;
    }
    showToast('Calculating match fit against candidate profile...');
    try {
      const res = await fetchApi(`${API_BASE}/jobs/${jobId}/quick-match`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setJobs(prev => prev.map(j => j.id === jobId ? { ...j, match_score: data.score, match_reasons: data.reasons } : j));
        setExpandedMatchId(String(jobId));
        showToast(`Match Score: ${data.score}%! Analysis loaded.`);
      } else {
        showToast('Match calculation failed: ' + data.error);
      }
    } catch {
      showToast('Network error calculating match.');
    }
  };

  // Quick Job Status Update
  const updateJobStatusAction = async (jobId: string | number, newStatus: string) => {
    try {
      const res = await fetchApi(`${API_BASE}/jobs/${jobId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const data = await res.json();
      if (data.success) {
        setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: newStatus, applied: newStatus === 'Applied' ? 1 : j.applied } : j));
        showToast(`Job status updated to "${newStatus}"!`);
      }
    } catch {
      showToast('Failed to update job status.');
    }
  };

  // On mount, load data
  useEffect(() => {
    if (token) {
      fetchJobs();
      fetchSettings();
      fetchResume();
      fetchMcpStatus();
      if (isAdmin && activeTab === 'admin') {
        fetchAdminUsers();
      }
    }
  }, [token, userId, username, activeTab]);

  // Poll for logs and jobs when viewing those tabs
  useEffect(() => {
    if (!token) return;
    let interval: any;
    if (activeTab === 'logs') {
      fetchLogs();
      interval = setInterval(fetchLogs, 5000);
    } else if (activeTab === 'feed') {
      fetchJobs();
      interval = setInterval(fetchJobs, 10000);
    }
    return () => clearInterval(interval);
  }, [activeTab, token]);

  // Poll the backend's real scan status until it reports finished (or we give up after ~90s).
  // Returns the lastResult object ({newJobsCount, totalDiscovered} | {error} | {skipped}), or
  // null if polling timed out without the scan reporting completion.
  const pollScanStatus = (): Promise<any> => {
    const maxAttempts = 60; // 60 * 1.5s = 90s ceiling
    let attempts = 0;
    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        attempts++;
        try {
          const res = await fetchApi(`${API_BASE}/scrape/status`);
          const data = await res.json();
          if (data.success && !data.scanning) {
            clearInterval(interval);
            resolve(data.lastResult || null);
            return;
          }
        } catch {
          // transient network hiccup — keep polling until maxAttempts
        }
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          resolve(null);
        }
      }, 1500);
    });
  };

  // Handle manual sync
  const triggerSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    showToast('Job synchronization triggered in background...');
    try {
      // Quick health check to give a friendlier error when backend is down
      try {
        const healthRes = await fetch(`${API_BASE}/health`);
        if (!healthRes.ok) {
          setIsSyncing(false);
          showToast('Server unavailable — please start the backend.');
          return;
        }
        const healthData = await healthRes.json().catch(() => null);
        if (!healthData || healthData.status !== 'ok') {
          setIsSyncing(false);
          showToast('Server health check failed.');
          return;
        }
      } catch (healthErr) {
        setIsSyncing(false);
        showToast('Server unreachable. Please start backend.');
        return;
      }
      const res = await fetchApi(`${API_BASE}/scrape/trigger`, { method: 'POST' });
      let data: any = null;
      try {
        data = await res.json();
      } catch (parseErr) {
        const text = await res.text().catch(() => '');
        setIsSyncing(false);
        showToast('Server returned unexpected response: ' + (text || res.statusText || 'empty body'));
        return;
      }

      if (data && data.success) {
        // Poll real backend scan status instead of guessing with a fixed delay — scans can
        // take anywhere from a few seconds to well over a minute depending on which sources
        // are enabled (e.g. multi-city LinkedIn expansion), so a fixed timeout either lies
        // about completion or makes the user wait longer than necessary.
        setSyncStatusText('Fetching jobs from all platforms...');
        const result = await pollScanStatus();
        fetchJobs();
        fetchLogs();
        setIsSyncing(false);
        setSyncStatusText('');

        if (!result) {
          showToast('Scan is taking longer than expected — check the Logs tab for live progress.');
        } else if (result.error) {
          showToast('Scan failed: ' + result.error);
        } else if (result.skipped) {
          showToast('Background scanning is disabled in Settings — enable it to run scans.');
        } else {
          const { newJobsCount, totalDiscovered } = result;
          showToast(
            newJobsCount > 0
              ? `Scan complete — ${newJobsCount} new job${newJobsCount === 1 ? '' : 's'} found!`
              : `Scan complete — no new jobs this time (${totalDiscovered ?? 0} checked).`
          );
        }
      } else {
        setIsSyncing(false);
        showToast('Failed to trigger sync: ' + (data?.error || 'Unknown error'));
      }
    } catch (err: any) {
      setIsSyncing(false);
      setSyncStatusText('');
      showToast('Error syncing: ' + err.message);
    }
  };

  // ── Share helpers ────────────────────────────────────────────────────────────

  /** Build a short human-readable share message for one job */
  const buildShareText = (job: any): string => {
    const parts = [`🚀 *${job.title}*`];
    if (job.company)  parts.push(`🏢 ${job.company}`);
    if (job.location) parts.push(`📍 ${job.location}`);
    if (job.salary)   parts.push(`💰 ${job.salary}`);
    parts.push(`🔗 ${job.url}`);
    return parts.join('\n');
  };

  /** Build a combined share message for multiple jobs */
  const buildBulkShareText = (jobList: any[]): string => {
    const header = `📋 *${jobList.length} Job Listing${jobList.length === 1 ? '' : 's'} — Job Notifier*\n`;
    const items = jobList.map((j, i) =>
      `${i + 1}. *${j.title}* @ ${j.company || 'N/A'}${j.location ? ' · ' + j.location : ''}\n   🔗 ${j.url}`
    );
    return header + '\n' + items.join('\n\n');
  };

  const shareToWhatsApp = (text: string) =>
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');

  const shareToTelegram = (text: string) =>
    window.open(`https://t.me/share/url?url=${encodeURIComponent(text)}`, '_blank');

  const shareToTwitter = (text: string) =>
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text.slice(0, 280))}`, '_blank');

  const shareToEmail = (subject: string, body: string) =>
    window.open(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard!');
    } catch {
      showToast('Copy failed — please copy manually.');
    }
  };

  /** Share a single job via a given channel */
  const shareSingleJob = (job: any, channel: string) => {
    const text = buildShareText(job);
    if (channel === 'whatsapp')  shareToWhatsApp(text);
    else if (channel === 'telegram') shareToTelegram(text);
    else if (channel === 'twitter')  shareToTwitter(text);
    else if (channel === 'email')    shareToEmail(`Job: ${job.title} at ${job.company}`, text.replace(/\*/g, ''));
    else if (channel === 'copy')     copyToClipboard(text.replace(/\*/g, ''));
    setOpenShareId(null);
  };

  /** Share selected jobs in bulk via a given channel */
  const shareBulkJobs = (channel: string) => {
    const selected = filteredJobs.filter(j => selectedJobIds.has(j.id));
    if (!selected.length) return;
    const text = buildBulkShareText(selected);
    if (channel === 'whatsapp')  shareToWhatsApp(text);
    else if (channel === 'telegram') shareToTelegram(text);
    else if (channel === 'twitter')  shareToTwitter(text);
    else if (channel === 'email') {
      const subj = `${selected.length} Job Listing${selected.length === 1 ? '' : 's'} from Job Notifier`;
      shareToEmail(subj, text.replace(/\*/g, ''));
    }
    else if (channel === 'copy')  copyToClipboard(text.replace(/\*/g, ''));
    setIsBulkShareOpen(false);
  };

  /** Toggle a single card selection */
  const toggleJobSelect = (id: string) => {
    setSelectedJobIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /** Enter/exit select mode */
  const toggleSelectMode = () => {
    setIsSelectMode(v => !v);
    setSelectedJobIds(new Set());
    setIsBulkShareOpen(false);
  };

  // Reusable share options list (used in both per-card and bulk dropdowns)
  const ShareOptions = ({ onSelect }: { onSelect: (channel: string) => void }) => (
    <>
      <div className="share-dropdown-header">Share via</div>
      <button className="share-option" onClick={() => onSelect('whatsapp')}>
        <span className="share-icon share-icon-whatsapp">💬</span> WhatsApp
      </button>
      <button className="share-option" onClick={() => onSelect('telegram')}>
        <span className="share-icon share-icon-telegram">✈️</span> Telegram
      </button>
      <button className="share-option" onClick={() => onSelect('twitter')}>
        <span className="share-icon share-icon-twitter">𝕏</span> Twitter / X
      </button>
      <button className="share-option" onClick={() => onSelect('email')}>
        <span className="share-icon share-icon-email">✉️</span> Email
      </button>
      <button className="share-option" onClick={() => onSelect('copy')}>
        <span className="share-icon share-icon-copy">📋</span> Copy Link(s)
      </button>
    </>
  );

  // Toggle Applied state of a job
  const toggleApplied = async (id: string, currentStatus: boolean) => {
    try {
      // Optimistic update
      setJobs(jobs.map(j => j.id === id ? { 
        ...j, 
        applied: !currentStatus ? 1 : 0,
        status: !currentStatus ? 'Applied' : (j.status === 'Applied' ? 'Discovered' : j.status)
      } : j));
      
      const res = await fetchApi(`${API_BASE}/jobs/${id}/applied`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applied: !currentStatus })
      });
      const data = await res.json();
      if (!data.success) {
        // Revert on error
        fetchJobs();
        showToast('Error updating job status.');
      }
    } catch (err) {
      fetchJobs();
      showToast('Connection error updating job.');
    }
  };
  {
  <button 
            className="chat-new-btn"
            disabled={isSyncing}
            onClick={triggerSync}
          >
            <span className="material-symbols-outlined">{isSyncing ? 'sync' : 'add'}</span>
            {isSyncing ? (syncStatusText || 'Scanning...') : 'Scan Jobs Now'}
          </button>
  };
  // Delete Job
  const deleteJob = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this job?')) return;
    try {
      // Optimistic update
      setJobs(jobs.filter(j => j.id !== id));
      const res = await fetchApi(`${API_BASE}/jobs/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) {
        fetchJobs();
        showToast('Error deleting job.');
      }
    } catch (err) {
      fetchJobs();
      showToast('Connection error deleting job.');
    }
  };

  // Reset All Jobs
  const resetJobs = async () => {
    if (!window.confirm('Are you sure you want to completely wipe all jobs? This cannot be undone.')) return;
    try {
      showToast('Resetting all jobs...');
      const res = await fetchApi(`${API_BASE}/jobs`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setJobs([]);
        showToast('All jobs have been cleared!');
      } else {
        showToast('Failed to reset jobs: ' + data.error);
      }
    } catch (err) {
      showToast('Error resetting jobs.');
    }
  };
  
  
  // Persist settings to localStorage + backend API. Shared by the explicit "Save" buttons
  // (loud: spinner + toast) and the debounced autosave effect below (silent: small status text).
  const persistSettings = async (settingsToSave: any, opts: { silent?: boolean } = {}) => {
    const { silent = false } = opts;
    if (!silent) setIsSavingSettings(true);
    else setAutosaveStatus('saving');
    localStorage.setItem('jp_settings', JSON.stringify(settingsToSave));
    try {
      const res = await fetchApi(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsToSave)
      });
      const data = await res.json();
      if (data.success) {
        if (silent) {
          setAutosaveStatus('saved');
          setTimeout(() => setAutosaveStatus('idle'), 2000);
        } else {
          showToast('Configuration saved successfully!');
        }
      } else if (silent) {
        setAutosaveStatus('idle');
        showToast('Auto-save failed: ' + data.error);
      } else {
        showToast('Saved locally. API sync failed: ' + data.error);
      }
    } catch (err: any) {
      if (silent) {
        setAutosaveStatus('idle');
        showToast('Auto-save could not reach the server: ' + err.message);
      } else {
        showToast('Saved locally. Could not sync to server: ' + err.message);
      }
    } finally {
      if (!silent) setIsSavingSettings(false);
    }
  };

  // Debounced autosave: any change to settings (keywords, location, sources, toggles...)
  // is written to the server ~1s after the user stops changing things — no button needed.
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      persistSettings(settings, { silent: true });
    }, 1000);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Save Settings — form submit handler for the explicit "Save" buttons
  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await persistSettings(settings, { silent: false });
  };

  // Test Notification
  const testNotification = async () => {
    setIsTestingNotify(true);
    showToast('Sending test alert to phone...');
    try {
      const res = await fetchApi(`${API_BASE}/settings/test-notification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (data.success) {
        showToast('Test push notification delivered! Check your phone.');
      } else {
        showToast('Test failed: ' + data.error);
      }
    } catch (err: any) {
      showToast('Network error: ' + err.message);
    } finally {
      setIsTestingNotify(false);
    }
  };

  // Clear log history
  const clearSystemLogs = async () => {
    if (!confirm('Are you sure you want to delete all scraper logs?')) return;
    try {
      const res = await fetchApi(`${API_BASE}/logs/clear`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setLogs([]);
        showToast('Log history cleared.');
      }
    } catch (err) {
      showToast('Failed to clear logs.');
    }
  };

  // Get unique job sources for filtering, merging active DB sources and currently enabled settings sources
  const uniqueSources = useMemo(() => {
    const dbSources = new Set<string>();
    jobs.forEach(job => {
      if (job.source) {
        dbSources.add(job.source);
      }
    });

    let enabled: string[] = [];
    try {
      enabled = JSON.parse(settings.enabled_sources || '[]');
    } catch (e) {}

    // Map source IDs to display names
    const sourceMap: { [key: string]: string } = {
      linkedin: 'LinkedIn',
      remotive: 'Remotive',
      jobspresso: 'Jobspresso',
      adzuna: 'Adzuna',
      weworkremotely: 'We Work Remotely',
      remoteok: 'RemoteOK',
      dice: 'Dice',
      naukri: 'Naukri',
      simplyhired: 'SimplyHired',
      workingnomads: 'Working Nomads',
      indeed: 'Indeed',
      glassdoor: 'Glassdoor',
      google: 'Google Search',
      hackernews: 'Hacker News (YC Jobs)'
    };

    const allSources = new Set<string>();
    
    // Add all sources that have jobs in the database
    dbSources.forEach(src => allSources.add(src));
    
    // Add all currently enabled sources
    enabled.forEach(srcId => {
      const displayName = sourceMap[srcId];
      if (displayName) {
        allSources.add(displayName);
      }
    });

    return Array.from(allSources).sort();
  }, [jobs, settings.enabled_sources]);

  // Summarize the current log window into error/warning/info counts and, from the most
  // recent "Platform status:" line, a per-platform breakdown of what returned jobs vs.
  // what failed/timed out — so scan health is visible at a glance instead of buried in text.
  const logStats = useMemo(() => {
    let errors = 0, warnings = 0, infos = 0;
    logs.forEach(l => {
      if (l.level === 'ERROR') errors++;
      else if (l.level === 'WARNING') warnings++;
      else infos++;
    });

    const latestPlatformStatus = logs.find(l => l.message && l.message.startsWith('Platform status:'));
    let platforms: { name: string; count: number; ok: boolean }[] = [];
    if (latestPlatformStatus) {
      const body = latestPlatformStatus.message.replace('Platform status:', '').trim();
      platforms = body.split('|').map((part: string) => {
        const m = part.trim().match(/^(.+?):\s*(\d+)\s*jobs/);
        if (!m) return null;
        const name = m[1].trim();
        const count = parseInt(m[2], 10);
        const ok = count > 0 && !part.includes('Failed') && !part.includes('Timeout');
        return { name, count, ok };
      }).filter(Boolean) as { name: string; count: number; ok: boolean }[];
    }

    return { errors, warnings, infos, total: logs.length, platforms, latestAt: latestPlatformStatus?.timestamp };
  }, [logs]);

  // Dynamically calculate counts for All, Claude, Saved, Applied, and Interviewing status tabs
  const tabCounts = useMemo(() => {
    let all = 0;
    let claude = 0;
    let saved = 0;
    let applied = 0;
    let interviewing = 0;

    jobs.forEach(job => {
      const matchesSearch = 
        job.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (job.company && job.company.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (job.location && job.location.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (job.source && job.source.toLowerCase().includes(searchQuery.toLowerCase()));
      
      if (!matchesSearch) return;

      // Filter by source (platform)
      if (sourceFilter !== 'all') {
        const jobSourceLower = (job.source || '').toLowerCase();
        const filterLower = sourceFilter.toLowerCase();
        if (!jobSourceLower.includes(filterLower)) return;
      }

      // Filter by date
      if (dateFilter !== 'all') {
        if (!job.discovered_at) return;
        const dateStr = job.discovered_at.includes(' ') && !job.discovered_at.includes('T')
          ? job.discovered_at.replace(' ', 'T')
          : job.discovered_at;

        const discoveredTime = new Date(dateStr).getTime();
        if (isNaN(discoveredTime)) return;

        const diffMs = Date.now() - discoveredTime;
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        if (dateFilter === '24h' && diffDays > 1) return;
        if (dateFilter === '3d' && diffDays > 3) return;
        if (dateFilter === '7d' && diffDays > 7) return;
        if (dateFilter === '14d' && diffDays > 14) return;
      }

      all++;
      const st = (job.status || '').toLowerCase();
      const isClaude = (job.source || '').toLowerCase().includes('claude') || (job.match_score !== null && job.match_score !== undefined);
      if (isClaude) claude++;
      if (st === 'saved') saved++;
      if (job.applied === 1 || st === 'applied') applied++;
      if (st === 'interviewing') interviewing++;
    });

    return { all, claude, saved, applied, interviewing };
  }, [jobs, searchQuery, sourceFilter, dateFilter]);

  // Filtered Jobs
  const filteredJobs = useMemo(() => {
    return jobs.filter(job => {
      const matchesSearch = 
        job.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (job.company && job.company.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (job.location && job.location.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (job.source && job.source.toLowerCase().includes(searchQuery.toLowerCase()));
      
      if (!matchesSearch) return false;

      // Filter by source (platform)
      if (sourceFilter !== 'all') {
        const jobSourceLower = (job.source || '').toLowerCase();
        const filterLower = sourceFilter.toLowerCase();
        if (!jobSourceLower.includes(filterLower)) return false;
      }

      // Filter by status filter tab
      const st = (job.status || '').toLowerCase();
      const isClaude = (job.source || '').toLowerCase().includes('claude') || (job.match_score !== null && job.match_score !== undefined);
      if (statusFilter === 'claude' && !isClaude) return false;
      if (statusFilter === 'saved' && st !== 'saved') return false;
      if (statusFilter === 'applied' && job.applied !== 1 && st !== 'applied') return false;
      if (statusFilter === 'interviewing' && st !== 'interviewing') return false;

      // Filter by date
      if (dateFilter !== 'all') {
        if (!job.discovered_at) return false;

        // Normalize SQLite timestamp format (replace space with T for cross-browser parsing)
        const dateStr = job.discovered_at.includes(' ') && !job.discovered_at.includes('T')
          ? job.discovered_at.replace(' ', 'T')
          : job.discovered_at;

        const discoveredTime = new Date(dateStr).getTime();
        if (isNaN(discoveredTime)) return false;

        const diffMs = Date.now() - discoveredTime;
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        if (dateFilter === '24h' && diffDays > 1) return false;
        if (dateFilter === '3d' && diffDays > 3) return false;
        if (dateFilter === '7d' && diffDays > 7) return false;
        if (dateFilter === '14d' && diffDays > 14) return false;
      }

      return true;
    });
  }, [jobs, searchQuery, sourceFilter, statusFilter, dateFilter]);

  // Handle Source Checkbox Changes
  const handleSourceChange = (sourceId: string, checked: boolean) => {
    let current: string[] = [];
    try {
      current = JSON.parse(settings.enabled_sources || '[]');
    } catch (e) {}

    if (checked) {
      current = [...current, sourceId];
    } else {
      current = current.filter(s => s !== sourceId);
    }
    
    setSettings({ ...settings, enabled_sources: JSON.stringify(current) });
  };

  const isSourceEnabled = (sourceId: string) => {
    try {
      const parsed = JSON.parse(settings.enabled_sources || '[]');
      return parsed.includes(sourceId);
    } catch (e) {
      return false;
    }
  };

  if (!token) {
    return <Auth onLogin={handleLogin} />;
  }

  return (
    <div className="chat-layout">
      
      {/* MOBILE HEADER */}
      <div className="chat-mobile-header">
        <button className="chat-icon-btn" onClick={() => setIsSidebarOpen(true)}>
          <span className="material-symbols-outlined">menu</span>
        </button>
        <h1 className="logo-text" style={{ fontSize: '1.2rem', margin: 0 }}>Job Notification</h1>
        <div style={{ width: '40px' }}></div> {/* Spacer for centering */}
      </div>

      {/* OVERLAY FOR MOBILE */}
      {isSidebarOpen && (
        <div className="chat-sidebar-overlay" onClick={() => setIsSidebarOpen(false)}></div>
      )}

      {/* LEFT SIDEBAR */}
      <aside className={`chat-sidebar ${isSidebarOpen ? 'open' : ''}`}>
        <div className="chat-sidebar-top">
          <div className="logo-section" style={{ padding: '0.5rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="logo-icon"><span className="material-symbols-outlined">bolt</span></span>
            <h1 className="logo-text" style={{ fontSize: '1.25rem' }}>Job Notification</h1>
          </div>
          
          <button 
            className="chat-new-btn"
            disabled={isSyncing}
            onClick={triggerSync}
          >
            <span className="material-symbols-outlined">{isSyncing ? 'sync' : 'add'}</span>
            {isSyncing ? (syncStatusText || 'Scanning...') : 'Scan Jobs Now'}
          </button>
        </div>

        <nav className="chat-sidebar-nav">
          <button 
            className={`chat-nav-item ${activeTab === 'feed' ? 'active' : ''}`}
            onClick={() => { setActiveTab('feed'); setIsSidebarOpen(false); }}
          >
            <span className="material-symbols-outlined">list_alt</span> Job Feed
            <span className="chat-nav-badge">{filteredJobs.length}</span>
          </button>
          <button 
            className={`chat-nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => { setActiveTab('dashboard'); setIsSidebarOpen(false); }}
          >
            <span className="material-symbols-outlined">dashboard</span> Dashboard
          </button>
          <button 
            className={`chat-nav-item ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => { setActiveTab('settings'); setIsSidebarOpen(false); }}
          >
            <span className="material-symbols-outlined">settings</span> Job Preferences
          </button>
          <button 
            className={`chat-nav-item ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => { setActiveTab('logs'); setIsSidebarOpen(false); }}
          >
            <span className="material-symbols-outlined">receipt_long</span> Logs
          </button>
          <button 
            className={`chat-nav-item ${activeTab === 'resume' ? 'active' : ''}`}
            onClick={() => { setActiveTab('resume'); setIsSidebarOpen(false); }}
          >
            <span className="material-symbols-outlined">description</span> Resume & Match
            {resume && <span className="chat-nav-badge" style={{ background: '#10b981', color: '#fff', fontSize: '0.65rem' }}>✓</span>}
          </button>
          <button 
            className={`chat-nav-item ${activeTab === 'mcp' ? 'active' : ''}`}
            onClick={() => { setActiveTab('mcp'); setIsSidebarOpen(false); }}
          >
            <span className="material-symbols-outlined">power</span> Connect Claude MCP
            {mcpStatus.connected && <span className="chat-nav-badge" style={{ background: '#38bdf8', color: '#0f172a', fontSize: '0.65rem', fontWeight: 700 }}>ON</span>}
          </button>
          {isAdmin && (
            <button 
              className={`chat-nav-item ${activeTab === 'admin' ? 'active' : ''}`}
              onClick={() => { setActiveTab('admin'); setIsSidebarOpen(false); }}
            >
              <span className="material-symbols-outlined">shield_person</span> Admin
            </button>
          )}
        </nav>

        <div className="chat-sidebar-bottom">
          <div className="chat-user-profile">
            <div className="chat-user-avatar">
              {username.charAt(0).toUpperCase()}
            </div>
            <div className="chat-user-info">
              <span className="chat-user-name">{username}</span>
              <span className="chat-user-role">Free Plan</span>
            </div>
            <button className="chat-icon-btn" onClick={handleLogout} title="Logout">
              <span className="material-symbols-outlined">logout</span>
            </button>
          </div>
        </div>
      </aside>

      {/* RIGHT SIDE: MAIN CONTENT */}
      <main className="chat-main">
        
        {/* Toast Notification */}
        {toast.show && (
          <div className="toast">
            <span><span className="material-symbols-outlined">info</span></span> {toast.message}
          </div>
        )}

        {/* Right-side Job Preferences slide-out panel — quick editing from the Feed without leaving it */}
        {isPrefPanelOpen && (
          <div className="pref-drawer-overlay" onClick={() => setIsPrefPanelOpen(false)}>
            <form
              className="pref-drawer"
              onClick={e => e.stopPropagation()}
              onSubmit={async (e) => {
                await saveSettings(e);
              }}
            >
              <div className="pref-drawer-header">
                <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>tune</span>
                  Job Preferences
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <AutosaveIndicator status={autosaveStatus} />
                  <button type="button" className="chat-icon-btn" onClick={() => setIsPrefPanelOpen(false)} title="Close">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              </div>

              <div className="pref-drawer-body">
                <div className="form-group">
                  <label className="form-label">Search Keywords</label>
                  <textarea
                    className="form-textarea"
                    placeholder="Product Designer, React Developer"
                    value={settings.keywords}
                    onChange={e => setSettings({ ...settings, keywords: e.target.value })}
                    rows={3}
                  />
                  <p className="helper-text">Comma-separated exact job titles. "Product Designer" only matches that phrase — not Graphic Designer or Product Manager.</p>
                </div>

                <div className="form-group">
                  <label className="form-label">Location</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. Bengaluru, India"
                    value={settings.location || ''}
                    onChange={e => setSettings({ ...settings, location: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Work Arrangement</label>
                  <select
                    className="form-select"
                    value={settings.work_type || 'all'}
                    onChange={e => setSettings({ ...settings, work_type: e.target.value })}
                  >
                    <option value="all">All Jobs (No filter)</option>
                    <option value="onsite">Onsite Only</option>
                    <option value="remote">Remote Only</option>
                    <option value="hybrid">Hybrid Only</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Job Search Sources</label>
                  <div className="sources-grid">
                    {[
                      { id: 'linkedin', label: 'LinkedIn' },
                      { id: 'adzuna', label: 'Adzuna API' },
                      { id: 'hackernews', label: 'Hacker News (YC Jobs)' },
                      { id: 'weworkremotely', label: 'We Work Remotely' },
                      { id: 'remoteok', label: 'RemoteOK' },
                      { id: 'dice', label: 'Dice' },
                      { id: 'naukri', label: 'Naukri' },
                      { id: 'simplyhired', label: 'SimplyHired' },
                      { id: 'indeed', label: 'Indeed' },
                      { id: 'glassdoor', label: 'Glassdoor' },
                      { id: 'google', label: 'Google Search' },
                    ].map(src => {
                      const unreliable = UNRELIABLE_SOURCES.has(src.id);
                      return (
                        <div
                          key={src.id}
                          className={`source-checkbox-card ${isSourceEnabled(src.id) ? 'checked' : ''} ${unreliable ? 'has-warning' : ''}`}
                          onClick={() => handleSourceChange(src.id, !isSourceEnabled(src.id))}
                        >
                          <input type="checkbox" checked={isSourceEnabled(src.id)} onChange={() => {}} />
                          <div>
                            <span>{src.label}</span>
                            {unreliable && (
                              <div className="source-warning-badge">
                                <span className="material-symbols-outlined" style={{ fontSize: '0.85rem' }}>warning</span>
                                May be blocked
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="pref-drawer-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => { setIsPrefPanelOpen(false); setActiveTab('settings'); }}
                >
                  All Settings
                </button>
                <button type="button" className="btn" onClick={() => setIsPrefPanelOpen(false)}>
                  <span className="material-symbols-outlined" style={{ fontSize: '1.2rem' }}>check</span>
                  Done
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="chat-content-centered">

      {/* 1. JOB FEED VIEW */}
      {activeTab === 'feed' && (
        <div>
          <div className="feed-controls glass-card">
  {/* Preferences button, above the search bar */}
  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
    <button
      type="button"
      className="btn btn-secondary"
      onClick={() => setIsPrefPanelOpen(true)}
      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
    >
      <span className="material-symbols-outlined">tune</span> Preferences
    </button>
  </div>
  {/* Search bar stays at the top */}
  <div className="search-bar">
    <span><span className="material-symbols-outlined">search</span></span>
    <input 
      type="text" 
      className="search-input" 
      placeholder="Search job title, company, source or location..." 
      value={searchQuery}
      onChange={e => setSearchQuery(e.target.value)}
    />
  </div>
  
  {/* New toolbar row: left = actions, right = filters */}
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem' }}>
    {/* LEFT side: Scan + Select Mode */}
    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
      <button 
        className="btn" 
        disabled={isSyncing}
        onClick={triggerSync}
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
      >
        <span className="material-symbols-outlined">{isSyncing ? 'sync' : 'add'}</span>
        {isSyncing ? 'Scanning...' : 'Scan Jobs Now'}
      </button>

      {/* Share with Friends (Select Mode toggle) */}
      <button
        className={`btn btn-select-mode${isSelectMode ? ' active' : ''}`}
        onClick={toggleSelectMode}
        title={isSelectMode ? 'Exit Selection Mode' : 'Select multiple jobs to share with friends'}
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
      >
        <span className="material-symbols-outlined">{isSelectMode ? 'close' : 'share'}</span>
        {isSelectMode ? 'Cancel Selection' : 'Share with Friends'}
      </button>

      {/* mobile reset moved to filter-group for desired mobile layout */}
    </div>

    {/* RIGHT side: all filters */}
    <div className="filter-group" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
      <select
        className="form-select filter-select"
        value={sourceFilter}
        onChange={e => setSourceFilter(e.target.value)}
      >
        <option value="all">All Platforms</option>
        {uniqueSources.map(src => (
          <option key={src} value={src}>{src}</option>
        ))}
      </select>

      <select
        className="form-select filter-select"
        value={dateFilter}
        onChange={e => setDateFilter(e.target.value as any)}
      >
        <option value="all">Anytime</option>
        <option value="24h">Past 24 Hours</option>
        <option value="3d">Past 3 Days</option>
        <option value="7d">Past Week</option>
        <option value="14d">Past 2 Weeks</option>
      </select>
      {/* Mobile-only compact reset icon placed here so filters appear below Scan on mobile */}
      <button
        className="btn btn-danger reset-mobile"
        onClick={resetJobs}
        title="Reset Jobs"
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginLeft: 'auto' }}
      >
        <span className="material-symbols-outlined">autorenew</span>
      </button>
      
      <button 
        className="btn btn-secondary reset-desktop" 
        onClick={resetJobs}
        title="Wipe all jobs from the database"
        style={{ color: 'var(--danger)', borderColor: 'rgba(242, 139, 130, 0.3)' }}
      >
        <span className="material-symbols-outlined">autorenew</span> Reset Jobs
      </button>
    </div>
  </div>
</div>

          {/* Sub-tabs for filtering by Application Tracking lifecycle */}
          <div className="sub-tabs-container">
            <div className="sub-tabs">
              <button 
                className={`sub-tab-btn ${statusFilter === 'all' ? 'active' : ''}`}
                onClick={() => setStatusFilter('all')}
              >
                <span className="material-symbols-outlined">work</span> All Jobs <span className="sub-tab-count">{tabCounts.all}</span>
              </button>
              <button 
                className={`sub-tab-btn ${statusFilter === 'claude' ? 'active' : ''}`}
                onClick={() => setStatusFilter('claude')}
                style={{ color: statusFilter === 'claude' ? '#a78bfa' : undefined }}
              >
                <span className="material-symbols-outlined" style={{ color: '#a78bfa' }}>auto_awesome</span> Claude Matches <span className="sub-tab-count" style={{ background: 'rgba(167, 139, 250, 0.15)', color: '#a78bfa' }}>{tabCounts.claude}</span>
              </button>
              <button
                className={`sub-tab-btn ${statusFilter === 'saved' ? 'active' : ''}`}
                onClick={() => setStatusFilter('saved')}
              >
                <span className="material-symbols-outlined">bookmark</span> Saved <span className="sub-tab-count">{tabCounts.saved}</span>
              </button>
              <button
                className={`sub-tab-btn ${statusFilter === 'applied' ? 'active' : ''}`}
                onClick={() => setStatusFilter('applied')}
              >
                <span className="material-symbols-outlined">check_circle</span> Applied <span className="sub-tab-count">{tabCounts.applied}</span>
              </button>
              <button
                className={`sub-tab-btn ${statusFilter === 'interviewing' ? 'active' : ''}`}
                onClick={() => setStatusFilter('interviewing')}
              >
                <span className="material-symbols-outlined">event_available</span> Interviewing <span className="sub-tab-count">{tabCounts.interviewing}</span>
              </button>
            </div>
          </div>

          {/* Multi-select guidance banner */}
          {isSelectMode && (
            <div style={{
              background: 'rgba(56, 189, 248, 0.08)',
              border: '1px solid rgba(56, 189, 248, 0.25)',
              borderRadius: '8px',
              padding: '0.75rem 1rem',
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#38bdf8', fontSize: '0.875rem' }}>
                <span className="material-symbols-outlined">info</span>
                <span>Click any job card to select it for sharing with friends (or click <b>Select All</b>).</span>
              </div>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }}
                onClick={() => {
                  const allIds = new Set(filteredJobs.map(j => j.id));
                  setSelectedJobIds(prev => prev.size === allIds.size ? new Set() : allIds);
                }}
              >
                {selectedJobIds.size === filteredJobs.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
          )}

          <>
          {filteredJobs.length === 0 ? (
            <div className="glass-card empty-state" style={{ maxWidth: '600px', margin: '2rem auto', textAlign: 'left', padding: '2rem' }}>
              <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                <span className="empty-icon"><span className="material-symbols-outlined" style={{ fontSize: '3rem', color: 'var(--text-muted)' }}>{jobs.length === 0 ? 'warning' : 'folder_open'}</span></span>
                <h3 style={{ marginTop: '1rem', fontSize: '1.25rem' }}>{jobs.length === 0 ? 'No Jobs Have Been Fetched Yet' : 'No Jobs Match Your Filters'}</h3>
              </div>
              
              {jobs.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.95rem', lineHeight: '1.5' }}>
                  <p style={{ marginBottom: '1rem' }}>It looks like are jobs not found yet. Here are the most common reasons why:</p>
                  <ul style={{ listStyleType: 'disc', paddingLeft: '1.5rem', marginBottom: '1rem' }}>
                    <li style={{ marginBottom: '0.5rem' }}><strong>Bot Protection:</strong> Indeed, Glassdoor, Naukri, Dice, SimplyHired, and Google Search frequently block automated requests. Check the <b>Logs</b> tab to see if requests are returning 403/429 errors — this is expected for those sources, not a bug.</li>
                    <li style={{ marginBottom: '0.5rem' }}><strong>Strict Keywords:</strong> Your keywords in Settings might be too narrow. Try removing some to broaden the search.</li>
                    <li style={{ marginBottom: '0.5rem' }}><strong>API Keys:</strong> If you enabled Adzuna, ensure your App ID and Key are correctly entered.</li>
                    
                  </ul>
                  <p style={{ textAlign: 'center', marginTop: '1.5rem' }}>
                    <button className="btn btn-secondary" onClick={() => setActiveTab('logs')} style={{ marginRight: '1rem' }}>
                      <span className="material-symbols-outlined">receipt_long</span> View Logs
                    </button>
                    <button className="btn btn-primary" onClick={() => setActiveTab('settings')}>
                      <span className="material-symbols-outlined">settings</span> Check Settings
                    </button>
                  </p>
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', textAlign: 'center', fontSize: '0.95rem' }}>
                  You have {jobs.length} jobs in your feed, but none match your current search, source, status, or date filters. Try adjusting them above.
                </p>
              )}
            </div>
          ) : (
            <div className="job-grid">
              {filteredJobs.map(job => {
                const isSelected = selectedJobIds.has(job.id);
                return (
                  <div
                    key={job.id}
                    className={`glass-card job-card ${job.applied === 1 ? 'applied' : ''} ${isSelected ? 'selected' : ''} ${isSelectMode ? 'select-mode' : ''}`}
                    onClick={isSelectMode ? () => toggleJobSelect(job.id) : undefined}
                    style={isSelectMode ? { cursor: 'pointer' } : undefined}
                  >
                    {/* Multi-select checkbox */}
                    {isSelectMode && (
                      <div
                        className={`job-card-checkbox ${isSelected ? 'checked' : ''}`}
                        onClick={e => { e.stopPropagation(); toggleJobSelect(job.id); }}
                      >
                        {isSelected && <span className="material-symbols-outlined">check</span>}
                      </div>
                    )}

                    <div className="job-header">
                      <div className="job-header-title-group">
                        <h3 className="job-title">{job.title}</h3>
                        <div className="job-company"><span className="material-symbols-outlined">business</span> {job.company}</div>
                      </div>
                      <div className="job-header-badges">
                        {job.match_score !== null && job.match_score !== undefined && (
                          <span className="badge badge-match">
                            <span className="material-symbols-outlined" style={{ fontSize: '0.85rem', marginRight: '2px' }}>psychology</span>
                            {job.match_score}% Match
                          </span>
                        )}
                        {job.status && job.status.toLowerCase() !== 'discovered' && (
                          <span className={`badge badge-status badge-status-${job.status.toLowerCase()}`}>
                            {job.status}
                          </span>
                        )}
                        {job.applied === 1 && (!job.status || job.status.toLowerCase() !== 'applied') && (
                          <span className="badge badge-applied">Applied</span>
                        )}
                        {/* 1-click Bookmark / Save Button */}
                        <button
                          type="button"
                          className="btn-bookmark"
                          onClick={(e) => {
                            e.stopPropagation();
                            const isSaved = (job.status || '').toLowerCase() === 'saved';
                            updateJobStatusAction(job.id, isSaved ? 'Discovered' : 'Saved');
                          }}
                          title={(job.status || '').toLowerCase() === 'saved' ? 'Unsave job' : 'Save for later'}
                          style={{
                            color: (job.status || '').toLowerCase() === 'saved' ? '#38bdf8' : 'var(--text-muted)',
                            marginLeft: '0.2rem'
                          }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>
                            {(job.status || '').toLowerCase() === 'saved' ? 'bookmark' : 'bookmark_border'}
                          </span>
                        </button>

                        {/* Top-Right More Actions (⋮) Dropdown */}
                        <div className="more-actions-wrapper">
                          <button
                            type="button"
                            className="btn-more-icon"
                            title="More options"
                            onClick={e => {
                              e.stopPropagation();
                              setOpenMoreJobId(openMoreJobId === job.id ? null : job.id);
                            }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>more_vert</span>
                          </button>

                          {openMoreJobId === job.id && (
                            <div className="more-dropdown">
                              <button
                                type="button"
                                className="more-dropdown-item"
                                onClick={() => {
                                  setOpenMoreJobId(null);
                                  toggleApplied(job.id, job.applied === 1);
                                }}
                              >
                                <span className="material-symbols-outlined">
                                  {job.applied === 1 ? 'undo' : 'check_circle'}
                                </span>
                                {job.applied === 1 ? 'Mark Unapplied' : 'Mark as Applied'}
                              </button>

                              <button
                                type="button"
                                className="more-dropdown-item"
                                onClick={() => {
                                  setOpenMoreJobId(null);
                                  updateJobStatusAction(job.id, (job.status || '').toLowerCase() === 'saved' ? 'Discovered' : 'Saved');
                                }}
                              >
                                <span className="material-symbols-outlined">bookmark</span>
                                {(job.status || '').toLowerCase() === 'saved' ? 'Unsave Job' : 'Save for Later'}
                              </button>

                              <button
                                type="button"
                                className="more-dropdown-item"
                                onClick={() => {
                                  setOpenMoreJobId(null);
                                  const isInterviewing = (job.status || '').toLowerCase() === 'interviewing';
                                  updateJobStatusAction(job.id, isInterviewing ? 'Applied' : 'Interviewing');
                                }}
                              >
                                <span className="material-symbols-outlined">event_available</span>
                                {(job.status || '').toLowerCase() === 'interviewing' ? 'Remove from Interviewing' : 'Mark Interviewing'}
                              </button>

                              <button
                                type="button"
                                className="more-dropdown-item"
                                onClick={() => {
                                  setOpenMoreJobId(null);
                                  triggerQuickMatch(job.id);
                                }}
                              >
                                <span className="material-symbols-outlined">calculate</span>
                                Calculate Match Score
                              </button>

                              <button
                                type="button"
                                className="more-dropdown-item"
                                onClick={() => {
                                  setOpenMoreJobId(null);
                                  copyClaudeMatchPrompt(job);
                                }}
                              >
                                <span className="material-symbols-outlined">content_copy</span>
                                Copy Prompt for Claude
                              </button>

                              <div className="more-dropdown-divider" />

                              <button
                                type="button"
                                className="more-dropdown-item"
                                onClick={() => {
                                  setOpenMoreJobId(null);
                                  setOpenShareId(openShareId === job.id ? null : job.id);
                                }}
                              >
                                <span className="material-symbols-outlined">share</span>
                                Share with Friends
                              </button>

                              <button
                                type="button"
                                className="more-dropdown-item danger"
                                onClick={() => {
                                  setOpenMoreJobId(null);
                                  deleteJob(job.id);
                                }}
                              >
                                <span className="material-symbols-outlined">delete</span>
                                Delete Job
                              </button>
                            </div>
                          )}

                          {/* Per-card share modal/dropdown wrapper if opened from More */}
                          {openShareId === job.id && (
                            <div className="share-wrapper" style={{ position: 'relative' }}>
                              <div className="share-dropdown" ref={shareDropdownRef}>
                                <ShareOptions onSelect={ch => shareSingleJob(job, ch)} />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="job-meta-row">
                      <span className="badge badge-source">{job.source}</span>
                      {job.location && <span className="badge badge-location"><span className="material-symbols-outlined">location_on</span> {job.location}</span>}
                      {job.salary && <span className="badge badge-salary"><span className="material-symbols-outlined">payments</span> {job.salary}</span>}
                      <span className="badge" style={{ fontSize: '0.7rem' }}>
                        <span className="material-symbols-outlined">calendar_today</span> {new Date(job.discovered_at).toLocaleDateString()}
                      </span>
                    </div>

                    <p
                      className="job-description"
                      dangerouslySetInnerHTML={{ __html: job.description.replace(/<[^>]*>/g, '') }}
                    />

                    {job.match_reasons && (
                      <div className="match-reasons-card" style={{ marginBottom: '1rem', background: 'rgba(139, 92, 246, 0.08)', border: '1px solid rgba(139, 92, 246, 0.25)', borderRadius: '8px', padding: '0.75rem 1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setExpandedMatchId(expandedMatchId === job.id ? null : job.id)}>
                          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#a78bfa', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>auto_awesome</span> Claude Match Analysis ({job.match_score || 0}%)
                          </span>
                          <span className="material-symbols-outlined" style={{ fontSize: '1rem', color: '#a78bfa' }}>
                            {expandedMatchId === job.id ? 'expand_less' : 'expand_more'}
                          </span>
                        </div>
                        {expandedMatchId === job.id && (
                          <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.5', whiteSpace: 'pre-line' }}>
                            {job.match_reasons}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="job-actions">
                      {!isSelectMode && (
                        <>
                          {/* Main Button 1: Apply Now */}
                          <a
                            href={job.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn job-link"
                            onClick={() => {
                              if (job.applied !== 1) {
                                toggleApplied(job.id, false);
                              }
                            }}
                            title="Open external job application and mark as Applied"
                          >
                            Apply Now <span className="material-symbols-outlined" style={{ fontSize: '1rem', marginLeft: '4px' }}>open_in_new</span>
                          </a>

                          {/* Main Button 2: Match with Claude */}
                          <button
                            className="btn btn-secondary"
                            onClick={() => {
                              if (job.match_score) {
                                setExpandedMatchId(expandedMatchId === job.id ? null : job.id);
                              } else {
                                triggerQuickMatch(job.id);
                              }
                            }}
                            title={job.match_score ? 'Toggle match analysis' : 'Calculate match score with your candidate resume'}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', borderColor: job.match_score ? 'rgba(56, 189, 248, 0.4)' : undefined }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: '1.05rem', color: '#38bdf8' }}>psychology</span>
                            {job.match_score !== null && job.match_score !== undefined ? `${job.match_score}% Match Analysis` : 'Match with Claude'}
                          </button>
                        </>
                      )}

                      {isSelectMode && (
                        <button
                          className={`btn ${isSelected ? 'btn-select-mode active' : 'btn-select-mode'}`}
                          onClick={e => { e.stopPropagation(); toggleJobSelect(job.id); }}
                          style={{ width: '100%', justifyContent: 'center' }}
                        >
                          <span className="material-symbols-outlined">{isSelected ? 'check_box' : 'check_box_outline_blank'}</span>
                          {isSelected ? 'Selected' : 'Select'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Floating bulk-share toolbar — rendered outside the ternary as a sibling */}
          {isSelectMode && selectedJobIds.size > 0 && (
            <div className="bulk-share-bar">
              <span className="bulk-share-count">
                {selectedJobIds.size} job{selectedJobIds.size === 1 ? '' : 's'} selected
              </span>

              <button
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '0.45rem 0.9rem' }}
                onClick={() => {
                  const allIds = new Set(filteredJobs.map(j => j.id));
                  setSelectedJobIds(prev => prev.size === allIds.size ? new Set() : allIds);
                }}
              >
                {selectedJobIds.size === filteredJobs.length ? 'Deselect All' : 'Select All'}
              </button>

              <div className="bulk-share-divider" />

              <div className="share-wrapper">
                <button
                  className="btn"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}
                  onClick={() => setIsBulkShareOpen(v => !v)}
                >
                  <span className="material-symbols-outlined">share</span>
                  Share Selected
                </button>
                {isBulkShareOpen && (
                  <div className="bulk-share-dropdown">
                    <ShareOptions onSelect={ch => shareBulkJobs(ch)} />
                  </div>
                )}
              </div>

              <button
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '0.45rem 0.9rem' }}
                onClick={toggleSelectMode}
              >
                <span className="material-symbols-outlined">close</span> Cancel
              </button>
            </div>
          )}
          </>
        </div>
      )}

      {/* DASHBOARD VIEW */}
      {activeTab === 'dashboard' && (() => {
        const total = jobs.length;
        const applied = jobs.filter(j => j.applied === 1 || j.status === 'Applied').length;
        const interviewing = jobs.filter(j => (j.status || '').toLowerCase() === 'interviewing').length;
        const saved = jobs.filter(j => (j.status || '').toLowerCase() === 'saved').length;
        const evaluated = jobs.filter(j => j.match_score !== null && j.match_score !== undefined).length;
        const highMatch = jobs.filter(j => (j.match_score || 0) >= 80).length;

        // Platform breakdown
        const platformCounts: Record<string, number> = {};
        jobs.forEach(j => {
          const src = j.source || 'Other';
          platformCounts[src] = (platformCounts[src] || 0) + 1;
        });

        return (
          <div className="dashboard-layout" style={{ width: '100%' }}>
            <div className="dashboard-header glass-card" style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '2rem' }}>analytics</span>
                  Job Pulse Analytics Dashboard
                </h1>
                <p style={{ margin: '0.4rem 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  Real-time pipeline metrics, platform distribution, and Claude MCP intelligence.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button className="btn" disabled={isSyncing} onClick={triggerSync} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span className="material-symbols-outlined">{isSyncing ? 'sync' : 'refresh'}</span>
                  {isSyncing ? 'Scanning...' : 'Scan Jobs Now'}
                </button>
                <button className="btn btn-secondary" onClick={() => setActiveTab('feed')}>
                  View Feed ({total})
                </button>
              </div>
            </div>

            {/* KPI Cards Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
              <div className="glass-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Discovered</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--primary)', margin: '0.4rem 0' }}>{total}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Across all platforms</div>
              </div>

              <div className="glass-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Bookmarked</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: '#60a5fa', margin: '0.4rem 0' }}>{saved}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Saved for review</div>
              </div>

              <div className="glass-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Applied</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: '#34d399', margin: '0.4rem 0' }}>{applied}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{total > 0 ? Math.round((applied / total) * 100) : 0}% pipeline rate</div>
              </div>

              <div className="glass-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Interviewing</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: '#fbbf24', margin: '0.4rem 0' }}>{interviewing}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Active interviews</div>
              </div>

              <div className="glass-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Claude Matches</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: '#a78bfa', margin: '0.4rem 0' }}>{evaluated}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{highMatch} with 80%+ fit</div>
              </div>

              <div className="glass-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>MCP Status</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#34d399', margin: '0.7rem 0 0.4rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '1.4rem' }}>bolt</span> Ready
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Stdio Transport</div>
              </div>
            </div>

            {/* Funnel & Platform Row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem', marginBottom: '1.5rem' }}>
              {/* Application Funnel */}
              <div className="glass-card">
                <h3 style={{ margin: '0 0 1rem', fontSize: '1.05rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>filter_alt</span>
                  Application Funnel
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {[
                    { label: 'Discovered', count: total, color: 'var(--primary)', pct: 100, filterKey: 'all' },
                    { label: 'Saved', count: saved, color: '#60a5fa', pct: total > 0 ? Math.round((saved / total) * 100) : 0, filterKey: 'saved' },
                    { label: 'Applied', count: applied, color: '#34d399', pct: total > 0 ? Math.round((applied / total) * 100) : 0, filterKey: 'applied' },
                    { label: 'Interviewing', count: interviewing, color: '#fbbf24', pct: total > 0 ? Math.round((interviewing / total) * 100) : 0, filterKey: 'interviewing' },
                  ].map(step => (
                    <div
                      key={step.label}
                      style={{ cursor: 'pointer', padding: '0.2rem 0.3rem', borderRadius: '4px', transition: 'background 0.2s' }}
                      title={`Click to view ${step.label} jobs in Feed`}
                      onClick={() => {
                        setStatusFilter(step.filterKey as any);
                        setActiveTab('feed');
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          {step.label}
                          <span className="material-symbols-outlined" style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>arrow_forward</span>
                        </span>
                        <span style={{ fontWeight: 600 }}>{step.count} ({step.pct}%)</span>
                      </div>
                      <div style={{ height: '8px', background: 'var(--bg-input)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div style={{ width: `${Math.max(step.pct, step.count > 0 ? 3 : 0)}%`, height: '100%', background: step.color, borderRadius: '4px', transition: 'width 0.4s ease' }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Source Platforms Distribution */}
              <div className="glass-card">
                <h3 style={{ margin: '0 0 1rem', fontSize: '1.05rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>hub</span>
                  Platform Sources Distribution
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                  {Object.entries(platformCounts).slice(0, 6).map(([source, count]) => {
                    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                    return (
                      <div key={source}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                          <span style={{ fontWeight: 500 }}>{source}</span>
                          <span style={{ color: 'var(--text-muted)' }}>{count} ({pct}%)</span>
                        </div>
                        <div style={{ height: '6px', background: 'var(--bg-input)', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, #6366f1, #a855f7)', borderRadius: '3px' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Quick Actions & Resume Status */}
            <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <h4 style={{ margin: 0, fontWeight: 600 }}>Active Resume Profile</h4>
                <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  {resume ? `Loaded "${resume.filename}" (${resume.text.length} characters) — Ready for Claude MCP match scoring` : 'No resume uploaded yet. Upload your resume so Claude Desktop can score job descriptions.'}
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button className="btn btn-secondary" onClick={() => setActiveTab('resume')}>
                  <span className="material-symbols-outlined">description</span> {resume ? 'Manage Resume' : 'Upload Resume'}
                </button>
                <button className="btn btn-secondary" onClick={() => setActiveTab('mcp')}>
                  <span className="material-symbols-outlined" style={{ color: '#a78bfa' }}>bolt</span> Claude MCP Setup
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* RESUME & JD MATCH VIEW */}
      {activeTab === 'resume' && (() => {
        const evaluatedJobs = jobs.filter(j => j.match_score !== null && j.match_score !== undefined)
          .sort((a, b) => (b.match_score || 0) - (a.match_score || 0));

        // Detect some common skills in resume draft
        const popularSkills = ['React', 'Node.js', 'TypeScript', 'JavaScript', 'Python', 'SQL', 'PostgreSQL', 'Docker', 'AWS', 'GraphQL', 'Next.js', 'Express', 'Git', 'REST API', 'Tailwind', 'Microservices'];
        const detectedSkills = popularSkills.filter(s => resumeDraft.toLowerCase().includes(s.toLowerCase()));

        const hasResumeChanges = resumeDraft.trim() !== (resume?.text || '').trim();

        return (
          <div className="resume-layout" style={{ width: '100%' }}>
            <div className="glass-card" style={{ marginBottom: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <h2 style={{ margin: 0, fontWeight: 700, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span className="material-symbols-outlined">description</span>
                    Resume & Candidate Profile
                  </h2>
                  <p style={{ margin: '0.3rem 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    Upload your resume or paste its text. Claude reads this via MCP to calculate your JD match percentage.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <label className="btn btn-secondary" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span className="material-symbols-outlined">upload_file</span> Choose File
                    <input type="file" accept=".txt,.md,.pdf,.doc,.docx" onChange={handleResumeFileUpload} style={{ display: 'none' }} />
                  </label>
                  <button 
                    className={hasResumeChanges && resumeDraft.trim() ? "btn" : "btn btn-secondary"} 
                    disabled={isSavingResume || !hasResumeChanges || !resumeDraft.trim()} 
                    onClick={() => saveResume()} 
                    style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '0.4rem', 
                      opacity: (!hasResumeChanges || !resumeDraft.trim()) ? 0.65 : 1,
                      cursor: (!hasResumeChanges || !resumeDraft.trim()) ? 'default' : 'pointer'
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ color: (!hasResumeChanges && resume?.text) ? '#10b981' : undefined }}>
                      {isSavingResume ? 'sync' : (!hasResumeChanges && resume?.text ? 'check_circle' : 'save')}
                    </span>
                    {isSavingResume ? 'Saving...' : (!hasResumeChanges && resume?.text ? 'Saved' : 'Save Resume')}
                  </button>
                </div>
              </div>

              {/* Detected skills pills */}
              {detectedSkills.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, display: 'block', marginBottom: '0.4rem' }}>Detected Keywords & Skills:</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                    {detectedSkills.map(sk => (
                      <span key={sk} className="badge badge-source" style={{ fontSize: '0.75rem' }}>{sk}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Text Area */}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <textarea
                  className="form-input"
                  rows={10}
                  placeholder="Paste your plain-text resume here or upload a file above (Work Experience, Skills, Education, Projects)..."
                  value={resumeDraft}
                  onChange={e => setResumeDraft(e.target.value)}
                  style={{ fontFamily: 'monospace', fontSize: '0.85rem', lineHeight: '1.5' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                  <span>{resumeDraft.length} characters | ~{resumeDraft.split(/\s+/).filter(Boolean).length} words</span>
                  {resume?.updated_at && <span>Last saved: {new Date(resume.updated_at).toLocaleString()}</span>}
                </div>
              </div>
            </div>

            {/* How Claude match works banner */}
            <div className="glass-card" style={{ marginBottom: '1.5rem', background: 'rgba(0, 119, 217, 0.05)', border: '1px solid rgba(0, 119, 217, 0.25)' }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span className="material-symbols-outlined">psychology</span> How Match Scoring Works
              </h3>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                Job Pulse is designed with <strong>zero internal AI API keys</strong> and zero recurring AI inference fees. 
                Instead, your connected <strong>Claude</strong> assistant queries your profile using <code>get_user_resume</code>, evaluates any job posting with <code>analyze_job_fit</code>, and saves the verified match percentage with <code>save_job_match</code>.
              </p>
            </div>

            {/* Evaluated Jobs List */}
            <div className="glass-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>
                  Evaluated Job Matches ({evaluatedJobs.length})
                </h3>
                <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => setActiveTab('feed')}>
                  Go to Feed to Match More Jobs
                </button>
              </div>

              {evaluatedJobs.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-muted)' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '2.5rem', color: 'var(--text-muted)' }}>rule</span>
                  <p style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>No job matches evaluated yet.</p>
                  <p style={{ fontSize: '0.8rem' }}>Go to your Job Feed and click <strong>"Match with Claude"</strong> on any job card, or ask Claude to score your jobs!</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {evaluatedJobs.map(j => (
                    <div key={j.id} style={{ border: '1px solid var(--border-glass)', borderRadius: '8px', padding: '1rem', background: 'var(--bg-input)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{j.title}</div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{j.company} • {j.location || 'Remote'}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span className="badge badge-match" style={{ fontSize: '0.85rem', padding: '0.3rem 0.7rem' }}>
                            {j.match_score}% Match
                          </span>
                          <button className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }} onClick={() => triggerQuickMatch(j.id)}>
                            Re-Score
                          </button>
                        </div>
                      </div>
                      {j.match_reasons && (
                        <div style={{ marginTop: '0.75rem', fontSize: '0.825rem', color: 'var(--text-secondary)', lineHeight: '1.5', whiteSpace: 'pre-line', borderTop: '1px dashed var(--border-glass)', paddingTop: '0.5rem' }}>
                          {j.match_reasons}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* CONNECT CLAUDE MCP VIEW */}
      {activeTab === 'mcp' && (() => {
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/api\/?$/, '');
        const mcpUrl = apiBaseUrl.startsWith('http') 
          ? `${apiBaseUrl}/mcp`
          : isLocalhost 
            ? 'http://localhost:5000/mcp'
            : `${window.location.origin}/mcp`;

        return (
          <div className="mcp-layout full-page-card" style={{ width: '100%' }}>
            {/* Top Card: Connect Claude with Right-Aligned Config Actions */}
            <div className="glass-card" style={{ marginBottom: '1.5rem', border: '1px solid rgba(0, 119, 217, 0.3)' }}>
              <div className="mcp-header">
                <div>
                  <span className="badge badge-match" style={{ marginBottom: '0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>power</span> Model Context Protocol
                  </span>
                  <h2 style={{ margin: 0, fontWeight: 700, color: 'var(--primary)' }}>
                    Connect Your Claude Account
                  </h2>
                  <p style={{ margin: '0.3rem 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    Connect Claude to your Job Pulse data and tools in just a few seconds.
                  </p>
                </div>

                <div className="mcp-header-actions">
                  <button className="btn btn-secondary" onClick={copyClaudeConfig} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span className="material-symbols-outlined">content_copy</span> Copy Config
                  </button>
                  <button className="btn btn-secondary" onClick={downloadClaudeConfig} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span className="material-symbols-outlined">download</span> Download File
                  </button>
                </div>
              </div>

              {/* CLAUDE "ADD CUSTOM CONNECTOR" BOX (Matches Claude's popup UI) */}
              <div style={{ background: '#121620', border: '1px solid rgba(0, 119, 217, 0.35)', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <span className="material-symbols-outlined" style={{ color: 'var(--primary)', fontSize: '1.4rem' }}>add_link</span>
                    <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Add Custom Connector in Claude</h3>
                  </div>

                  {/* Connected & Disconnect Controls placed on top right of the container */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {mcpStatus.connected ? (
                      <>
                        <span className="badge" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.35)', padding: '0.4rem 0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem' }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>check_circle</span> Claude Desktop Connected
                        </span>
                        <button className="btn btn-secondary" onClick={disconnectClaude} style={{ fontSize: '0.75rem', padding: '0.4rem 0.75rem' }}>
                          Disconnect
                        </button>
                      </>
                    ) : (
                      <button 
                        className="btn" 
                        disabled={isConnectingMcp}
                        onClick={connectClaude} 
                        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', padding: '0.45rem 0.9rem' }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>{isConnectingMcp ? 'sync' : 'power'}</span>
                        {isConnectingMcp ? 'Connecting...' : '1-Click Connect Desktop'}
                      </button>
                    )}
                  </div>
                </div>

                <p style={{ margin: '0 0 1.25rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  In Claude, go to <b>Settings &gt; Connectors &gt; Add custom connector</b>. Copy the two fields below and click Continue:
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
                  {/* Field 1: Name */}
                  <div style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '0.75rem 1rem' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: '0.3rem' }}>
                      Name (Shown in Claude's connectors list)
                    </label>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <code style={{ fontSize: '1rem', color: 'var(--text-primary)', fontWeight: 600 }}>Job Pulse</code>
                      <button 
                        className="btn btn-secondary" 
                        style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                        onClick={() => {
                          navigator.clipboard.writeText('Job Pulse');
                          showToast('Copied connector Name: "Job Pulse"');
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '0.9rem' }}>content_copy</span> Copy Name
                      </button>
                    </div>
                  </div>

                  {/* Field 2: MCP Server URL */}
                  <div style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '0.75rem 1rem' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: '0.3rem' }}>
                      MCP Server URL
                    </label>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                      <code style={{ fontSize: '0.9rem', color: '#38bdf8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mcpUrl}</code>
                      <button 
                        className="btn" 
                        style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}
                        onClick={() => {
                          navigator.clipboard.writeText(mcpUrl);
                          showToast('Copied MCP Server URL: ' + mcpUrl);
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '0.9rem' }}>content_copy</span> Copy URL
                      </button>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: '#34d399', marginBottom: '0.5rem' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>check_circle</span>
                  <span>HTTP &amp; SSE server is active on <code>{mcpUrl}</code></span>
                </div>

                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: '1.5', background: 'rgba(0,0,0,0.2)', padding: '0.6rem 0.8rem', borderRadius: '6px' }}>
                  🌐 <b>Online Deployment:</b> When hosted on Render, Railway, Vercel, or custom domain, this URL automatically resolves to your secure production HTTPS endpoint (<code>https://&lt;your-domain&gt;/mcp</code>), which connects instantly with Claude.ai web and Claude Desktop!
                </div>
              </div>

              {/* Interactive Prompts Library for match scoring */}
              <div>
                <h3 style={{ margin: '0 0 0.85rem', fontSize: '1.05rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>psychology</span>
                  Claude Match &amp; Career Prompts (Click to Copy)
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                  {[
                    { title: 'Score All Jobs Against My Resume', prompt: 'Claude, evaluate my uploaded candidate resume against the jobs in my feed using the job-pulse MCP tools. Calculate match scores (0-100%) and use save_job_match to record them to my dashboard.' },
                    { title: 'Find Top 5 Matches for My Profile', prompt: 'Claude, look at my resume and identify the top 5 highest matching positions in my feed. Provide a tailored summary for each.' },
                    { title: 'Trigger Job Scan for Senior Roles', prompt: 'Claude, use trigger_job_scan to search LinkedIn and Adzuna for "Senior Full Stack Engineer" in "Remote" and score newly discovered jobs.' },
                    { title: 'Prepare Interview & Application Strategy', prompt: 'Claude, review my applied jobs and outline a customized interview talking-points plan based on my resume.' }
                  ].map(item => (
                    <div
                      key={item.title}
                      onClick={() => { navigator.clipboard.writeText(item.prompt); showToast(`Copied prompt: "${item.title}"`); }}
                      style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '0.75rem 1rem', background: 'var(--bg-input)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}
                    >
                      <div>
                        <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--primary)', display: 'block', marginBottom: '0.2rem' }}>{item.title}</span>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>"{item.prompt}"</div>
                      </div>
                      <button className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', flexShrink: 0 }}>
                        <span className="material-symbols-outlined" style={{ fontSize: '0.9rem' }}>content_copy</span> Copy
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 2. SETTINGS VIEW */}
      {activeTab === 'settings' && (
        <div className="settings-layout">
          <form className="glass-card" onSubmit={saveSettings}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
              <h2 style={{ fontWeight: 600, margin: 0 }}>Configuration</h2>
              <AutosaveIndicator status={autosaveStatus} />
            </div>

            <div className="form-group">
              <label className="form-label">Search Keywords</label>
              <textarea 
                className="form-textarea"
                placeholder="React, Node, Python, Developer"
                value={settings.keywords}
                onChange={e => setSettings({ ...settings, keywords: e.target.value })}
              />
              <p className="helper-text">
                Comma-separated list of keywords, matched against the job title only (not the description) so a search for "Product" won't pull in unrelated Developer/Manager roles that just happen to mention it in their description. Leave empty to allow all jobs.
              </p>
            </div>

            <div className="settings-grid settings-grid-3">
              <div className="form-group">
                <label className="form-label">Job Search Location</label>
                <input 
                  type="text" 
                  className="form-input"
                  placeholder="e.g. Austin, TX or Hyderabad, IN"
                  value={settings.location || ''}
                  onChange={e => setSettings({ ...settings, location: e.target.value })}
                />
                <p className="helper-text">Target city, region, or country.</p>
              </div>

              <div className="form-group">
                <label className="form-label">Work Arrangement</label>
                <select 
                  className="form-select"
                  value={settings.work_type || 'all'}
                  onChange={e => setSettings({ ...settings, work_type: e.target.value })}
                >
                  <option value="all">All Jobs (No filter)</option>
                  <option value="onsite">Onsite Only</option>
                  <option value="remote">Remote Only</option>
                  <option value="hybrid">Hybrid Only</option>
                </select>
                <p className="helper-text">Preference for office, remote, or hybrid arrangements.</p>
              </div>

              <div className="form-group">
                <label className="form-label">Experience Level</label>
                <select 
                  className="form-select"
                  value={settings.experience_level || 'all'}
                  onChange={e => setSettings({ ...settings, experience_level: e.target.value })}
                >
                  <option value="all">All Levels (No filter)</option>
                  <option value="entry">Entry Level</option>
                  <option value="mid_senior">Mid-Senior Level</option>
                  <option value="director">Director / Executive</option>
                </select>
                <p className="helper-text">Filter jobs by required experience.</p>
              </div>

              <div className="form-group">
                <label className="form-label">Date Posted</label>
                <select 
                  className="form-select"
                  value={settings.date_posted || '24h'}
                  onChange={e => setSettings({ ...settings, date_posted: e.target.value })}
                >
                  <option value="all">Any Time</option>
                  <option value="24h">Past 24 Hours</option>
                  <option value="week">Past Week</option>
                  <option value="month">Past Month</option>
                </select>
                <p className="helper-text">Only fetch jobs posted within this timeframe.</p>
              </div>
            </div>

            <div className="settings-grid settings-grid-2">
              <div className="form-group">
                <label className="form-label">Country Code (Adzuna API)</label>
                <select 
                  className="form-select"
                  value={settings.country_code || 'us'}
                  onChange={e => setSettings({ ...settings, country_code: e.target.value })}
                >
                  <option value="us">United States (us)</option>
                  <option value="in">India (in)</option>
                  <option value="gb">United Kingdom (gb)</option>
                  <option value="ca">Canada (ca)</option>
                  <option value="au">Australia (au)</option>
                  <option value="de">Germany (de)</option>
                  <option value="fr">France (fr)</option>
                  <option value="it">Italy (it)</option>
                </select>
                <p className="helper-text">Used to specify country parameters for Adzuna API checks.</p>
              </div>

              <div className="form-group">
                <label className="form-label">Background Scan Interval</label>
                <select 
                  className="form-select"
                  value={settings.scrape_interval_mins}
                  onChange={e => setSettings({ ...settings, scrape_interval_mins: e.target.value })}
                >
                  <option value="1">Every 1 Minute (For testing)</option>
                  <option value="5">Every 5 Minutes</option>
                  <option value="10">Every 10 Minutes (Recommended)</option>
                  <option value="30">Every 30 Minutes</option>
                  <option value="60">Every 1 Hour</option>
                </select>
                <p className="helper-text">Scraping frequency interval in minutes.</p>
              </div>
            </div>

            <div className="form-group">
              <label className="checkbox-label" style={{ fontSize: '1rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                <input 
                  type="checkbox" 
                  checked={settings.scrape_active === '1'} 
                  onChange={e => setSettings({ ...settings, scrape_active: e.target.checked ? '1' : '0' })}
                />
                Enable Background Scanning Service
              </label>
              <p className="helper-text" style={{ marginLeft: '1.25rem' }}>
                Toggles the background timer loop on and off.
              </p>
            </div>

            <div className="form-group">
              <label className="form-label">Job Search Sources</label>
              <p className="helper-text" style={{ marginBottom: '0.75rem' }}>
                Sources marked <span className="source-warning-badge" style={{ display: 'inline-flex' }}><span className="material-symbols-outlined" style={{ fontSize: '0.9rem' }}>warning</span> Unreliable</span> scrape the platform's public site directly and are frequently blocked by anti-bot/CAPTCHA protection — expect inconsistent or zero results. For guaranteed results from Indeed, Glassdoor, LinkedIn and Reed, enable <strong>Adzuna API</strong> below instead.
              </p>
              <div className="sources-grid">
                {[
                  { id: 'linkedin', label: 'LinkedIn (Public guest search)' },
                  { id: 'adzuna', label: 'Adzuna API (Indeed, Glassdoor, LinkedIn, Reed)' },
                  { id: 'hackernews', label: 'Hacker News (YC startup jobs)' },
                  { id: 'weworkremotely', label: 'We Work Remotely (Remote only)' },
                  { id: 'remoteok', label: 'RemoteOK (Remote only)' },
                  { id: 'dice', label: 'Dice (Public search)' },
                  { id: 'naukri', label: 'Naukri (Public search)' },
                  { id: 'simplyhired', label: 'SimplyHired (Public search)' },
                  { id: 'indeed', label: 'Indeed (Public search)' },
                  { id: 'glassdoor', label: 'Glassdoor (Public search)' },
                  { id: 'google', label: 'Google Search (Job leads, Beta)' },
                ].map(src => {
                  const unreliable = UNRELIABLE_SOURCES.has(src.id);
                  return (
                    <div
                      key={src.id}
                      className={`source-checkbox-card ${isSourceEnabled(src.id) ? 'checked' : ''} ${unreliable ? 'has-warning' : ''}`}
                      onClick={() => handleSourceChange(src.id, !isSourceEnabled(src.id))}
                    >
                      <input
                        type="checkbox"
                        checked={isSourceEnabled(src.id)}
                        onChange={() => {}}
                      />
                      <div>
                        <span>{src.label}</span>
                        {unreliable && (
                          <div className="source-warning-badge">
                            <span className="material-symbols-outlined" style={{ fontSize: '0.9rem' }}>warning</span>
                            May be blocked (anti-bot protection)
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--border-color)', margin: '2rem 0', paddingTop: '1.5rem' }}>
              <h3 style={{ marginBottom: '1rem', fontSize: '1.1rem', fontWeight: 600 }}>Phone Push Notifications Setup</h3>
              
              <div className="form-group">
                <label className="form-label">Telegram Bot Token</label>
                <input 
                  type="password" 
                  className="form-input"
                  placeholder="e.g. 1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                  value={settings.telegram_bot_token}
                  onChange={e => setSettings({ ...settings, telegram_bot_token: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Telegram Chat ID</label>
                <input 
                  type="text" 
                  className="form-input"
                  placeholder="e.g. 987654321"
                  value={settings.telegram_chat_id}
                  onChange={e => setSettings({ ...settings, telegram_chat_id: e.target.value })}
                />
                <p className="helper-text">
                  Enter your Telegram Bot Token and Chat ID to get instant job alerts on your phone.
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Discord Webhook URL (Alternative)</label>
                <input 
                  type="password" 
                  className="form-input"
                  placeholder="https://discord.com/api/webhooks/..."
                  value={settings.discord_webhook_url}
                  onChange={e => setSettings({ ...settings, discord_webhook_url: e.target.value })}
                />
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--border-color)', margin: '2rem 0', paddingTop: '1.5rem' }}>
              <h3 style={{ marginBottom: '1rem', fontSize: '1.1rem', fontWeight: 600 }}>Adzuna API Credentials (Optional)</h3>
              <p className="helper-text" style={{ marginBottom: '1rem' }}>
                Used to aggregate jobs from Glassdoor, Indeed, Reed, and LinkedIn. Get your free App ID & Key at <a href="https://developer.adzuna.com/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)' }}>developer.adzuna.com</a>.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Adzuna App ID</label>
                  <input 
                    type="text" 
                    className="form-input"
                    placeholder="e.g. ab12cd34"
                    value={settings.adzuna_app_id || ''}
                    onChange={e => setSettings({ ...settings, adzuna_app_id: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Adzuna App Key</label>
                  <input 
                    type="password" 
                    className="form-input"
                    placeholder="e.g. 9876543210abcdef9876543210abcdef"
                    value={settings.adzuna_app_key || ''}
                    onChange={e => setSettings({ ...settings, adzuna_app_key: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', marginTop: '2rem' }}>
              <button 
                type="submit" 
                className="btn"
                disabled={isSavingSettings}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '1.2rem' }}>save</span>
                {isSavingSettings ? 'Saving...' : 'Save Settings'}
              </button>
              <button 
                type="button" 
                className="btn btn-secondary"
                disabled={isTestingNotify}
                onClick={testNotification}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '1.2rem' }}>notifications_active</span>
                {isTestingNotify ? 'Testing...' : 'Send Test Notification'}
              </button>
            </div>
          </form>

          {/* Settings Sidebar: right-hand job preference panel */}
          <div className="settings-sidebar">
            <div className="glass-card" style={{ border: '1px solid rgba(253, 214, 99, 0.3)', background: 'rgba(253, 214, 99, 0.06)' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', fontSize: '1.05rem', fontWeight: 600 }}>
                <span className="material-symbols-outlined" style={{ color: 'var(--warning)' }}>warning</span>
                Platform Reliability
              </h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '0.75rem' }}>
                <b>Glassdoor, Indeed, Naukri, Dice, SimplyHired</b> and <b>Google Search</b> are scraped directly from their public pages. These platforms actively detect and block automated traffic (CAPTCHA / 403 / 429 errors), so results from them can be inconsistent — including zero jobs on some runs. This is expected behavior, not a bug.
              </p>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                For dependable coverage of Glassdoor, Indeed, LinkedIn and Reed listings, enable the <b>Adzuna API</b> source with your free API key below — it's the most reliable option. Check the <b>Logs</b> tab any time to see exactly why a platform returned 0 jobs.
              </p>
            </div>

            <div className="glass-card">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', fontSize: '1.05rem', fontWeight: 600 }}>
                <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>send_to_mobile</span>
                Telegram Setup Guide
              </h3>
              <ol style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', paddingLeft: '1.25rem', lineHeight: '1.6' }}>
                <li style={{ marginBottom: '0.5rem' }}>
                  Search for <b>@BotFather</b> on Telegram and message <code>/newbot</code>.
                </li>
                <li style={{ marginBottom: '0.5rem' }}>
                  Follow the steps to name your bot and copy the generated <b>Bot Token</b> into the settings field.
                </li>
                <li style={{ marginBottom: '0.5rem' }}>
                  Click your bot's link to open a chat and click <b>Start</b>.
                </li>
                <li style={{ marginBottom: '0.5rem' }}>
                  Search for <b>@userinfobot</b> on Telegram, start it, and it will immediately reply with your <b>Id</b>. Copy this into the <b>Chat ID</b> field.
                </li>
                <li>
                  Click <b>Send Test Notification</b> to verify that the setup works!
                </li>
              </ol>
            </div>

            <div className="glass-card">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', fontSize: '1.05rem', fontWeight: 600 }}>
                <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>sports_esports</span>
                Discord Setup Guide
              </h3>
              <ol style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', paddingLeft: '1.25rem', lineHeight: '1.6' }}>
                <li style={{ marginBottom: '0.5rem' }}>
                  Open your Discord Server settings and go to <b>Integrations</b> &gt; <b>Webhooks</b>.
                </li>
                <li style={{ marginBottom: '0.5rem' }}>
                  Create a new Webhook, select the channel, and copy the <b>Webhook URL</b>.
                </li>
                <li>
                  Paste it in the settings, configure, and send a test!
                </li>
              </ol>
            </div>

            {/* Browser Extension Token Card */}
            <div className="glass-card" style={{ border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.06)' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', fontSize: '1.05rem', fontWeight: 600 }}>
                <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>extension</span>
                Browser Extension Token
              </h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '0.85rem', lineHeight: 1.5 }}>
                Use this token to connect the <b>Job Notifier Chrome Extension</b> to your account. Paste it in the extension popup.
              </p>
              <div style={{
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid rgba(99,102,241,0.25)',
                borderRadius: '8px',
                padding: '0.6rem 0.85rem',
                fontFamily: 'monospace',
                fontSize: '0.72rem',
                color: 'var(--text-secondary)',
                wordBreak: 'break-all',
                marginBottom: '0.75rem',
                minHeight: '2.5rem',
                display: 'flex',
                alignItems: 'center'
              }}>
                {token ? `${token.substring(0, 40)}…` : 'Not logged in'}
              </div>
              <button
                type="button"
                className="btn"
                style={{ width: '100%', fontSize: '0.85rem', justifyContent: 'center' }}
                onClick={() => {
                  const t = localStorage.getItem('jp_token') || '';
                  if (!t) {
                    setToast({ message: 'No token found. Please log in first.', show: true });
                    setTimeout(() => setToast(p => ({ ...p, show: false })), 3000);
                    return;
                  }
                  navigator.clipboard.writeText(t).then(() => {
                    setToast({ message: '✅ Token copied! Paste it in the extension popup.', show: true });
                    setTimeout(() => setToast(p => ({ ...p, show: false })), 3000);
                  }).catch(() => {
                    setToast({ message: 'Copy failed — please select and copy the token manually.', show: true });
                    setTimeout(() => setToast(p => ({ ...p, show: false })), 3000);
                  });
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '1.1rem' }}>content_copy</span>
                Copy Token to Clipboard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. LOGS VIEW */}
      {activeTab === 'logs' && (
        <div className="glass-card full-page-card" style={{ width: '100%' }}>
          <div className="logs-header">
            <div>
              <h2 style={{ fontWeight: 600, margin: 0, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span className="material-symbols-outlined">receipt_long</span>
                System Activity Logs
              </h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.3rem 0 0' }}>
                Track background scraper events and potential network issues.
              </p>
            </div>
            <div className="logs-header-actions">
              <button className="btn btn-secondary" onClick={fetchLogs}>
                <span className="material-symbols-outlined">sync</span> Refresh Logs
              </button>
              <button className="btn btn-danger" onClick={clearSystemLogs}>
                <span className="material-symbols-outlined">delete</span> Clear Logs
              </button>
            </div>
          </div>

          {logs.length === 0 ? (
            <div className="empty-state">
              <span className="material-symbols-outlined empty-state-icon">article</span>
              <h3 style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>No Activity Logs</h3>
              <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.9rem', maxWidth: '420px' }}>
                The log database is currently empty. Run a scan from the Job Feed to generate activity.
              </p>
            </div>
          ) : (
            <>
              {/* Error/Warning/Info stat tiles for this log window */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
                {[
                  { label: 'Total Entries', value: logStats.total, icon: 'article', color: 'var(--primary)' },
                  { label: 'Errors', value: logStats.errors, icon: 'error', color: 'var(--danger)' },
                  { label: 'Warnings', value: logStats.warnings, icon: 'warning', color: 'var(--warning)' },
                  { label: 'Info', value: logStats.infos, icon: 'info', color: 'var(--info)' },
                ].map(tile => (
                  <div key={tile.label} className="glass-card" style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '1.6rem', color: tile.color }}>{tile.icon}</span>
                    <div>
                      <div style={{ fontSize: '1.4rem', fontWeight: 700, color: tile.color, lineHeight: 1 }}>{tile.value}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{tile.label}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Per-platform status from the most recent scan */}
              {logStats.platforms.length > 0 ? (
                <div className="glass-card" style={{ marginBottom: '1.5rem' }}>
                  <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '1.1rem', color: 'var(--primary)' }}>monitor_heart</span>
                    Last Scan — Platform Status
                  </h3>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.85rem' }}>
                    {logStats.latestAt ? new Date(logStats.latestAt).toLocaleString() : ''}
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {logStats.platforms.map(p => (
                      <span
                        key={p.name}
                        className="badge"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                          border: `1px solid ${p.ok ? 'rgba(129, 201, 149, 0.4)' : 'rgba(242, 139, 130, 0.4)'}`,
                          color: p.ok ? 'var(--success)' : 'var(--danger)',
                          background: p.ok ? 'rgba(129, 201, 149, 0.08)' : 'rgba(242, 139, 130, 0.08)'
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '0.9rem' }}>{p.ok ? 'check_circle' : 'error'}</span>
                        {p.name}: {p.count}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="glass-card empty-state" style={{ marginBottom: '1.5rem', padding: '1.25rem' }}>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
                    No scan has completed in this log window yet — run "Scan Jobs Now" from the Job Feed to see a per-platform status breakdown here.
                  </p>
                </div>
              )}

            <div className="log-table-container">
              <table className="log-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Level</th>
                    <th>Event Message</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map(log => (
                    <tr key={log.id} className="log-row">
                      <td style={{ width: '180px' }}>
                        {new Date(log.timestamp).toLocaleString()}
                      </td>
                      <td style={{ width: '100px' }}>
                        <span className={`log-level ${log.level}`}>{log.level}</span>
                      </td>
                      <td>{log.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      )}



      {/* 5. ADMIN VIEW */}
      {activeTab === 'admin' && isAdmin && (
        <div className="glass-card">
          <div className="logs-header" style={{ marginBottom: '1.5rem' }}>
            <div>
              <h2 style={{ fontWeight: 600, color: 'var(--primary)' }}>Admin Dashboard</h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                System User Analytics & Comprehensive User Directory ({adminUsers.length} Total Users Registered)
              </p>
            </div>
            <button className="btn btn-secondary" onClick={fetchAdminUsers}>
              <span className="material-symbols-outlined">sync</span> Refresh
            </button>
          </div>

          {/* My Admin Account — the logged-in admin's own details, front and center */}
          {(() => {
            const me = adminUsers.find(u => u.id === userId);
            return (
              <div className="glass-card" style={{ marginBottom: '1.5rem', border: '1px solid var(--primary)', display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap' }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                  {username.charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: '220px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <strong style={{ fontSize: '1.05rem' }}>{username}</strong>
                    <span style={{ fontSize: '0.65rem', background: 'var(--primary)', color: '#fff', borderRadius: '4px', padding: '1px 6px' }}>ADMIN</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                    Account ID #{userId} {me?.created_at ? `· Joined ${new Date(me.created_at).toLocaleDateString()}` : ''} {me?.last_login_at ? `· Last login ${new Date(me.last_login_at).toLocaleString()}` : ''}
                  </div>
                </div>
                {me && (
                  <div style={{ display: 'flex', gap: '1.5rem', textAlign: 'center' }}>
                    <div>
                      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--primary)' }}>{parseInt(me.job_count, 10) || 0}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Jobs Tracked</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--primary)' }}>{me.location || '—'}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Location</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: me.background_scan ? '#4ade80' : 'var(--text-muted)' }}>{me.background_scan ? 'ON' : 'OFF'}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Scanner</div>
                    </div>
                  </div>
                )}
                <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => setActiveTab('settings')}>
                  <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>settings</span> Edit My Preferences
                </button>
              </div>
            );
          })()}

          {adminUsers.length === 0 ? (
            <div className="empty-state">
              <span className="material-symbols-outlined" style={{ fontSize: '3rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>group_off</span>
              <h3>No Users Yet</h3>
              <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', fontSize: '0.9rem' }}>
                No one has registered an account yet. Click Refresh once someone signs up.
              </p>
            </div>
          ) : (
          <div className="log-table-container">
            {/* Stat Cards */}
            {(() => {
              const total = adminUsers.length;
              const active = adminUsers.filter(u => u.is_active).length;
              const inactive = total - active;
              const totalJobsSum = adminUsers.reduce((sum, u) => sum + (parseInt(u.job_count, 10) || 0), 0);
              return (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
                  {[
                    { label: 'Total Users', value: total, icon: 'group', color: 'var(--primary)', filter: 'all' },
                    { label: 'Active (7d)', value: active, icon: 'person_check', color: '#4ade80', filter: 'active' },
                    { label: 'Inactive', value: inactive, icon: 'person_off', color: 'var(--text-muted)', filter: 'inactive' },
                    { label: 'Total Jobs Tracked', value: totalJobsSum, icon: 'work_history', color: '#38bdf8', filter: 'jobs' }
                  ].map(card => (
                    <div
                      key={card.filter}
                      className="glass-card"
                      onClick={() => {
                        if (card.filter !== 'jobs') {
                          setAdminActiveFilter((adminActiveFilter === card.filter ? 'all' : card.filter) as any);
                        }
                      }}
                      style={{ cursor: card.filter !== 'jobs' ? 'pointer' : 'default', padding: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem', border: adminActiveFilter === card.filter ? `1.5px solid ${card.color}` : '1px solid var(--border-color)', transition: 'all 0.2s' }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '2rem', color: card.color }}>{card.icon}</span>
                      <div>
                        <div style={{ fontSize: '1.75rem', fontWeight: 700, color: card.color, lineHeight: 1 }}>{card.value}</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>{card.label}</div>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            <table className="log-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Username</th>
                  <th>Status</th>
                  <th>Registered</th>
                  <th>Last Login</th>
                  <th>Jobs</th>
                  <th>Keywords</th>
                  <th>Location</th>
                  <th>Scanner</th>
                  <th>Logs</th>
                </tr>
              </thead>
              <tbody>
                {adminUsers.filter(u => adminActiveFilter === 'all' || (adminActiveFilter === 'active' ? u.is_active : !u.is_active)).length === 0 && (
                  <tr>
                    <td colSpan={10} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                      No {adminActiveFilter === 'active' ? 'active' : 'inactive'} users match this filter.
                    </td>
                  </tr>
                )}
                {adminUsers
                  .filter(u => adminActiveFilter === 'all' || (adminActiveFilter === 'active' ? u.is_active : !u.is_active))
                  .map(u => (
                    <tr key={u.id} className="log-row" style={{ opacity: u.is_active ? 1 : 0.65 }}>
                      <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>#{u.id}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: u.is_active ? 'var(--primary)' : 'var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                            {u.username.charAt(0).toUpperCase()}
                          </div>
                          <strong>{u.username}</strong>
                          {u.is_admin && <span style={{ fontSize: '0.65rem', background: 'var(--primary)', color: '#fff', borderRadius: '4px', padding: '1px 5px', marginLeft: '2px' }}>ADMIN</span>}
                        </div>
                      </td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', fontWeight: 600, color: u.is_active ? '#4ade80' : 'var(--text-muted)' }}>
                          <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: u.is_active ? '#4ade80' : 'var(--text-muted)', display: 'inline-block' }} />
                          {u.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td style={{ fontSize: '0.82rem' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                      <td style={{ fontSize: '0.82rem', color: u.last_login_at ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                        {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}
                      </td>
                      <td style={{ fontSize: '0.85rem', fontWeight: 600, textAlign: 'center' }}>{parseInt(u.job_count, 10) || 0}</td>
                      <td style={{ fontSize: '0.8rem', maxWidth: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.keywords || '—'}</td>
                      <td style={{ fontSize: '0.8rem' }}>{u.location || '—'}</td>
                      <td>
                        <span className={`badge ${u.background_scan ? 'badge-applied' : ''}`} style={{ fontSize: '0.7rem' }}>
                          {u.background_scan ? '● ON' : '○ OFF'}
                        </span>
                      </td>
                      <td>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', ...(adminSelectedUser?.id === u.id ? { background: 'var(--primary)', color: '#fff' } : {}) }}
                          onClick={() => {
                            if (adminSelectedUser?.id === u.id) {
                              setAdminSelectedUser(null);
                              setAdminUserLogs([]);
                            } else {
                              setAdminSelectedUser(u);
                              fetchAdminUserLogs(u.id);
                            }
                          }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>receipt_long</span>
                          {adminSelectedUser?.id === u.id ? 'Hide' : 'Logs'}
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          )}

          {/* Per-User Logs Drawer */}
          {adminSelectedUser && (
            <div className="glass-card" style={{ marginTop: '1.5rem', border: '1px solid var(--primary)' }}>
              <div className="logs-header" style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>receipt_long</span>
                  <div>
                    <h3 style={{ fontWeight: 600, margin: 0 }}>Logs — <span style={{ color: 'var(--primary)' }}>{adminSelectedUser.username}</span></h3>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>Last 150 entries</p>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => fetchAdminUserLogs(adminSelectedUser.id)}>
                    <span className="material-symbols-outlined">sync</span> Refresh
                  </button>
                  <button className="btn btn-secondary" style={{ fontSize: '0.8rem', color: 'var(--danger)' }} onClick={() => { setAdminSelectedUser(null); setAdminUserLogs([]); }}>
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              </div>
              {adminLogsLoading ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '2rem' }}>sync</span>
                  <p style={{ marginTop: '0.5rem' }}>Loading logs...</p>
                </div>
              ) : adminUserLogs.length === 0 ? (
                <div className="empty-state">
                  <span className="material-symbols-outlined" style={{ fontSize: '2.5rem', color: 'var(--text-muted)' }}>article</span>
                  <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>No logs for this user.</p>
                </div>
              ) : (
                <div className="log-table-container" style={{ maxHeight: '350px', overflowY: 'auto' }}>
                  <table className="log-table">
                    <thead><tr><th>Timestamp</th><th>Level</th><th>Message</th></tr></thead>
                    <tbody>
                      {adminUserLogs.map(log => (
                        <tr key={log.id} className="log-row">
                          <td style={{ width: '175px', fontSize: '0.8rem' }}>{new Date(log.timestamp).toLocaleString()}</td>
                          <td style={{ width: '90px' }}><span className={`log-level ${log.level}`}>{log.level}</span></td>
                          <td style={{ fontSize: '0.85rem' }}>{log.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}



      
        </div> {/* End chat-content-centered */}
      </main>
    </div>
  );
}
