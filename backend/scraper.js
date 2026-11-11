import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { getSettings, updateSetting, addJob, markJobAsNotified, addLog, get, normalizeEnabledSources } from './db.js';
import { sendJobNotification, sendSearchNotification } from './notifier.js';

// RSS parser Setup
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/rdf+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.8'
  }
});

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
  },
  jobspresso: {
    name: 'Jobspresso',
    url: 'https://jobspresso.co/feed/'
  }
};

const SEARCH_SOURCES = {
  dice: { name: 'Dice', fetch: fetchDiceJobs },
  naukri: { name: 'Naukri', fetch: fetchNaukriJobs },
  simplyhired: { name: 'SimplyHired', fetch: fetchSimplyHiredJobs },
  indeed: { name: 'Indeed', fetch: fetchIndeedJobs },
  glassdoor: { name: 'Glassdoor', fetch: fetchGlassdoorJobs },
  google: { name: 'Google Search', fetch: fetchGoogleJobs }
};

// Sources that are frequently blocked by anti-bot/CAPTCHA protection.
// Surfaced to the frontend so users are told upfront why these may return few/no jobs.
export const UNRELIABLE_SOURCES = ['indeed', 'glassdoor', 'naukri', 'dice', 'simplyhired', 'google'];

// Per-user live scan status, polled by the frontend so "Scan Jobs Now" reflects the real
// backend state (fetching vs. done) instead of guessing with a fixed timeout.
const scanStatus = new Map();

export function getScanStatus(userId) {
  return scanStatus.get(userId) || { scanning: false, lastResult: null };
}

// Main scrape function
export async function scrapeJobs(userId, isManual = false, options = {}) {
  scanStatus.set(userId, { scanning: true, lastResult: (scanStatus.get(userId) || {}).lastResult || null });
  await addLog(userId, 'INFO', `Starting job sync (${isManual ? 'Manual' : 'Scheduled'})...`);

  try {
    const settings = await getSettings(userId);
    if (settings.scrape_active !== '1' && !isManual) {
      await addLog(userId, 'INFO', 'Scraper is currently disabled. Skipping.');
      scanStatus.set(userId, { scanning: false, lastResult: { skipped: true, finishedAt: Date.now() } });
      return { success: false, skipped: true, reason: 'Scraper is disabled' };
    }

    const location = options.location || settings.location || 'United States';
    const countryCode = options.countryCode || settings.country_code || 'us';
    const workType = options.workType || settings.work_type || 'all'; // onsite | remote | hybrid | all
    const experienceLevel = options.experienceLevel || settings.experience_level || 'all';
    const datePosted = options.datePosted || settings.date_posted || '24h';
    const adzunaAppId = settings.adzuna_app_id || '';
    const adzunaAppKey = settings.adzuna_app_key || '';

    // 1. Get enabled sources (support overrides from options)
    let enabledSources = [];
    if (options.sources && Array.isArray(options.sources) && options.sources.length > 0) {
      enabledSources = normalizeEnabledSources(options.sources);
    } else if (typeof options.sources === 'string' && options.sources.trim()) {
      enabledSources = normalizeEnabledSources(options.sources.split(',').map(s => s.trim()));
    } else {
      try {
        enabledSources = normalizeEnabledSources(settings.enabled_sources || '[]');
      } catch (e) {
        enabledSources = normalizeEnabledSources(['linkedin', 'weworkremotely', 'remotive', 'remoteok']);
      }
    }

    // 2. Parse keywords (support overrides from options or fallback to settings)
    let keywords = [];
    if (options.keywords) {
      if (Array.isArray(options.keywords)) {
        keywords = options.keywords.map(k => k.trim()).filter(Boolean);
      } else if (typeof options.keywords === 'string') {
        keywords = options.keywords.split(/,|\n/).map(k => k.trim()).filter(Boolean);
      }
    } else {
      keywords = (settings.keywords || '')
        .split(/,|\n/)
        .map(k => k.trim())
        .filter(k => k.length > 0);
    }

    // Persist scan parameters to settings if requested so dashboard UI stays in sync
    if (options.savePreferences) {
      try {
        if (options.keywords) {
          await updateSetting(userId, 'keywords', keywords.join(', '));
        }
        if (options.location) {
          await updateSetting(userId, 'location', location);
        }
        if (options.sources) {
          await updateSetting(userId, 'enabled_sources', JSON.stringify(enabledSources));
        }
      } catch (saveErr) {
        console.error('Failed to save scan preferences to settings:', saveErr.message);
      }
    }

    const keywordsQuery = generateBroadSearchQuery(keywords);
    await addLog(userId, 'INFO', `Active Keywords: [${keywords.join(', ') || 'No filter'}], Location: "${location}", Work Type: "${workType}"`);
    if (keywords.length > 0) {
      await addLog(userId, 'INFO', `Compiled Platform Search Query: "${keywordsQuery}"`);
    }

    // Check if db is empty for this user
    const countRow = await get('SELECT COUNT(*) as count FROM jobs WHERE user_id = $1', [userId]);
    const isFirstRun = countRow.count === 0;
    if (isFirstRun) {
      await addLog(userId, 'WARNING', 'Feed is empty. First-run mode: indexing jobs without sending phone alerts.');
    }

    // Prepare async scraping tasks for all enabled sources
    const tasks = [];
    const sourceNames = [];

    // Country-level location searches (e.g. "India") often under-return city-tagged listings
    // on LinkedIn/Adzuna compared to querying each hub city directly. Only fan out for the two
    // sources that actually work reliably today — multiplying requests to the already-blocked
    // scrapers (Indeed/Glassdoor/Naukri/Dice/SimplyHired/Google) would just add failed traffic.
    const locationTargets = expandLocationTargets(location);
    if (locationTargets.length > 1) {
      await addLog(userId, 'INFO', `Country-level location detected — expanding LinkedIn/Adzuna search across hub cities: ${locationTargets.join(', ')}`);
    }

    for (const sourceId of enabledSources) {
      if (sourceId === 'linkedin') {
        sourceNames.push('LinkedIn');
        if (locationTargets.length > 1) {
          tasks.push(withTimeout(fetchLinkedInJobsMultiCity(keywordsQuery, locationTargets, workType, experienceLevel, datePosted), 8000 * locationTargets.length, []));
        } else {
          tasks.push(withTimeout(fetchLinkedInJobs(keywordsQuery, location, workType, experienceLevel, datePosted), 8000, []));
        }
      }
      else if (sourceId === 'remotive') {
        sourceNames.push('Remotive');
        tasks.push(withTimeout(fetchRemotiveJobs(keywords), 8000, []));
      }
      else if (sourceId === 'hackernews') {
        sourceNames.push('Hacker News (YC Jobs)');
        tasks.push(withTimeout(fetchHackerNewsJobs(keywords), 8000, []));
      }
      else if (sourceId === 'adzuna') {
        sourceNames.push('Adzuna');
        if (!adzunaAppId || !adzunaAppKey) {
          tasks.push(Promise.resolve([]));
        } else if (locationTargets.length > 1) {
          tasks.push(withTimeout(fetchAdzunaJobsMultiCity(keywordsQuery, locationTargets, countryCode, adzunaAppId, adzunaAppKey, datePosted), 10000, []));
        } else {
          tasks.push(withTimeout(fetchAdzunaJobs(keywordsQuery, location, countryCode, adzunaAppId, adzunaAppKey, datePosted), 8000, []));
        }
      }
      else if (SEARCH_SOURCES[sourceId]) {
        sourceNames.push(SEARCH_SOURCES[sourceId].name);
        tasks.push(withTimeout(SEARCH_SOURCES[sourceId].fetch(keywordsQuery, location, workType, experienceLevel, datePosted), 6000, []));
      }
      else if (SOURCE_FEEDS[sourceId]) {
        sourceNames.push(SOURCE_FEEDS[sourceId].name);
        if (workType === 'onsite') {
          tasks.push(Promise.resolve([]));
        } else {
          tasks.push(withTimeout(scrapeRSSFeed(sourceId, keywords), 8000, []));
        }
      }
    }

    // Execute scrapers concurrently
    const results = await Promise.allSettled(tasks);
    
    let fetchedJobs = [];
    const platformBreakdown = [];

    results.forEach((res, idx) => {
      const srcName = sourceNames[idx] || 'Unknown';
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        fetchedJobs = fetchedJobs.concat(res.value);
        platformBreakdown.push(`${srcName}: ${res.value.length} jobs`);
      } else {
        platformBreakdown.push(`${srcName}: 0 jobs (Failed/Timeout)`);
      }
    });

    await addLog(userId, 'INFO', `Platform status: ${platformBreakdown.join(' | ')}`);
    await addLog(userId, 'INFO', `Discovered ${fetchedJobs.length} total potential jobs across all sources.`);
    
    let newJobsCount = 0;
    const addedJobs = [];
    
    // Process, Filter & Save jobs
    for (const job of fetchedJobs) {
      // 1. Apply Work Type filter
      if (!filterByWorkType(job, workType)) continue;

      // 2. Apply Location filter strictly (e.g. US target excludes Canada)
      if (!filterByLocation(job.location, location, countryCode)) continue;

      // 3. Apply Keywords filter locally — matched against the TITLE ONLY, never the
      // description. Almost every job description mentions generic words like "product" or
      // "team" somewhere in its body text, so a single-word search like "Product" would
      // otherwise match nearly any Developer/Manager posting through its description rather
      // than its actual title.
      if (!checkKeywords(job.title, '', keywords)) continue;

      // 4. Apply Date Posted filter locally wherever the source reports a real posted date
      // (RSS feeds, Remotive, Adzuna). Sources that don't expose one (LinkedIn, the generic
      // HTML scrapers) fall through unfiltered here and rely on the date param already sent
      // upstream in their own search request.
      if (!isWithinDateWindow(job.postedAt, datePosted)) continue;

      const isNew = await addJob(userId, job);
      if (isNew) {
        newJobsCount++;
        addedJobs.push({
          id: job.id,
          title: job.title,
          company: job.company,
          location: job.location,
          source: job.source,
          url: job.url
        });
        
        // If it's not the first run, send a notification
        if (!isFirstRun) {
          try {
            await sendJobNotification(userId, job, settings);
            await markJobAsNotified(userId, job.id);
          } catch (notifyErr) {
            console.error('Failed to send notification:', notifyErr);
          }
        }
      }
    }
    
    await addLog(userId, 'INFO', `Sync complete. ${newJobsCount} new jobs added to your feed.`);
    const lastResult = {
      newJobsCount,
      totalDiscovered: fetchedJobs.length,
      finishedAt: Date.now(),
      platformBreakdown
    };
    scanStatus.set(userId, {
      scanning: false,
      lastResult
    });

    // Dispatch search completion notification to Discord/Telegram
    sendSearchNotification(userId, {
      keywords: keywords.join(', '),
      location: location,
      totalDiscovered: fetchedJobs.length,
      newAdded: newJobsCount
    }).catch(() => {});

    return {
      success: true,
      userId,
      keywords: keywords.join(', '),
      location,
      sources: enabledSources,
      totalDiscovered: fetchedJobs.length,
      newJobsCount,
      platformBreakdown,
      addedJobs: addedJobs.slice(0, 15) // Preview up to 15 newly added jobs
    };

  } catch (err) {
    await addLog(userId, 'ERROR', `Job sync failed: ${err.message}`);
    console.error('Scrape error:', err);
    scanStatus.set(userId, { scanning: false, lastResult: { error: err.message, finishedAt: Date.now() } });
    return {
      success: false,
      userId,
      error: err.message,
      totalDiscovered: 0,
      newJobsCount: 0
    };
  }
}

// Timeout helper wrapper
function withTimeout(promise, ms, fallbackValue = []) {
  let timeoutId;
  const timeoutPromise = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve(fallbackValue), ms);
  });

  return Promise.race([
    promise.then(val => { clearTimeout(timeoutId); return val; }),
    timeoutPromise
  ]);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Curated hub cities to search directly when the user targets a whole country rather than a
// specific city — LinkedIn/Adzuna's own country-level location matching tends to under-return
// city-tagged listings compared to querying each hub by name.
const LOCATION_EXPANSIONS = {
  india: ['Bangalore', 'Hyderabad', 'Mumbai', 'Pune', 'Delhi NCR', 'Chennai']
};

function expandLocationTargets(location) {
  const key = (location || '').trim().toLowerCase();
  return LOCATION_EXPANSIONS[key] || [location];
}

// Fetch LinkedIn jobs across multiple cities sequentially (with a short gap between requests)
// rather than in parallel — LinkedIn's guest search already gets flagged easily, and bursting
// several simultaneous requests from one IP is the fastest way to lose our best working source.
async function fetchLinkedInJobsMultiCity(keywords, locations, workType, experienceLevel, datePosted) {
  const merged = [];
  const seenIds = new Set();
  for (const loc of locations) {
    try {
      const jobs = await fetchLinkedInJobs(keywords, loc, workType, experienceLevel, datePosted);
      for (const job of jobs) {
        if (!seenIds.has(job.id)) {
          seenIds.add(job.id);
          merged.push(job);
        }
      }
    } catch (e) {
      // one city failing shouldn't stop the rest
    }
    await sleep(400);
  }
  return merged;
}

// Fetch Adzuna jobs across multiple cities in parallel — it's an official rate-limited API,
// not a scraped page, so concurrent requests are safe.
async function fetchAdzunaJobsMultiCity(keywords, locations, countryCode, appId, appKey, datePosted) {
  const results = await Promise.all(
    locations.map(loc => fetchAdzunaJobs(keywords, loc, countryCode, appId, appKey, datePosted).catch(() => []))
  );
  const merged = [];
  const seenIds = new Set();
  for (const jobs of results) {
    for (const job of jobs) {
      if (!seenIds.has(job.id)) {
        seenIds.add(job.id);
        merged.push(job);
      }
    }
  }
  return merged;
}

// -------------------------------------------------------------
// Scrapers and Fetchers
// -------------------------------------------------------------

// Remotive Free API Scraper
async function fetchRemotiveJobs(keywords) {
  const jobs = [];
  try {
    const response = await axios.get('https://remotive.com/api/remote-jobs?limit=50', { timeout: 7000 });
    if (response.data && Array.isArray(response.data.jobs)) {
      response.data.jobs.forEach(item => {
        const title = item.title || '';
        const company = item.company_name || 'Remotive Employer';
        const url = item.url || '';
        const jobLocation = item.candidate_required_location || 'Remote';

        if (checkKeywords(title, '', keywords)) {
          jobs.push({
            id: 'rem_' + (item.id || generateJobId(url)),
            title,
            company,
            url,
            source: 'Remotive',
            description: (item.description || '').replace(/<\/?[^>]+(>|$)/g, '').substring(0, 1000),
            salary: item.salary || '',
            location: jobLocation,
            postedAt: item.publication_date || null
          });
        }
      });
      await addLog(null, 'INFO', `Remotive API returned ${jobs.length} jobs.`);
    }
  } catch (err) {
    await addLog(null, 'ERROR', `Remotive API fetch failed: ${err.message}`);
  }
  return jobs;
}

// Hacker News "Jobs" board — "Is Hiring" posts from YC-funded companies. Unlike most sources
// here, HN has no bot protection and a stable, simple server-rendered page, so this is one of
// the more reliable scrapers in this file. Only the first page (~30 posts) is fetched, matching
// the single-page-per-scan approach already used for Adzuna/etc.
async function fetchHackerNewsJobs(keywords) {
  const jobs = [];
  try {
    const response = await axios.get('https://news.ycombinator.com/jobs', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
      timeout: 7000
    });

    const $ = cheerio.load(response.data);

    $('tr.athing').each((_, el) => {
      const anchor = $(el).find('.titleline a').first();
      const title = anchor.text().trim();
      if (!title) return;

      let href = anchor.attr('href') || '';
      if (href && !href.startsWith('http')) {
        href = `https://news.ycombinator.com/${href}`;
      }
      if (!href) return;

      if (!checkKeywords(title, '', keywords)) return;

      // Company name is the text before " (YC ...)" or " is/Is hiring"
      const companyMatch = title.match(/^(.+?)\s*(?:\(YC\s|is hiring|Is Hiring)/i);
      const company = companyMatch ? companyMatch[1].trim() : 'YC-Funded Company';

      // Best-effort location extraction from common title patterns like
      // "[Berlin, on-site]", "(SF and remote)", "in Austin, TX"
      const locMatch = title.match(/\[([^\]]+)\]|\(([^)]*(?:remote|on-site|hybrid|,)[^)]*)\)|\bin\s([A-Z][a-zA-Z.\s]+(?:,\s?[A-Z]{2})?)$/);
      const location = (locMatch ? (locMatch[1] || locMatch[2] || locMatch[3]) : '').trim();

      jobs.push({
        id: 'hn_' + generateJobId(href),
        title,
        company,
        url: href,
        source: 'Hacker News (YC Jobs)',
        description: 'YC company hiring post from Hacker News. Open the link for full details.',
        salary: '',
        location
      });
    });

    await addLog(null, 'INFO', `Hacker News Jobs returned ${jobs.length} jobs.`);
  } catch (err) {
    await addLog(null, 'ERROR', `Hacker News Jobs fetch failed: ${err.message}`);
  }
  return jobs;
}



// LinkedIn guest search scraper
async function fetchLinkedInJobs(keywords, location, workType, experienceLevel, datePosted) {
  const jobs = [];
  try {
    let expFilter = '';
    if (experienceLevel === 'entry') expFilter = '&f_E=2';
    else if (experienceLevel === 'mid_senior') expFilter = '&f_E=4';
    else if (experienceLevel === 'director') expFilter = '&f_E=5%2C6';
    
    let timeFilter = '&f_TPR=r86400';
    if (datePosted === 'week') timeFilter = '&f_TPR=r604800';
    else if (datePosted === 'month') timeFilter = '&f_TPR=r2592000';
    else if (datePosted === 'all') timeFilter = '';

    const searchUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}${timeFilter}${expFilter}&start=0`;
    
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 7000
    });

    const $ = cheerio.load(response.data);
    
    $('li').each((index, element) => {
      const card = $(element).find('.base-search-card');
      if (!card.length) return;

      const title = card.find('.base-search-card__title').text().trim();
      const company = card.find('.base-search-card__subtitle').text().trim();
      const jobUrl = card.find('.base-card__full-link').attr('href') || '';
      const jobLocation = card.find('.job-search-card__location').text().trim();
      
      const cleanUrl = jobUrl.split('?')[0]; // strip query params
      const id = 'li_' + (cleanUrl.match(/-([0-9]+)$/)?.[1] || generateJobId(cleanUrl));

      jobs.push({
        id,
        title,
        company: company || 'LinkedIn Employer',
        url: cleanUrl,
        source: 'LinkedIn',
        description: `Local/Onsite job listed on LinkedIn. Location: ${jobLocation}. Apply directly on LinkedIn.`,
        salary: '',
        location: jobLocation
      });
    });
    
    await addLog(null, 'INFO', `LinkedIn guest search returned ${jobs.length} jobs.`);
  } catch (err) {
    await addLog(null, 'ERROR', `LinkedIn guest scraper failed: ${err.message}`);
  }
  return jobs;
}

// Adzuna API fetcher
async function fetchAdzunaJobs(keywords, location, countryCode, appId, appKey, datePosted) {
  const jobs = [];
  if (!appId || !appKey) {
    await addLog(null, 'WARNING', 'Adzuna API credentials (App ID / Key) are missing. Skipping Adzuna scrape.');
    return jobs;
  }

  try {
    const country = (countryCode || 'us').toLowerCase();
    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1`;
    
    let maxDays = 1;
    if (datePosted === 'week') maxDays = 7;
    else if (datePosted === 'month') maxDays = 30;
    else if (datePosted === 'all') maxDays = 365;

    const response = await axios.get(url, {
      params: {
        app_id: appId,
        app_key: appKey,
        results_per_page: 30,
        what: keywords,
        where: location,
        max_days_old: maxDays
      },
      timeout: 7000
    });

    if (response.data && response.data.results) {
      response.data.results.forEach(item => {
        const title = item.title || '';
        const company = item.company?.display_name || 'Adzuna Employer';
        const jobUrl = item.redirect_url || '';
        const jobLocation = item.location?.display_name || '';
        
        let salaryText = '';
        if (item.salary_min) {
          salaryText = `$${Math.round(item.salary_min).toLocaleString()}`;
          if (item.salary_max) {
            salaryText += ` - $${Math.round(item.salary_max).toLocaleString()}`;
          }
        }

        const cleanTitle = title.replace(/<\/?[^>]+(>|$)/g, ''); // strip HTML tags

        jobs.push({
          id: 'adz_' + (item.id || generateJobId(jobUrl)),
          title: cleanTitle,
          company,
          url: jobUrl,
          source: `Adzuna (${item.contract_type || 'Full Time'})`,
          description: item.description ? item.description.replace(/<\/?[^>]+(>|$)/g, '') : 'View job details on Adzuna.',
          salary: salaryText,
          location: jobLocation,
          postedAt: item.created || null
        });
      });
      await addLog(null, 'INFO', `Adzuna API returned ${jobs.length} jobs.`);
    }
  } catch (err) {
    await addLog(null, 'ERROR', `Adzuna API fetch failed: ${err.message}`);
  }
  return jobs;
}

export function buildPlatformSearchUrl(sourceId, keywords, location, experienceLevel, datePosted) {
  const query = (keywords || '').trim();
  const loc = (location || '').trim();
  if (!query || !loc) return null;

  const params = new URLSearchParams({
    q: query,
    l: loc,
    countryCode: 'US',
    radius: '30',
    radiusUnit: 'mi',
    page: '1',
    sort: 'updatedate_desc',
    limit: '20'
  });

  let indeedExp = '';
  let glassdoorExp = '';
  if (experienceLevel === 'entry') { indeedExp = '&explvl=entry_level'; glassdoorExp = '&seniorityType=entrylevel'; }
  else if (experienceLevel === 'mid_senior') { indeedExp = '&explvl=mid_level'; glassdoorExp = '&seniorityType=midlevel'; }
  else if (experienceLevel === 'director') { indeedExp = '&explvl=senior_level'; glassdoorExp = '&seniorityType=seniorlevel'; }

  let indeedTime = '1';
  let glassdoorTime = '1';
  if (datePosted === 'week') { indeedTime = '7'; glassdoorTime = '7'; }
  else if (datePosted === 'month') { indeedTime = '30'; glassdoorTime = '30'; }
  else if (datePosted === 'all') { indeedTime = 'any'; glassdoorTime = '0'; }

  switch (sourceId) {
    case 'dice':
      return `https://www.dice.com/jobs?${params.toString()}`;
    case 'naukri': {
      const naukriParams = new URLSearchParams({ searchType: 'search', k: query, l: loc });
      return `https://www.naukri.com/jobsearch?${naukriParams.toString()}`;
    }
    case 'simplyhired':
      return `https://www.simplyhired.com/search?q=${encodeURIComponent(query)}&l=${encodeURIComponent(loc)}`;
    case 'indeed':
      return `https://www.indeed.com/jobs?q=${encodeURIComponent(query)}&l=${encodeURIComponent(loc)}${indeedTime !== 'any' ? `&fromage=${indeedTime}` : ''}${indeedExp}`;
    case 'glassdoor':
      return `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(query)}&locT=C&locName=${encodeURIComponent(loc)}${glassdoorTime !== '0' ? `&fromAge=${glassdoorTime}` : ''}${glassdoorExp}`;
    default:
      return null;
  }
}

async function fetchDiceJobs(keywords, location, workType, exp, datePosted) {
  return fetchGenericSearchJobs('dice', keywords, location, exp, datePosted);
}

async function fetchNaukriJobs(keywords, location, workType, exp, datePosted) {
  return fetchGenericSearchJobs('naukri', keywords, location, exp, datePosted);
}

async function fetchSimplyHiredJobs(keywords, location, workType, exp, datePosted) {
  return fetchGenericSearchJobs('simplyhired', keywords, location, exp, datePosted);
}

async function fetchIndeedJobs(keywords, location, workType, exp, datePosted) {
  return fetchGenericSearchJobs('indeed', keywords, location, exp, datePosted);
}

async function fetchGlassdoorJobs(keywords, location, workType, exp, datePosted) {
  return fetchGenericSearchJobs('glassdoor', keywords, location, exp, datePosted);
}

// Google Search job discovery: uses site-restricted queries against major job boards
// (Naukri, Indeed, Glassdoor, LinkedIn, Monster, Shine) since Google itself has no stable
// scrapable "Google for Jobs" markup. This is inherently best-effort — Google aggressively
// rate-limits/CAPTCHAs automated queries, so treat it as a bonus source, not a primary one.
function buildGoogleSearchQuery(keywords, location, workType) {
  const query = (keywords || '').trim();
  if (!query) return null;

  const jobSites = '(site:naukri.com OR site:indeed.com OR site:glassdoor.co.in OR site:glassdoor.com OR site:linkedin.com/jobs OR site:monster.com OR site:shine.com)';
  const remoteTerm = workType === 'remote' ? ' remote' : '';
  const locTerm = (location || '').trim() ? ` in ${location.trim()}` : '';
  return `${jobSites} (${query}) jobs${remoteTerm}${locTerm}`;
}

async function fetchGoogleJobs(keywords, location, workType, experienceLevel, datePosted) {
  const jobs = [];
  const searchQuery = buildGoogleSearchQuery(keywords, location, workType);
  if (!searchQuery) return jobs;

  try {
    const response = await axios.get('https://www.google.com/search', {
      params: { q: searchQuery, num: 20, hl: 'en', gl: 'in' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 6000
    });

    const $ = cheerio.load(response.data);
    const seenUrls = new Set();

    $('div.g, div.yuRUbf, div[data-hveid]').each((_, el) => {
      const anchor = $(el).find('a[href^="http"]').first();
      const href = (anchor.attr('href') || '').trim();
      if (!href || href.includes('google.com') || href.includes('youtube.com')) return;
      if (seenUrls.has(href)) return;

      const title = $(el).find('h3').first().text().trim();
      if (!title) return;
      seenUrls.add(href);

      let company = 'Unknown';
      try {
        const hostname = new URL(href).hostname.replace(/^www\./, '');
        const base = hostname.split('.')[0];
        company = base.charAt(0).toUpperCase() + base.slice(1);
      } catch (e) { /* ignore malformed URL */ }

      jobs.push({
        id: 'goog_' + generateJobId(href),
        title,
        company,
        url: href,
        source: 'Google Search',
        description: $(el).find('.VwiC3b, .IsZvec').first().text().trim() || 'Job lead discovered via Google Search. Open the link to view full details on the source site.',
        salary: '',
        location: location || ''
      });
    });

    if (jobs.length === 0) {
      await addLog(null, 'WARNING', 'Google Search returned 0 parsable job links. Google frequently blocks automated queries or changes its result markup — this source is best-effort only, not guaranteed to work.');
    } else {
      await addLog(null, 'INFO', `Google Search returned ${jobs.length} job leads.`);
    }
  } catch (err) {
    let msg = err.message;
    if (err.response && (err.response.status === 429 || err.response.status === 403)) {
      msg += ' (Google CAPTCHA/rate-limit triggered. Direct scraping of Google Search is unreliable by nature — consider it a bonus source only.)';
    }
    await addLog(null, 'ERROR', `Google Search scraper skipped: ${msg}`);
  }

  return jobs;
}

async function fetchGenericSearchJobs(sourceId, keywords, location, experienceLevel, datePosted) {
  const searchUrl = buildPlatformSearchUrl(sourceId, keywords, location, experienceLevel, datePosted);
  if (!searchUrl) return [];

  const jobs = [];
  const seenUrls = new Set();
  try {
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 5000
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
        return href.includes('/jobs/') || href.includes('/job/') || href.includes('/jobsearch') || href.includes('/search');
      }).first();

      const title = (anchor.text() || $(el).find('h2, h3, h4').first().text() || '').toString().trim();
      const rawUrl = anchor.attr('href') || '';
      const company = $(el).find('.company, .employer, .org, .companyName, [data-testid="companyName"]').first().text().trim() || 'Unknown company';
      const locationText = $(el).find('.location, .job-location, .location').first().text().trim() || '';
      const description = $(el).find('.description, .summary, .snippet').first().text().trim() || '';

      if (!title || !rawUrl) return;

      const url = rawUrl.startsWith('http') ? rawUrl : `https://www.${sourceId === 'naukri' ? 'naukri.com' : sourceId === 'simplyhired' ? 'simplyhired.com' : 'dice.com'}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`;
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

    await addLog(null, 'INFO', `${SEARCH_SOURCES[sourceId].name} search returned ${jobs.length} jobs.`);
  } catch (err) {
    let errMsg = err.message;
    if (err.response && (err.response.status === 403 || err.response.status === 429)) {
      errMsg = `${err.message} (Bot protection/CAPTCHA triggered. Direct scraping of ${SEARCH_SOURCES[sourceId].name} is blocked. This platform is known to be unreliable for automated scraping — enable the Adzuna API source instead for consistent results from Indeed/Glassdoor-partnered listings.)`;
    }
    await addLog(null, 'ERROR', `${SEARCH_SOURCES[sourceId].name} scraper skipped: ${errMsg}`);
  }

  return jobs;
}

// Scrape RSS Feeds
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
        if (parts.length > 1) {
          company = parts[0].trim();
        }
      } else if (!company && sourceId === 'remoteok') {
        const parts = title.split(' at ');
        if (parts.length > 1) {
          company = parts[parts.length - 1].trim();
        }
      }

      let displayTitle = title;
      if (sourceId === 'weworkremotely' && title.includes(':')) {
        displayTitle = title.substring(title.indexOf(':') + 1).trim();
      }

      const matchesKeyword = checkKeywords(displayTitle, '', keywords);
      if (!matchesKeyword) continue;

      jobs.push({
        id: generateJobId(url),
        title: displayTitle,
        company: company || 'Remote Company',
        url: url,
        source: feedConfig.name,
        description: description.substring(0, 1000),
        salary: extractSalary(title + ' ' + description),
        location: extractLocation(item),
        postedAt: item.isoDate || item.pubDate || null
      });
    }
  } catch (err) {
    await addLog(null, 'ERROR', `Error scraping ${feedConfig.name}: ${err.message}`);
  }
  return jobs;
}

// Helper: Filter job matches based on location (e.g., US target vs Canada)
function filterByLocation(jobLocation, targetLocation, countryCode) {
  if (!jobLocation) return true;

  const target = (targetLocation || '').toLowerCase().trim();
  const code = (countryCode || '').toLowerCase().trim();

  // If user requested US / United States
  const isTargetUS = target.includes('united states') || target.includes('us') || target.includes('usa') || code === 'us';

  if (isTargetUS) {
    const locLower = jobLocation.toLowerCase();

    // Direct non-US country exclusions
    const excludedCountries = ['canada', 'toronto', 'vancouver', 'montreal', 'quebec', 'ontario', 'uk', 'united kingdom', 'london', 'india', 'bangalore', 'mumbai', 'germany', 'berlin', 'france', 'paris', 'australia', 'sydney'];
    const isExcluded = excludedCountries.some(country => locLower.includes(country));

    if (isExcluded) {
      // Allow only if explicitly saying US remote e.g. "Canada, US Remote"
      const allowsUS = locLower.includes('us') || locLower.includes('united states') || locLower.includes('usa');
      if (!allowsUS) return false;
    }
  }

  return true;
}

// Helper: Filter job matches based on the Date Posted setting, using each source's real
// posted date when available. Unknown dates pass through — we'd rather show an undated job
// than silently drop everything from a source that can't report one.
function isWithinDateWindow(postedAt, datePosted) {
  if (!datePosted || datePosted === 'all') return true;
  if (!postedAt) return true;

  const posted = new Date(postedAt).getTime();
  if (isNaN(posted)) return true;

  const ageMs = Date.now() - posted;
  const DAY_MS = 24 * 60 * 60 * 1000;

  if (datePosted === '24h') return ageMs <= DAY_MS;
  if (datePosted === 'week') return ageMs <= 7 * DAY_MS;
  if (datePosted === 'month') return ageMs <= 30 * DAY_MS;
  return true;
}

// Helper: Filter job matches based on work type
function filterByWorkType(job, workType) {
  if (workType === 'all') return true;

  const text = `${job.title} ${job.description} ${job.location}`.toLowerCase();
  const hasRemoteKeyword = /\bremote\b|\bwfh\b|\bwork from home\b/.test(text);
  const hasHybridKeyword = /\bhybrid\b/.test(text);

  if (workType === 'onsite') {
    if (hasRemoteKeyword && !hasHybridKeyword) return false;
    if (job.location && job.location.toLowerCase().includes('remote') && !job.location.toLowerCase().includes('hybrid')) return false;
    return true;
  }

  if (workType === 'remote') {
    return hasRemoteKeyword || (job.location && job.location.toLowerCase().includes('remote'));
  }

  if (workType === 'hybrid') {
    return hasHybridKeyword;
  }

  return true;
}

// Helper: Check keyword matches (case-insensitive). Every call site now passes an empty
// description deliberately — matching against description text let generic single-word
// searches (e.g. "Product") match nearly any job whose description just happens to mention
// the word, regardless of its actual title. The `description` param is kept so a future
// caller could opt back in for a specific source, but none currently do.
function checkKeywords(title, description, keywords) {
  if (!keywords || keywords.length === 0) return true;
  
  const text = `${title} ${description}`.toLowerCase();
  return keywords.some(keyword => {
    const escapedKeyword = keyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regexStr = /^[a-zA-Z0-9]+$/.test(keyword) ? `\\b${escapedKeyword}\\b` : escapedKeyword;
    const regex = new RegExp(regexStr, 'i');
    return regex.test(text);
  });
}

// Helper: Extract location
function extractLocation(item) {
  if (item.categories && item.categories.length > 0) {
    const locations = item.categories.filter(c => c.toLowerCase().includes('remote') || c.length < 20);
    if (locations.length > 0) return locations[0];
  }
  return 'Remote';
}

// Helper: Extract salary
function extractSalary(text) {
  const match = text.match(/(\$[0-9]{2,3},?[0-9]{3}|\£[0-9]{2,3},?[0-9]{3}|\€[0-9]{2,3},?[0-9]{3})/);
  if (match) {
    const rangeMatch = text.match(/(\$[0-9,]+)\s*-\s*(\$[0-9,]+)/);
    if (rangeMatch) return `${rangeMatch[1]} - ${rangeMatch[2]}`;
    return match[0];
  }
  return '';
}

// Helper: Hash generator
function generateJobId(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return 'job_' + Math.abs(hash).toString(36);
}

// Helper: Compile keywords into a precise search query. Each keyword is kept as a whole
// phrase (quoted if it has multiple words) so a search for "Product Designer" stays
// "Product Designer" instead of being shattered into "Product OR Designer" — the latter
// is what let unrelated "Graphic Designer" / "Product Manager" postings leak through.
// Multiple distinct keywords are still OR'd together at the phrase level so users can
// track several job titles at once (e.g. "Product Designer, UX Designer").
function generateBroadSearchQuery(keywords) {
  if (!keywords || keywords.length === 0) return '';

  const phrases = keywords
    .map(k => k.trim())
    .filter(k => k.length > 0)
    .map(k => (/\s/.test(k) ? `"${k}"` : k));

  return phrases.join(' OR ');
}
