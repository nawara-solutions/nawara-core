// Core V2 OD-BRK-2a: the real-broker drivers' bounded lifecycle helpers (scripts/deploy-tests/lib/owned-process.mjs), on real children.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { bounded, cleanupAll, exited, stopChild, withCleanup } from './lib/owned-process.mjs';

/** A real node child running `code`; resolves once it printed `ready` (its handlers are installed). */
const child = async (code) => {
  const c = spawn(process.execPath, ['-e', `${code}; console.log('ready')`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(c.stdout, 'data');
  return c;
};
const quick = (p, ms = 3_000) => bounded(p, ms, 'stopChild');

test('a child that already exited NORMALLY is not waited for', async () => {
  const c = await child('setTimeout(() => process.exit(0), 50)');
  await once(c, 'exit');
  assert.equal(c.exitCode, 0);
  assert.ok(exited(c));
  assert.deepEqual(await quick(stopChild(c)), { already: true });
});

test('a child that already exited BY A SIGNAL (exitCode null, as NestJS re-raises SIGTERM) is not waited for: the OD-BRK-2a stall', async () => {
  const c = await child("process.once('SIGTERM', () => process.kill(process.pid, 'SIGTERM')); setInterval(() => {}, 1000)");
  c.kill('SIGTERM');
  await once(c, 'exit');
  assert.equal(c.exitCode, null);
  assert.equal(c.signalCode, 'SIGTERM');
  assert.ok(exited(c));
  assert.deepEqual(await quick(stopChild(c)), { already: true });
  assert.deepEqual(await quick(stopChild(c)), { already: true }, 'a second stop (the cleanup hook) is just as immediate');
});

test('a live child that honours SIGTERM is stopped without escalation', async () => {
  const c = await child('setInterval(() => {}, 1000)');
  const r = await quick(stopChild(c, { graceMs: 2_000 }));
  assert.deepEqual(r, { code: null, signal: 'SIGTERM', escalated: false });
  assert.ok(exited(c));
});

test('a child that IGNORES SIGTERM is killed (that child only) after the bounded grace period', async () => {
  const c = await child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
  const bystander = await child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
  const t0 = Date.now();
  const r = await quick(stopChild(c, { graceMs: 300 }));
  assert.deepEqual(r, { code: null, signal: 'SIGKILL', escalated: true });
  assert.ok(Date.now() - t0 >= 300 && Date.now() - t0 < 3_000);
  assert.ok(!exited(bystander), 'another child is never touched');
  bystander.kill('SIGKILL');
  await once(bystander, 'exit');
});

test('a cleanup failure never suppresses the original failure; every cleanup step runs, each bounded', async () => {
  const original = new assert.AssertionError({ message: 'the real assertion', actual: 'FAIL', expected: 'PASS', operator: 'strictEqual' });
  await assert.rejects(
    withCleanup(() => { throw original; }, async () => { throw new Error('unbind failed'); }),
    (e) => e === original && e.cleanupError?.message === 'unbind failed',
  );
  // without an original failure, the cleanup failure is the result
  await assert.rejects(withCleanup(async () => 1, async () => { throw new Error('unbind failed'); }), /unbind failed/);
  assert.equal(await withCleanup(async () => 7, async () => {}), 7);

  const ran = [];
  await assert.rejects(
    cleanupAll([
      ['stop notification', async () => { ran.push('stop'); throw new Error('boom'); }],
      ['a step that never settles', () => new Promise(() => {})],
      ['close broker connection', async () => { ran.push('close'); }],
    ], 200),
    (e) => e instanceof AggregateError && e.errors.length === 2 && /stop notification: boom/.test(e.message) && /never settles: no result within 200 ms/.test(e.message),
  );
  assert.deepEqual(ran, ['stop', 'close'], 'the connection is closed although earlier steps failed');
});
