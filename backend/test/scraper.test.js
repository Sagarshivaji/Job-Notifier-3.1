import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlatformSearchUrl } from '../scraper.js';
import { normalizeEnabledSources } from '../db.js';

test('buildPlatformSearchUrl creates Dice search URLs', () => {
  const url = buildPlatformSearchUrl('dice', 'react developer', 'Austin, TX');
  assert.equal(url.includes('https://www.dice.com/jobs'), true);
  assert.equal(url.includes('q=react+developer'), true);
  assert.equal(url.includes('l=Austin%2C+TX'), true);
});

test('buildPlatformSearchUrl creates Naukri search URLs', () => {
  const url = buildPlatformSearchUrl('naukri', 'node engineer', 'Bengaluru');
  assert.equal(url.includes('https://www.naukri.com'), true);
  assert.equal(url.includes('jobsearch'), true);
  assert.equal(url.includes('k=node+engineer'), true);
  assert.equal(url.includes('l=Bengaluru'), true);
});

test('normalizeEnabledSources upgrades older settings to include the new platforms', () => {
  const result = normalizeEnabledSources(['linkedin', 'weworkremotely']);
  assert.equal(result.includes('linkedin'), true);
  assert.equal(result.includes('weworkremotely'), true);
  assert.equal(result.includes('remoteok'), true);
  assert.equal(result.includes('adzuna'), true);
});
