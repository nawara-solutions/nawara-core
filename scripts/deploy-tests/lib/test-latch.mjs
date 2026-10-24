// Core V2 OD-BRK-2a: a TEST-ONLY containment latch for the real-broker drivers, in a directory the run owns. The verifier (L1) trusts only a
// regular file owned by uid 0 in a uid-0 directory that neither group nor other may write, so it is written ROOT-OWNED through the local
// Docker daemon (as the OD-BRK-2b installation will), never with host privileges, and never at the production path.
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

export const LATCH_IMAGE = 'rabbitmq:3.13.7-alpine@sha256:d7af1c87c5f1eda13fcfca06db452bf3aeab6619fc3358b68535c0c02c4e52bc';
const PRODUCTION_DIR = '/var/lib/nawara-core-topology';
export const LATCH_STATE = {
  inactive: 'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive',
  contained: 'nawara-core-topology-containment v1\nservice=notification-service\nstate=contained',
};

const sh = (dir, script, ...args) => execFileSync('docker', ['run', '--rm', '-v', `${dir}:/w`, '--entrypoint', 'sh', LATCH_IMAGE, '-c', script, ...args], {
  stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL',
});
const owned = (dir) => {
  if (!isAbsolute(dir) || resolve(dir).startsWith(PRODUCTION_DIR)) throw new Error(`refusing a latch outside the run's own directory: ${dir}`);
  return resolve(dir);
};

/** The latch file the verifier is pointed at (NOTIFICATION_CONTAINMENT_STATE) for a run directory. */
export const latchPath = (dir) => join(owned(dir), 'latch', 'notification-service.containment');

/** Writes `<dir>/latch/notification-service.containment` root-owned (directory 0755, file `mode`) with `content`. */
export function writeTestLatch(dir, content = LATCH_STATE.inactive, mode = '644') {
  sh(owned(dir), `rm -rf /w/latch && mkdir -m 755 /w/latch && printf '%s' "$0" > /w/latch/notification-service.containment && chmod ${mode} /w/latch/notification-service.containment`, content);
  return latchPath(dir);
}

/** Removes the root-owned latch directory (only `<dir>/latch`), so the run's directory can then be removed without privileges. */
export function removeTestLatch(dir) {
  sh(owned(dir), 'rm -rf /w/latch');
}
