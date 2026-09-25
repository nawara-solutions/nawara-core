import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { generateServiceToken } from '@nawara/service-kit';

/**
 * Stage 17.9 operational probes (not part of `test` / `test:e2e`; run with `npm run test:ops`). The service runs as the BUILT process
 * (`dist/main.js`, what the image runs), so its CPU, memory and descriptors are read from `/proc/<pid>` without the load client in
 * the measurement. Linux only (the probes skip elsewhere).
 */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLK_TCK = 100; // Linux USER_HZ

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

export interface Service {
  base: string;
  port: number;
  pid: number;
  child: ChildProcess;
  lines: () => string[];
  /** Sends `signal` and resolves with the exit and how long it took. */
  stop: (signal?: NodeJS.Signals) => Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
}

export const OPS_KEYS = { FILE_REQUEST_HASH_KEY: randomBytes(32).toString('base64'), FILE_RATE_LIMIT_KEY: randomBytes(32).toString('base64') };
export const CALLER = generateServiceToken();
export const OPS_POLICY = JSON.stringify({
  callers: { 'ops-probe': { operations: ['upload', 'read', 'attach', 'delete', 'issue_ticket'], organizations: 'request', mediaTypes: ['application/pdf', 'image/png'], maxBytes: 100 * 1024 * 1024 } },
});

/** Starts the built service with `env` on top of a development baseline (filesystem store allowed; cleanup off unless asked). */
export async function startService(env: Record<string, string>, entry = 'dist/main.js'): Promise<Service> {
  const port = await freePort();
  const out: string[] = [];
  let partial = '';
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '', NODE_ENV: 'development', PORT: String(port), LOG_LEVEL: 'info',
      SERVICE_TOKENS: `ops-probe:${CALLER.digest}`, FILE_SERVICE_POLICY: OPS_POLICY, FILE_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      FILE_CLEANUP_ENABLED: 'false', FILE_MAX_BYTES: String(100 * 1024 * 1024), ...OPS_KEYS, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (d: Buffer) => {
    const parts = (partial + d.toString('utf8')).split('\n');
    partial = parts.pop() ?? '';
    out.push(...parts.filter(Boolean));
  };
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`service exited during startup:\n${out.join('\n')}`);
    try {
      if ((await fetch(`${base}/health`)).status === 200) break;
    } catch {
      /* not yet */
    }
    if (i > 150) throw new Error(`service not healthy:\n${out.join('\n')}`);
    await sleep(100);
  }
  return {
    base, port, pid: child.pid!, child, lines: () => out,
    stop: async (signal = 'SIGTERM') => {
      const t0 = Date.now();
      child.kill(signal);
      const r = await exited;
      return { ...r, ms: Date.now() - t0 };
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** CPU seconds (user + system), resident and peak-resident memory (bytes), open descriptors of `pid`. */
export function procStats(pid: number): { cpuSec: number; rss: number; hwm: number; fds: number } {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const cpuSec = (Number(fields[11]) + Number(fields[12])) / CLK_TCK; // utime, stime (fields 14, 15)
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(status)?.[1] ?? 0) * 1024;
  let fds = 0;
  try {
    fds = readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    /* exited */
  }
  return { cpuSec, rss: kb('VmRSS'), hwm: kb('VmHWM'), fds };
}

/** Samples `pid` every `everyMs` while `work` runs: peak RSS, peak descriptors, CPU used, and /health latencies meanwhile. */
export async function measure<T>(svc: Service, work: () => Promise<T>, everyMs = 50): Promise<{ result: T; wallMs: number; cpuSec: number; rssStart: number; rssPeak: number; fdsPeak: number; healthMs: number[] }> {
  const s0 = procStats(svc.pid);
  let rssPeak = s0.rss;
  let fdsPeak = s0.fds;
  const healthMs: number[] = [];
  let done = false;
  const sampler = (async () => {
    while (!done) {
      const s = procStats(svc.pid);
      rssPeak = Math.max(rssPeak, s.rss);
      fdsPeak = Math.max(fdsPeak, s.fds);
      await sleep(everyMs);
    }
  })();
  const prober = (async () => {
    while (!done) {
      const t = performance.now();
      try {
        await fetch(`${svc.base}/health`);
        healthMs.push(performance.now() - t);
      } catch {
        healthMs.push(Number.POSITIVE_INFINITY);
      }
      await sleep(100);
    }
  })();
  const t0 = performance.now();
  const result = await work();
  const wallMs = performance.now() - t0;
  done = true;
  await Promise.all([sampler, prober]);
  const s1 = procStats(svc.pid);
  return { result, wallMs, cpuSec: s1.cpuSec - s0.cpuSec, rssStart: s0.rss, rssPeak, fdsPeak, healthMs };
}

export interface Fetched {
  status: number;
  bytes: number;
  ms: number;
  complete: boolean;
  headers: IncomingHttpHeaders;
  body?: string;
}

/**
 * A streaming GET that discards the body (the client never holds a file). `pauseMs` pauses after the first chunk (a slow reader);
 * `abortAfterFirstChunk` disconnects; `readRateBytesPerSec` throttles consumption.
 */
export function get(url: string, headers: Record<string, string> = {}, opts: { pauseMs?: number; abortAfterFirstChunk?: boolean; readRateBytesPerSec?: number; keepBody?: boolean } = {}): Promise<Fetched> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let bytes = 0;
    let first = true;
    let settled = false;
    let body = '';
    const req = httpRequest(url, { method: 'GET', headers, agent: false }, (res) => {
      const done = (complete: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, bytes, ms: performance.now() - t0, complete, headers: res.headers, body: opts.keepBody ? body : undefined });
      };
      res.on('data', (c: Buffer) => {
        bytes += c.length;
        if (opts.keepBody && body.length < 4096) body += c.toString('utf8');
        if (first) {
          first = false;
          if (opts.abortAfterFirstChunk) {
            req.destroy();
            return done(false);
          }
          if (opts.pauseMs) {
            res.pause();
            setTimeout(() => res.resume(), opts.pauseMs);
          }
        }
        if (opts.readRateBytesPerSec) {
          res.pause();
          setTimeout(() => res.resume(), Math.ceil((c.length / opts.readRateBytesPerSec!) * 1000));
        }
      });
      res.on('end', () => done(res.complete));
      res.on('aborted', () => done(false));
      res.on('error', () => done(false));
      res.on('close', () => done(res.complete));
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      resolve({ status: 0, bytes, ms: performance.now() - t0, complete: false, headers: {} });
    });
    req.end();
  });
}

/** A raw-body POST/PUT (uploads). */
export function send(url: string, method: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; json: Record<string, unknown>; ms: number }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = httpRequest(url, { method, headers: { 'content-length': String(body.length), ...headers }, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>;
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, json, ms: performance.now() - t0 });
      });
    });
    req.on('error', () => resolve({ status: 0, json: {}, ms: performance.now() - t0 }));
    req.end(body);
  });
}

export const auth = { authorization: `Bearer ${CALLER.token}` };

export function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

export const MiB = 1024 * 1024;
export const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : 'inf');

/** A PDF-signature payload of `size` bytes (random tail: incompressible, like real documents). */
export function pdf(size: number): Buffer {
  const head = Buffer.from('%PDF-1.7\n', 'latin1');
  return Buffer.concat([head, randomBytes(Math.max(0, size - head.length))]);
}

/** Appends one line to the report file named by OPS_REPORT (and the console). */
export function report(line: string): void {
  console.log(line);
  if (process.env.OPS_REPORT) appendFileSync(process.env.OPS_REPORT, `${line}\n`);
}

export type FaultMode = 'normal' | 'delay' | 'refuse' | 'hang';

/** A TCP proxy in front of the S3 test server whose behaviour can be switched: normal, delayed, refusing, or accepting and hanging. */
export class FaultProxy {
  mode: FaultMode = 'normal';
  delayMs = 0;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  port = 0;

  constructor(private readonly target: { host: string; port: number }) {
    this.server = createServer((client) => {
      this.sockets.add(client);
      client.on('close', () => this.sockets.delete(client));
      client.on('error', () => undefined);
      if (this.mode === 'refuse') return void client.destroy();
      if (this.mode === 'hang') return; // accepted, never answered
      const upstream = connect(this.target.port, this.target.host);
      this.sockets.add(upstream);
      upstream.on('close', () => this.sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      // Order-preserving relay: every chunk (and the end) goes through one chain per direction, delayed or not.
      const relay = (from: Socket, to: Socket) => {
        let chain = Promise.resolve();
        from.on('data', (d) => {
          from.pause();
          chain = chain.then(async () => {
            if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
            if (!to.destroyed) to.write(d);
            from.resume();
          });
        });
        from.on('end', () => {
          chain = chain.then(() => {
            if (!to.destroyed) to.end();
          });
        });
      };
      relay(client, upstream);
      relay(upstream, client);
    });
  }

  async start(): Promise<void> {
    this.port = await freePort();
    await new Promise<void>((r) => this.server.listen(this.port, '127.0.0.1', r));
  }

  /** Cuts every open connection (a network partition), keeping the listener in its current mode. */
  cut(): void {
    for (const s of this.sockets) s.destroy();
  }

  async stop(): Promise<void> {
    this.cut();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
