// Core V2 Smart CI (Stage 1): the verdict of `core-ci-passed`. It reads the workflow's `needs` (NEEDS = toJSON(needs)), the event and the
// CI_FORCE_FULL override, takes the lane from the `classify` job's output, and applies `gate()`: the lane's required jobs succeeded, every
// other job was skipped, nothing is missing, unknown, failed or cancelled. Anything unreadable fails. Exit 0 only on a pass.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate } from './classify.mjs';

/** The verdict for one run, from the step's environment. Never throws. */
export function decide(env) {
  let needs;
  try { needs = JSON.parse(env.NEEDS ?? ''); } catch { return { ok: false, lines: ['NEEDS is not JSON'] }; }
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) return { ok: false, lines: ['NEEDS is not an object'] };
  try {
    return gate({ lane: needs.classify?.outputs?.lane, classifyResult: needs.classify?.result, needs, event: env.EVENT, forceFull: env.CI_FORCE_FULL });
  } catch (e) {
    return { ok: false, lines: [`gate failed: ${String(e?.message ?? e)}`] };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ok, lines } = decide(process.env);
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write(ok ? 'core-ci-passed: every job the lane requires succeeded; every other job was skipped\n' : 'core-ci-passed: FAILED\n');
  process.exitCode = ok ? 0 : 1;
}
