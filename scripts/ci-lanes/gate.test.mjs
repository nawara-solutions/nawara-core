// Core V2 Smart CI (Stage 1): the core-ci-passed gate CLI (scripts/ci-lanes/gate.mjs) end to end, as the workflow runs it: NEEDS, EVENT and
// CI_FORCE_FULL in the environment, exit 0 only on a pass. GATE_MODULE overrides the module under test (negative controls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALL_JOBS, requiredJobs } from './classify.mjs';

const GATE = process.env.GATE_MODULE ?? fileURLToPath(new URL('./gate.mjs', import.meta.url));
const needs = (lane, over = {}, laneOut = lane) => {
  const req = new Set(requiredJobs(lane));
  const n = Object.fromEntries(ALL_JOBS.map((j) => [j, { result: over[j] ?? (req.has(j) ? 'success' : 'skipped'), outputs: {} }]));
  n.classify.outputs = { lane: laneOut };
  return n;
};
const run = (NEEDS, EVENT = 'pull_request', extra = {}) => spawnSync('node', [GATE], {
  env: { PATH: process.env.PATH, NEEDS: typeof NEEDS === 'string' ? NEEDS : JSON.stringify(NEEDS), EVENT, ...extra }, encoding: 'utf8',
});

test('gate CLI: a docs pull request and a full run pass, printing every job', () => {
  const docs = run(needs('docs'));
  assert.equal(docs.status, 0, docs.stdout);
  for (const j of ALL_JOBS) assert.match(docs.stdout, new RegExp(`^${j}: `, 'm'));
  assert.equal(run(needs('full')).status, 0);
  assert.equal(run(needs('full'), 'push').status, 0);
});
test('gate CLI: the lane comes ONLY from the classify job output (a forged, malformed or missing lane fails)', () => {
  for (const forged of ['DOCS', 'targeted', '', 'docs\nfull']) assert.notEqual(run(needs('docs', {}, forged)).status, 0, forged);
  const n = needs('docs'); delete n.classify.outputs;
  assert.notEqual(run(n).status, 0);
  const noClassify = needs('docs'); delete noClassify.classify;
  assert.notEqual(run(noClassify).status, 0);
  assert.notEqual(run(needs('docs', { classify: 'failure' })).status, 0);
});
test('gate CLI: a failed, cancelled, skipped or missing job, a job outside the lane, a docs push or the override fails', () => {
  assert.notEqual(run(needs('full', { 'e2e-real-broker': 'skipped' })).status, 0);
  assert.notEqual(run(needs('full', { node: 'cancelled' })).status, 0);
  assert.notEqual(run(needs('docs', { 'repo-checks': 'failure' })).status, 0);
  assert.notEqual(run(needs('docs', { images: 'failure' })).status, 0);
  assert.notEqual(run(needs('docs', { images: 'success' })).status, 0);
  const missing = needs('full'); delete missing.infra;
  assert.notEqual(run(missing).status, 0);
  assert.notEqual(run(needs('docs'), 'push').status, 0);
  assert.notEqual(run(needs('docs'), '').status, 0);
  assert.notEqual(run(needs('docs'), 'pull_request', { CI_FORCE_FULL: '1' }).status, 0);
  assert.equal(run(needs('full'), 'pull_request', { CI_FORCE_FULL: '1' }).status, 0);
});
test('gate CLI: unreadable input fails (never a pass by default)', () => {
  for (const bad of ['', 'not json', '[]', 'null', '42', '{}']) assert.notEqual(run(bad).status, 0, JSON.stringify(bad));
  assert.notEqual(spawnSync('node', [GATE], { env: { PATH: process.env.PATH }, encoding: 'utf8' }).status, 0, 'no environment');
});
