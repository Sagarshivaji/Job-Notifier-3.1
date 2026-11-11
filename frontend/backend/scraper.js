import Parser from 'rss-parser';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import * as cheerio from 'cheerio';
import { getSettings, addJob, markJobAsNotified, addLog, get, normalizeEnabledSources } from './db.js';
import { sendJobNotification } from './notifier.js';

// Apply retry logic to all axios requests
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status >= 500;
  }
});

// RSS parser
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/rss+xml, application/atom+xml, text/xml;q=0.9'
  }
});

// Reliable RSS sources
const SOURCE_FEEDS = {
  weworkremotely: {
    name: 'We Work Remotely',
    url: 'https://weworkremotely.com/remote-jobs.rss'
  },
  remoteok: {
    name: 'RemoteOK',
    url: 'https://remoteok.com/remote-jobs.rss'
  },
  workingnomads: {
    name: 'Working Nomads',
    url: 'https://www.workingnomads.com/jobsfeed'
  }
};

// Sources that now go through SerpApi (reliable)
const SERPAPI_SOURCES = {
  linkedin: {
    name: 'LinkedIn',
    engine: 'linkedin_jobs',
  },
  dice: {
    name: 'Dice',
    engine: 'google_jobs',
    filterSite: 'dice.com'
  },
  naukri: {
    name: 'Naukri',
    engine: 'google_jobs',
    filterSite: 'naukri.com'
  },
  simplyhired: {
    name: 'SimplyHired',
    engine: 'google_jobs',
    filterSite: 'simplyhired.com'
  },
  // Add indeed/glassdoor if you want, they need SerpApi too
  // indeed: { name: 'Indeed', engine: 'google_jobs', filterSite: 'indeed.com' },
  // glassdoor: { name: 'Glassdoor', engine: 'google_jobs', filterSite: 'glassdoor.com' }
};

// Main scrape function (single‑user, no userId)
export async function scrapeJobs(isManual = false) {
  await addLog('INFO', `Starting job sync (${isManual ? 'Manual' : 'Scheduled'})...`);

  try {
    const settings = await getSettings();
    if (settings.scrape_active !== '1' && !isManual) {
      await addLog('INFO', 'Scraper is currently disabled. Skipping.');
      return;
    }

    const location = settings.location || 'United States';
    const countryCode = settings.country_code || 'us';
    const workType = settings.work_type || 'all';
    const adzunaAppId = settings.adzuna_app_id || '';
    const adzunaAppKey = settings.adzuna_app_key || '';

    // 1. Get enabled sources
    let enabledSources = [];
    try {
      enabledSources = normalizeEnabledSources(settings.enabled_sources || '[]');
    } catch (e) {
      enabledSources = normalizeEnabledSources(['linkedin', 'weworkremotely']);
    }

    // 2. Parse keywords
    const keywords = (settings.keywords || '')
      .split(/,|\n/)
      .map(k => k.trim())
      .filter(k => k.length > 0);

    const searchQuery = keywords.join(' ') || 'developer'; // fallback for SerpApi

    // Log compiled query for debugging
    const broadQuery = generateBroadSearchQuery(keywords);
    await addLog('INFO', `Keywords: [${keywords.join(', ') || 'none'}], Location: "${location}", Work Type: "${workType}"`);
    if (broadQuery) await addLog('INFO', `Compiled query: "${broadQuery}"`);

    // Check if db is empty (first run)
    const countRow = await get('SELECT COUNT(*) as count FROM jobs');
    const isFirstRun = countRow.count === 0;
    if (isFirstRun) {
      await addLog('WARNING', 'First‑run mode: indexing jobs without sending alerts.');
    }

    let fetchedJobs = [];

    // 3. Loop through each active source
    for (const sourceId of enabledSources) {
      // ---- RSS feeds ----
      if (SOURCE_FEEDS[sourceId]) {
        if (workType === 'onsite') {
          await addLog('INFO', `Skipping remote feed "${sourceId}" because work type is "onsite".`);
          continue;
        }
        await addLog('INFO', `Fetching RSS: ${SOURCE_FEEDS[sourceId].name}`);
        const rssJobs = await scrapeRSSFeed(sourceId, keywords);
        fetchedJobs.push(...rssJobs);
        continue;
      }

      // ---- Adzuna API ----
      if (sourceId === 'adzuna') {
        if (!adzunaAppId || !adzunaAppKey) {
          await addLog('WARNING', 'Adzuna credentials missing. Skipping.');
          continue;
        }
        await addLog('INFO', 'Fetching Adzuna API jobs...');
        const adzJobs = await fetchAdzunaJobs(searchQuery, location, countryCode, adzunaAppId, adzunaAppKey);
        fetchedJobs.push(...adzJobs);
        continue;
      }

      // ---- SerpApi sources (LinkedIn, Dice, Naukri, SimplyHired) ----
      if (SERPAPI_SOURCES[sourceId]) {
        const apiKey = process.env.SERPAPI_KEY;
        if (!apiKey) {
          await addLog('WARNING', `SerpApi key missing. Skipping ${SERPAPI_SOURCES[sourceId].name}. Get one at serpapi.com.`);
          continue;
        }
        await addLog('INFO', `Fetching via SerpApi: ${SERPAPI_SOURCES[sourceId].name}`);
        const serpJobs = await fetchSerpApiJobs(sourceId, searchQuery, location, workType, apiKey);
        fetchedJobs.push(...serpJobs);
        continue;
      }

      // ---- Fallback: legacy HTML scrapers (likely broken) ----
      if (SEARCH_SOURCES[sourceId]) {
        await addLog('WARNING', `${sourceId} is using old HTML scraper – it may not work. Consider SerpApi.`);
        const legacyJobs = await SEARCH_SOURCES[sourceId].fetch(searchQuery, location);
        fetchedJobs.push(...legacyJobs);
      }
    }

    // 4. Process, filter & save jobs
    let totalAdded = 0;
    let totalNotified = 0;

    for (const job of fetchedJobs) {
      if (!filterByWorkType(job, workType)) continue;
      if (!checkKeywords(job.title, job.description, keywords)) continue;

      const added = await addJob(job);
      if (added) {
        totalAdded++;
        if (isFirstRun) {
          await markJobAsNotified(job.id);
        } else {
          await sendJobNotification(job, settings);
          await markJobAsNotified(job.id);
          totalNotified++;
        }
      }
    }

    await addLog('INFO', `Sync complete. ${totalAdded} new jobs added, ${totalNotified} notifications sent.`);
  } catch (err) {
    await addLog('ERROR', `Scrape failed: ${err.message}`);
    console.error(err);
  }
}

// -------------------------------------------------
// SerpApi helper (handles LinkedIn, Dice, Naukri, SimplyHired)
// -------------------------------------------------
async function fetchSerpApiJobs(sourceId, query, location, workType, apiKey) {
  const config = SERPAPI_SOURCES[sourceId];
  if (!config) return [];

  const jobs = [];
  try {
    let params = {
      api_key: apiKey,
      engine: config.engine,
    };

    if (config.engine === 'linkedin_jobs') {
      params = {
        ...params,
        keywords: query,
        location: location,
        f_WT: workType === 'remote' ? '2' : workType === 'hybrid' ? '3' : '',
        start: 0,
      };
    } else {
      // Google Jobs engine
      params.q = `${query} site:${config.filterSite}`;
      if (workType === 'remote') {
        params.q += ' remote';
      } else if (workType === 'onsite') {
        params.q += ' -remote -hybrid';
      } else if (workType === 'hybrid') {
        params.q += ' hybrid';
      }
      params.location = location;
    }

    const response = await axios.get('https://serpapi.com/search', { params, timeout: 15000 });
    const results = response.data?.jobs_results || response.data?.jobs_results || [];

    results.forEach(item => {
      const job = {
        id: `serp_${sourceId}_${item.job_id || item.id || generateJobId(item.link || item.title)}`,
        title: item.title,
        company: item.company_name || item.company || 'Unknown',
        url: item.link || item.related_links?.[0]?.link || '',
        source: config.name,
        description: item.description || item.snippet || '',
        salary: item.salary || '',
        location: item.location || ''
      };
      jobs.push(job);
    });

    await addLog('INFO', `SerpApi (${config.name}) returned ${jobs.length} jobs.`);
  } catch (err) {
    await addLog('ERROR', `SerpApi (${config.name}) failed: ${err.message}`);
  }
  return jobs;
}

// -------------------------------------------------
// Adzuna (unchanged, but with retry enabled globally)
// -------------------------------------------------
async function fetchAdzunaJobs(keywords, location, countryCode, appId, appKey) {
  const jobs = [];
  if (!appId || !appKey) {
    await addLog('WARNING', 'Adzuna API credentials missing.');
    return jobs;
  }

  try {
    const country = (countryCode || 'us').toLowerCase();
    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1`;
    const response = await axios.get(url, {
      params: {
        app_id: appId,
        app_key: appKey,
        results_per_page: 30,
        what: keywords,
        where: location,
        max_days_old: 1
      },
      timeout: 10000
    });

    if (response.data?.results) {
      response.data.results.forEach(item => {
        jobs.push({
          id: 'adz_' + (item.id || generateJobId(item.redirect_url)),
          title: (item.title || '').replace(/<\/?[^>]+(>|$)/g, ''),
          company: item.company?.display_name || 'Adzuna Employer',
          url: item.redirect_url || '',
          source: 'Adzuna',
          description: (item.description || '').replace(/<\/?[^>]+(>|$)/g, ''),
          salary: item.salary_min ? `$${Math.round(item.salary_min).toLocaleString()} - $${Math.round(item.salary_max).toLocaleString()}` : '',
          location: item.location?.display_name || ''
        });
      });
      await addLog('INFO', `Adzuna returned ${jobs.length} jobs.`);
    }
  } catch (err) {
    await addLog('ERROR', `Adzuna failed: ${err.message}`);
  }
  return jobs;
}

// -------------------------------------------------
// RSS scraper (unchanged)
// -------------------------------------------------
async function scrapeRSSFeed(sourceId, keywords) {
  const jobs = [];
  const feedConfig = SOURCE_FEEDS[sourceId];
  if (!feedConfig) return jobs;

  try {
    const feed = await parser.parseURL(feedConfig.url);
    for (const item of feed.items) {
      const title = item.title || '';
      const description = item.content || item.contentSnippet || '';
      const url = item.link || item.guid || '';
      
      let company = item.creator || '';
      if (!company && sourceId === 'weworkremotely') {
        const parts = title.split(':');
        if (parts.length > 1) company = parts[0].trim();
      } else if (!company && sourceId === 'remoteok') {
        const parts = title.split(' at ');
        if (parts.length > 1) company = parts[parts.length - 1].trim();
      }

      let displayTitle = title;
      if (sourceId === 'weworkremotely' && title.includes(':')) {
        displayTitle = title.substring(title.indexOf(':') + 1).trim();
      }

      if (!checkKeywords(displayTitle, description, keywords)) continue;

      jobs.push({
        id: generateJobId(url),
        title: displayTitle,
        company: company || 'Remote Company',
        url,
        source: feedConfig.name,
        description: description.substring(0, 1000),
        salary: extractSalary(title + ' ' + description),
        location: extractLocation(item)
      });
    }
  } catch (err) {
    await addLog('ERROR', `RSS ${feedConfig.name} failed: ${err.message}`);
  }
  return jobs;
}

// -------------------------------------------------
// Legacy HTML scrapers (keep for backward compat, but will likely fail)
// -------------------------------------------------
const SEARCH_SOURCES = {
  dice: { name: 'Dice', fetch: fetchDiceJobs },
  naukri: { name: 'Naukri', fetch: fetchNaukriJobs },
  simplyhired: { name: 'SimplyHired', fetch: fetchSimplyHiredJobs }
};

async function fetchDiceJobs(keywords, location) {
  return fetchGenericSearchJobs('dice', keywords, location);
}
async function fetchNaukriJobs(keywords, location) {
  return fetchGenericSearchJobs('naukri', keywords, location);
}
async function fetchSimplyHiredJobs(keywords, location) {
  return fetchGenericSearchJobs('simplyhired', keywords, location);
}

async function fetchGenericSearchJobs(sourceId, keywords, location) {
  const searchUrl = buildPlatformSearchUrl(sourceId, keywords, location);
  if (!searchUrl) return [];

  const jobs = [];
  const seenUrls = new Set();
  try {
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    const cards = $('li, .card, .job-card, .job-result, .result, article').filter((_, el) => {
      const text = $(el).text().trim();
      const anchors = $(el).find('a[href]').length;
      return text.length > 0 && anchors > 0;
    });

    cards.each((_, el) => {
      const anchor = $(el).find('a[href]').filter((_, a) => {
        const href = $(a).attr('href') || '';
        return href.includes('/jobs/') || href.includes('/job/') || href.includes('/jobsearch');
      }).first();

      const title = (anchor.text() || $(el).find('h2, h3, h4').first().text() || '').trim();
      const rawUrl = anchor.attr('href') || '';
      const company = $(el).find('.company, .employer, .org, .companyName').first().text().trim() || 'Unknown';
      const locationText = $(el).find('.location, .job-location').first().text().trim() || '';
      const description = $(el).find('.description, .summary, .snippet').first().text().trim() || '';

      if (!title || !rawUrl) return;

      const url = rawUrl.startsWith('http') ? rawUrl : `https://${sourceId}.com${rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl}`;
      if (seenUrls.has(url)) return;
      seenUrls.add(url);

      jobs.push({
        id: `${sourceId}_${generateJobId(url)}`,
        title,
        company,
        url,
        source: SEARCH_SOURCES[sourceId].name,
        description: description || `Job listed on ${SEARCH_SOURCES[sourceId].name}.`,
        salary: '',
        location: locationText || location
      });
    });

    await addLog('INFO', `${SEARCH_SOURCES[sourceId].name} returned ${jobs.length} jobs.`);
  } catch (err) {
    await addLog('ERROR', `${SEARCH_SOURCES[sourceId].name} failed: ${err.message}`);
  }
  return jobs;
}

// -------------------------------------------------
// All your helper functions (unchanged below)
// -------------------------------------------------

// Keep these exactly as they are:
// filterByWorkType, checkKeywords, extractLocation, extractSalary, generateJobId, generateBroadSearchQuery, buildPlatformSearchUrl
// (I'm omitting them for brevity – just copy them from your current file; they are already correct.)