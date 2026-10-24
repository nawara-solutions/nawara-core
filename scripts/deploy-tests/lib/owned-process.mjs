// Core V2 OD-BRK-2a: bounded lifecycle helpers for the real-broker drivers. Each one acts only on what the caller hands it (one child this
// test spawned, the steps of its own cleanup): never a process group, a name pattern or anything the test did not create.

/** A child that already exited, normally (`exitCode`) or by a signal (`signalCode`: e.g. NestJS re-raises SIGTERM after its hooks). */
export const exited = (child) => child.exitCode !== null || child.signalCode !== null;

/** `p`, or a rejection naming `what` after `ms`: no wait in a driver is unbounded. The timer never keeps the process alive. */
export const bounded = (p, ms, what) => {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no result within ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(p), late]).finally(() => clearTimeout(timer));
};

/**
 * Stops ONE child this test spawned: SIGTERM, a bounded grace period, then SIGKILL of that same child only. Never waits for an exit that
 * already happened. Resolves { already } or { code, signal, escalated }; rejects only if the child survives SIGKILL.
 */
export async function stopChild(child, { graceMs = 10_000, killMs = 5_000 } = {}) {
  if (!child || exited(child)) return { already: true };
  const gone = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const within = (ms) => Promise.race([gone, new Promise((resolve) => setTimeout(resolve, ms).unref())]);
  child.kill('SIGTERM');
  let r = await within(graceMs);
  if (r) return { ...r, escalated: false };
  child.kill('SIGKILL');
  r = await within(killMs);
  if (r) return { ...r, escalated: true };
  throw new Error(`child ${child.pid} did not exit after SIGKILL`);
}

/** Runs EVERY step (each bounded), even after one fails, then throws one AggregateError naming the failed steps. */
export async function cleanupAll(steps, ms = 30_000) {
  const errors = [];
  for (const [what, fn] of steps) {
    try {
      await bounded(fn(), ms, what);
    } catch (e) {
      errors.push(new Error(`${what}: ${e?.message ?? e}`));
    }
  }
  if (errors.length) throw new AggregateError(errors, `cleanup: ${errors.map((e) => e.message).join('; ')}`);
}

/** `fn`, then `cleanup` always; a cleanup failure never replaces the original failure (it is attached to it as `cleanupError`). */
export async function withCleanup(fn, cleanup) {
  let result;
  try {
    result = await fn();
  } catch (failure) {
    try {
      await cleanup();
    } catch (c) {
      if (failure !== null && typeof failure === 'object') failure.cleanupError = c;
    }
    throw failure;
  }
  await cleanup();
  return result;
}
