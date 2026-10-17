// Core V2 M2 T7: the manual backup's destination check, exactly as .github/workflows/core-backup.yml carries it and run as GitHub runs a
// `run:` step (bash --noprofile --norc -eo pipefail), with SYNTHETIC values only. It must pass exactly one IPv4 address inside the tailnet
// range 100.64.0.0/10 and one TCP port, and refuse everything else BEFORE the tailnet join and the SSH step: a host name, a list (drone-ssh
// would connect to every host of a comma-separated value), whitespace, a port suffix (drone-ssh would take that port), a URL, a LAN or
// public address. It prints PASS/FAIL lines only, never the value. Nothing is contacted: no network, no production value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { BACKUP_DESTINATION_ENV, BACKUP_JOB, BACKUP_SSH_WITH, BACKUP_WORKFLOW } from '../lib/checks.mjs';

const job = parse(readFileSync(new URL(`../../.github/workflows/${BACKUP_WORKFLOW}`, import.meta.url), 'utf8')).jobs[BACKUP_JOB];
const CHECK = job.steps.find((s) => s.name === 'Validate the private backup destination');
const SSH = job.steps.find((s) => String(s.uses ?? '').startsWith('appleboy/ssh-action'));
const PORT = '2222';

function runCheck(env) {
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', CHECK.run], { env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const assertOnlyStatus = (out) => { for (const line of out.trim().split('\n')) assert.match(line, /^(PASS |::error::FAIL )/, line); };

test('T7: the destination check reads the very values the SSH step connects to', () => {
  assert.deepEqual(CHECK.env, BACKUP_DESTINATION_ENV);
  assert.equal(SSH.with.host, CHECK.env.TS_BACKUP_HOST);
  assert.equal(SSH.with.port, CHECK.env.DEPLOY_SSH_PORT);
  assert.equal(SSH.with.host, BACKUP_SSH_WITH.host);
});

test('T7: one tailnet IPv4 address and one TCP port pass, and are never printed', () => {
  for (const host of ['100.64.0.1', '100.100.100.100', '100.127.255.254']) {
    for (const port of ['22', PORT, '65535']) {
      const r = runCheck({ TS_BACKUP_HOST: host, DEPLOY_SSH_PORT: port });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /PASS destination: one tailnet IPv4 address\nPASS port: one TCP port/);
      assert.ok(!r.out.includes(host), r.out);
      assertOnlyStatus(r.out);
    }
  }
});

test('T7: a name, a list, whitespace, a port suffix, a URL, a LAN or public address is refused before anything is contacted', () => {
  const hosts = [
    '', '192.168.1.20', '10.0.0.5', '172.16.0.1', '203.0.113.7', '8.8.8.8', '127.0.0.1', '0.0.0.0', '100.63.255.255', '100.128.0.1',
    '100.064.0.1', '100.64.0.1,203.0.113.7', '203.0.113.7,100.64.0.1', '100.64.0.1,100.64.0.2', '100.64.0.1 203.0.113.7', ' 100.64.0.1',
    '100.64.0.1 ', '100.64.0.1\n', '\t100.64.0.1', '100.64.0.1:2222', '100.64.0.1:22', '[100.64.0.1]', 'ssh://100.64.0.1', 'user@100.64.0.1',
    '100.64.0.1/32', '100.64.0.1/10', 'fd7a:115c:a1e0::1', '::ffff:100.64.0.1', 'server1', 'server1.example', 'server1.tailnet.ts.net',
    '100.64.1', '1681915905', '0x64400001',
  ];
  for (const host of hosts) {
    const r = runCheck({ TS_BACKUP_HOST: host, DEPLOY_SSH_PORT: PORT });
    assert.equal(r.status, 1, `${JSON.stringify(host)}: ${r.out}`);
    assert.match(r.out, /::error::FAIL destination: [^\n]*nothing was sent to the server/, JSON.stringify(host));
    assert.doesNotMatch(r.out, /PASS port/, 'it stops at the first failure');
    if (host.trim().length > 3) assert.ok(!r.out.includes(host.trim()), r.out);
    assertOnlyStatus(r.out);
  }
  const unset = runCheck({ DEPLOY_SSH_PORT: PORT });
  assert.equal(unset.status, 1, 'an unset TS_BACKUP_HOST is refused');
});

test('T7: a missing, malformed or multiple port is refused', () => {
  for (const port of ['', '0', '022', '65536', '99999', '22a', '-1', ' 22', '22 ', '2222\n', '22,2222', '22:2222', '0x16', '2e3']) {
    const r = runCheck({ TS_BACKUP_HOST: '100.64.0.1', DEPLOY_SSH_PORT: port });
    assert.equal(r.status, 1, `${JSON.stringify(port)}: ${r.out}`);
    assert.match(r.out, /PASS destination[\s\S]*::error::FAIL port: [^\n]*nothing was sent to the server/, JSON.stringify(port));
    assertOnlyStatus(r.out);
  }
  assert.equal(runCheck({ TS_BACKUP_HOST: '100.64.0.1' }).status, 1, 'an unset DEPLOY_SSH_PORT is refused');
});
