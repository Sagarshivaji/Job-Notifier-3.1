/**
 * content.js — Job Notifier Browser Extension
 * Injected into Indeed, Naukri, and LinkedIn job search pages.
 *
 * TWO modes:
 *  1. AUTO-IMPORT (silent): Waits for page to render, extracts jobs, sends
 *     them to background.js → backend automatically. Zero user interaction needed.
 *  2. ON-DEMAND (popup): Popup sends "extractJobs" message → we return fresh jobs.
 */

(function () {
  'use strict';

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function getText(el, selector) {
    const found = el.querySelector(selector);
    return found ? found.textContent.trim() : '';
  }

  function getAttr(el, selector, attr) {
    const found = el.querySelector(selector);
    return found ? (found.getAttribute(attr) || '').trim() : '';
  }

  function makeAbsolute(href, base) {
    if (!href) return '';
    try {
      return new URL(href, base).href;
    } catch (_) {
      return href;
    }
  }

  function hashStr(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      hash = ((hash << 5) - hash + c) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  function isWithin24Hours(dateStr) {
    if (!dateStr) return true; // If we can't find a date, keep it to be safe
    const s = dateStr.toLowerCase();
    
    // Explicitly check for matches that mean <= 24 hours
    if (s.includes('just now') || 
        s.includes('today') || 
        s.includes('hour') || 
        s.includes('minute') || 
        s.includes('second') || 
        s.includes('1 day') || 
        s.includes('1d') ||
        s.includes('24h') ||
        s.includes('few')
    ) {
      return true;
    }
    
    // If it mentions plural days, weeks, months, or years -> false
    if (s.match(/\b[2-9]\s*days?\b/) || 
        s.match(/\b[1-9][0-9]+\s*days?\b/) ||
        s.includes('week') || 
        s.includes('month') || 
        s.includes('year') || 
        s.includes('+')
    ) {
      return false;
    }
    
    // If it matches shorthand like "2d", "30d"
    if (s.match(/\b[2-9]d\b/) || s.match(/\b[1-9][0-9]+d\b/)) {
      return false;
    }

    return true; // Default to true if ambiguous
  }

  // ─── Indeed Parser ───────────────────────────────────────────────────────────

  function parseIndeed() {
    const jobs = [];
    const cards = document.querySelectorAll(
      '[data-jk], .job_seen_beacon, .jobsearch-ResultsList > li, .result'
    );

    cards.forEach((card) => {
      const titleEl = card.querySelector(
        '[data-testid="jobTitle"], .jobTitle a, h2.title a, .jobtitle a, a.jcs-JobTitle'
      );
      const title = titleEl ? titleEl.textContent.trim() : '';
      if (!title) return;

      let href =
        getAttr(card, '[data-testid="jobTitle"] a', 'href') ||
        getAttr(card, '.jobTitle a', 'href') ||
        getAttr(card, 'h2.title a', 'href') ||
        getAttr(card, 'a.jcs-JobTitle', 'href') ||
        getAttr(card, 'a[id^="job_"]', 'href');
      href = makeAbsolute(href, 'https://www.indeed.com');

      const company =
        getText(card, '[data-testid="company-name"]') ||
        getText(card, '.companyName') ||
        getText(card, '.company') ||
        'Indeed Employer';

      const location =
        getText(card, '[data-testid="text-location"]') ||
        getText(card, '.companyLocation') ||
        getText(card, '.location') ||
        '';

      const salary =
        getText(card, '[data-testid="attribute_snippet_testid"]') ||
        getText(card, '.salary-snippet-container') ||
        getText(card, '.salaryText') ||
        '';

      const postedDate = 
        getText(card, '.date') || 
        getText(card, '[data-testid="myJobsStateDate"]') || 
        getText(card, '.jobsearch-JobMetadataFooter') || 
        '';

      if (!isWithin24Hours(postedDate)) return;

      const description =
        getText(card, '.job-snippet') ||
        getText(card, '[data-testid="jobDescriptionText"]') ||
        '';

      const jk = card.getAttribute('data-jk') || hashStr(href || title);
      const id = 'ind_' + jk;

      if (!href) return;

      jobs.push({ id, title, company, url: href, location, salary, description, source: 'Indeed (Extension)' });
    });

    return jobs;
  }

  // ─── Naukri Parser ───────────────────────────────────────────────────────────

  function parseNaukri() {
    const jobs = [];

    const cards = document.querySelectorAll(
      'article.jobTuple, .jobTuple128, .cust-job-tuple, article[data-job-id], .srp-jobtuple-wrapper'
    );

    cards.forEach((card) => {
      const titleEl =
        card.querySelector('a.title') ||
        card.querySelector('.jobtitle a') ||
        card.querySelector('a[title]');
      const title = titleEl ? titleEl.textContent.trim() : '';
      if (!title) return;

      let href = titleEl ? (titleEl.getAttribute('href') || '') : '';
      href = makeAbsolute(href, 'https://www.naukri.com');

      const company =
        getText(card, 'a.subTitle') ||
        getText(card, '.comp-name') ||
        getText(card, '.companyName') ||
        getText(card, 'a.company') ||
        'Naukri Employer';

      const location =
        getText(card, '.locWdth') ||
        getText(card, 'span.location') ||
        getText(card, '.loc') ||
        '';

      const salary =
        getText(card, '.salary') ||
        getText(card, '.sal') ||
        '';

      const postedDate = 
        getText(card, '.job-post-day') || 
        getText(card, '.add-time') || 
        getText(card, '.time') || 
        '';

      if (!isWithin24Hours(postedDate)) return;

      const description =
        getText(card, '.job-description') ||
        getText(card, '.jd-desc') ||
        getText(card, '.more-dt-dsk') ||
        '';

      const jobId =
        card.getAttribute('data-job-id') ||
        card.getAttribute('data-id') ||
        hashStr(href || title);
      const id = 'nk_' + jobId;

      if (!href) return;

      jobs.push({ id, title, company, url: href, location, salary, description, source: 'Naukri (Extension)' });
    });

    return jobs;
  }

  // ─── LinkedIn Parser ─────────────────────────────────────────────────────────

  function parseLinkedIn() {
    const jobs = [];

    const cards = document.querySelectorAll(
      '.base-search-card, .jobs-search-results__list-item, .job-card-container'
    );

    cards.forEach((card) => {
      const titleEl =
        card.querySelector('.base-search-card__title') ||
        card.querySelector('.job-card-list__title') ||
        card.querySelector('a.job-card-container__link');
      const title = titleEl ? titleEl.textContent.trim() : '';
      if (!title) return;

      let href =
        getAttr(card, 'a.base-card__full-link', 'href') ||
        getAttr(card, '.job-card-container__link', 'href') ||
        getAttr(card, 'a[href*="/jobs/view/"]', 'href') ||
        '';
      href = makeAbsolute(href, 'https://www.linkedin.com');
      const cleanHref = href.split('?')[0];

      const company =
        getText(card, '.base-search-card__subtitle') ||
        getText(card, '.job-card-container__company-name') ||
        'LinkedIn Employer';

      const location =
        getText(card, '.job-search-card__location') ||
        getText(card, '.job-card-container__metadata-item') ||
        '';

      const postedDate = 
        getText(card, 'time') || 
        getText(card, '.job-search-card__listdate') || 
        getText(card, '.job-search-card__listdate--new') || 
        '';

      if (!isWithin24Hours(postedDate)) return;

      const idMatch = cleanHref.match(/-([0-9]+)$/);
      const id = 'li_' + (idMatch ? idMatch[1] : hashStr(cleanHref || title));

      if (!cleanHref) return;

      jobs.push({
        id,
        title,
        company,
        url: cleanHref,
        location,
        salary: '',
        description: `LinkedIn job. Location: ${location}`,
        source: 'LinkedIn (Extension)'
      });
    });

    return jobs;
  }

  // ─── Glassdoor Parser ────────────────────────────────────────────────────────
  // Glassdoor ships CSS-module class names that change hash on every build
  // (e.g. "JobCard_jobCardContainer__abc123"), so selectors below lean on the
  // more stable data-test/data-jobid attributes with partial class-name
  // fallbacks. If Glassdoor reworks its markup these may need updating.

  function parseGlassdoor() {
    const jobs = [];
    const cards = document.querySelectorAll(
      'li[data-jobid], li.react-job-listing, div[data-test="jobListing"], div[class*="JobCard_jobCardContainer"]'
    );

    cards.forEach((card) => {
      const titleEl =
        card.querySelector('a[data-test="job-link"]') ||
        card.querySelector('a.jobLink') ||
        card.querySelector('[class*="JobCard_jobTitle"] a') ||
        card.querySelector('a[id^="job-title"]');
      const title = titleEl ? titleEl.textContent.trim() : '';
      if (!title) return;

      let href = titleEl ? (titleEl.getAttribute('href') || '') : '';
      href = makeAbsolute(href, 'https://www.glassdoor.com');

      const company =
        getText(card, '[data-test="employer-short-name"]') ||
        getText(card, '[class*="EmployerProfile_compactEmployerName"]') ||
        getText(card, '.employerName') ||
        'Glassdoor Employer';

      const location =
        getText(card, '[data-test="emp-location"]') ||
        getText(card, '[class*="JobCard_location"]') ||
        '';

      const salary =
        getText(card, '[data-test="detailSalary"]') ||
        getText(card, '[class*="JobCard_salaryEstimate"]') ||
        '';

      const postedDate =
        getText(card, '[data-test="job-age"]') ||
        getText(card, '[class*="JobCard_listingAge"]') ||
        '';

      if (!isWithin24Hours(postedDate)) return;

      const description =
        getText(card, '[data-test="descSnippet"]') ||
        getText(card, '[class*="JobCard_jobDescriptionSnippet"]') ||
        '';

      const jobId =
        card.getAttribute('data-jobid') ||
        card.getAttribute('data-id') ||
        hashStr(href || title);
      const id = 'gd_' + jobId;

      if (!href) return;

      jobs.push({ id, title, company, url: href, location, salary, description, source: 'Glassdoor (Extension)' });
    });

    return jobs;
  }

  // ─── Detect Site & Extract ───────────────────────────────────────────────────

  function extractJobs() {
    const host = window.location.hostname;
    if (host.includes('indeed.com')) return parseIndeed();
    if (host.includes('naukri.com')) return parseNaukri();
    if (host.includes('linkedin.com')) return parseLinkedIn();
    if (host.includes('glassdoor.')) return parseGlassdoor();
    return [];
  }

  // ─── Auto-Import (silent, runs on page load) ─────────────────────────────────

  let autoImportDone = false; // prevent duplicate imports on same page

  function runAutoImport() {
    if (autoImportDone) return;

    const jobs = extractJobs();

    // Update badge with how many we detected
    try {
      chrome.runtime.sendMessage({ action: 'updateBadge', count: jobs.length });
    } catch (_) {}

    if (jobs.length === 0) {
      console.log('[Job Notifier] No jobs detected on this page yet.');
      return;
    }

    autoImportDone = true;
    console.log(`[Job Notifier] Auto-importing ${jobs.length} jobs silently...`);

    // Send to background script which will call the backend
    try {
      chrome.runtime.sendMessage(
        { action: 'autoImportJobs', jobs },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[Job Notifier] Background response error:', chrome.runtime.lastError.message);
            return;
          }
          if (response && response.success) {
            console.log(`[Job Notifier] Auto-import done: ${response.added} new, ${response.skipped} skipped`);
          } else if (response && response.reason === 'no_credentials') {
            console.log('[Job Notifier] No credentials saved. Open the extension popup to configure.');
          } else {
            console.warn('[Job Notifier] Auto-import response:', response);
          }
        }
      );
    } catch (err) {
      console.warn('[Job Notifier] Could not send auto-import message:', err.message);
    }
  }

  // ─── Trigger strategy ────────────────────────────────────────────────────────
  // Wait for the DOM to fully populate with job cards before scanning.
  // Most sites use lazy-loading so we wait up to 7 seconds with multiple attempts.

  const DELAYS = [2000, 4000, 7000]; // try at 2s, 4s, and 7s after page load
  let importAttempts = 0;

  function scheduleAutoImport() {
    DELAYS.forEach((delay) => {
      setTimeout(() => {
        if (autoImportDone) return; // already succeeded
        importAttempts++;
        const jobs = extractJobs();
        if (jobs.length > 0) {
          runAutoImport();
        } else if (importAttempts >= DELAYS.length) {
          console.log('[Job Notifier] No jobs found after all attempts. Try scrolling or refreshing.');
        }
      }, delay);
    });
  }

  // ─── Message listener (popup asks for jobs on-demand) ────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'extractJobs') {
      const jobs = extractJobs();
      sendResponse({ jobs });
    }
    return true; // keep channel open for async
  });

  // ─── Init ────────────────────────────────────────────────────────────────────

  // Cache initial scan for popup
  window.__jobNotifierJobs = extractJobs();
  console.log(`[Job Notifier] Initial scan: ${window.__jobNotifierJobs.length} jobs visible.`);

  // Start auto-import schedule
  scheduleAutoImport();

})();
