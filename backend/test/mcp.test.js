import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, updateJobStatus, getJobById, getJobs } from '../db.js';

test('Database init and job status management', async () => {
  await initDb();
  const jobs = await getJobs(2, 5);
  assert.ok(Array.isArray(jobs), 'Jobs should be an array');
  assert.ok(jobs.length > 0, 'Should have jobs in DB');

  const testJob = jobs[0];
  const originalStatus = testJob.status || 'Discovered';

  // Test updating status to Interviewing
  const updated = await updateJobStatus(2, testJob.id, 'Interviewing');
  assert.equal(updated.status, 'Interviewing');
  assert.equal(updated.applied, 1);

  // Test getJobById
  const fetched = await getJobById(2, testJob.id);
  assert.equal(fetched.id, testJob.id.toString());
  assert.equal(fetched.status, 'Interviewing');

  // Revert back
  const reverted = await updateJobStatus(2, testJob.id, originalStatus);
  assert.equal(reverted.status, originalStatus);
});
