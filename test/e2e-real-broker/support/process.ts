import { spawn } from 'node:child_process';

export interface LiveService {
  stop(): Promise<void>;
  /** Stage 21.C.2: kills the process at once (SIGKILL: no shutdown hook, no drain), as a crash would. */
  kill(): Promise<void>;
  /** The last N lines of stdout+stderr, for a failure's diagnostic message — never asserted on, only printed. */
  tail(): string;
}

/**
 * Spawns a service's ALREADY-BUILT `dist/main.js` as its own OS process (`npm run build` must have run first) — never
 * imports the service's TypeScript, so this suite proves the real inter-process boundary (HTTP + the real broker),
 * not an in-process shortcut. `cwd` matches how the Dockerfile/Compose run it (`WORKDIR .../dist/..`'s parent).
 */
export function spawnService(name: string, cwd: string, env: NodeJS.ProcessEnv): LiveService {
  const lines: string[] = [];
  const push = (buf: Buffer) => {
    for (const line of buf.toString('utf8').split('\n')) if (line.trim()) lines.push(`[${name}] ${line}`);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  };
  const child = spawn('node', ['dist/main.js'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  return {
    tail: () => lines.join('\n'),
    async kill() {
      if (exited || child.exitCode !== null) return;
      const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await gone;
    },
    async stop() {
      if (exited || child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

/** Polls a condition until it returns true or the timeout elapses (mirrors `libs/service-kit/test/rabbitmq.int-spec.ts`'s helper). */
export async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, describe: string): Promise<void> {
  const end = Date.now() + ms;
  let lastError: unknown;
  while (Date.now() < end) {
    try {
      if (await cond()) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`condition not met in time: ${describe}${lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : ''}`);
}

export async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    try {
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  }, timeoutMs, `GET ${url} to return 2xx`);
}
