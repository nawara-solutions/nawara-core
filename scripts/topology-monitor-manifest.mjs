#!/usr/bin/env node
// Core V2 OD-BRK-2b-I: generates the canonical topology-monitor installation manifest OFF the server (docs/runbooks/rabbitmq-topology-
// containment.md §2). The Owner runs it on a trusted machine at the approved commit, reviews it, and signs it there:
//   node scripts/topology-monitor-manifest.mjs --commit <40-hex commit> --version <n> > manifest
//   ssh-keygen -Y sign -f <owner key> -n nawara-core-topology-install manifest
// Contract v2 (OD-BRK-2b-A): fourteen artifacts, the external alert carrier and its units included; never a credential.
// Every hash is computed from the GIT OBJECTS of that commit (`git cat-file blob <commit>:<path>`), never from a working tree, so the
// manifest names exactly the reviewed artifacts. It reads nothing else and writes only the manifest to stdout.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MANIFEST_ARTIFACTS = [
  ['verify-and-contain.sh', 'infra/rabbitmq/topology-monitor/verify-and-contain.sh'],
  ['topology-watchdog.sh', 'infra/rabbitmq/topology-monitor/topology-watchdog.sh'],
  ['topology-trigger.sh', 'infra/rabbitmq/topology-monitor/topology-trigger.sh'],
  ['recover-notification-topology.sh', 'infra/rabbitmq/topology-monitor/recover-notification-topology.sh'],
  ['install-topology-monitor.sh', 'infra/rabbitmq/topology-monitor/install-topology-monitor.sh'],
  ['verify-topology-monitor-install.sh', 'infra/rabbitmq/topology-monitor/verify-topology-monitor-install.sh'],
  ['topology-alert-carrier.sh', 'infra/rabbitmq/topology-monitor/topology-alert-carrier.sh'],
  ['verify-topology.sh', 'infra/rabbitmq/verify-topology.sh'],
  ['nawara-core-topology-monitor.service', 'infra/rabbitmq/topology-monitor/nawara-core-topology-monitor.service'],
  ['nawara-core-topology-monitor.timer', 'infra/rabbitmq/topology-monitor/nawara-core-topology-monitor.timer'],
  ['nawara-core-topology-watchdog.service', 'infra/rabbitmq/topology-monitor/nawara-core-topology-watchdog.service'],
  ['nawara-core-topology-watchdog.timer', 'infra/rabbitmq/topology-monitor/nawara-core-topology-watchdog.timer'],
  ['nawara-core-topology-alert.service', 'infra/rabbitmq/topology-monitor/nawara-core-topology-alert.service'],
  ['nawara-core-topology-alert.timer', 'infra/rabbitmq/topology-monitor/nawara-core-topology-alert.timer'],
];
export const STATE_SCHEMA = 2;

/** The canonical manifest text for `hashes` (artifact name -> SHA-256), in the fixed order the installer requires. */
export function manifestText({ commit, version, schema = STATE_SCHEMA, hashes }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('commit must be a full 40-hex commit id');
  if (!Number.isInteger(version) || version < 1 || version > 999999) throw new Error('version must be an integer from 1 to 999999');
  const lines = ['nawara-core-topology-monitor-manifest v2', `core_commit=${commit}`, `version=${version}`, `state_schema=${schema}`];
  for (const [name] of MANIFEST_ARTIFACTS) {
    if (!/^[0-9a-f]{64}$/.test(hashes[name] ?? '')) throw new Error(`no SHA-256 for ${name}`);
    lines.push(`file=${hashes[name]} ${name}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The manifest of a commit: every artifact hashed from that commit's Git objects. */
export function manifestOfCommit({ commit, version, cwd }) {
  const resolved = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd, encoding: 'utf8' }).trim();
  if (resolved !== commit) throw new Error(`${commit} is not a full commit id (it resolves to ${resolved})`);
  const hashes = Object.fromEntries(MANIFEST_ARTIFACTS.map(([name, path]) => [name, createHash('sha256').update(execFileSync('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd })).digest('hex')]));
  return manifestText({ commit, version, hashes });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (args.length !== 4 || !get('--commit') || !get('--version')) {
    process.stderr.write('usage: node scripts/topology-monitor-manifest.mjs --commit <40-hex commit> --version <n>\n');
    process.exit(2);
  }
  process.stdout.write(manifestOfCommit({ commit: get('--commit'), version: Number(get('--version')), cwd: process.cwd() }));
}
