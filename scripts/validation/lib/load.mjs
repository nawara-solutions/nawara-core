// Stage 15.8 load generator (test-only, no dependency): fixed concurrency for a fixed duration after a warm-up, over keep-alive
// connections (as a gateway or a service client would hold them). Records every response's latency and status AFTER the warm-up.
// Deliberately small: throughput, latency percentiles and status counts are all Stage 15.8 needs.
import http from 'node:http';
import * as h from './harness.mjs';

/**
 * `next()` returns `{ name, method, url, headers?, body? }` for each request (a mix is a `next` that picks). `ok(status, name)` says
 * which statuses count as success (default 2xx). Latency is from write to the last response byte.
 */
export async function runLoad({ next, concurrency, durationMs, warmupMs = 5000, ok = (s) => s >= 200 && s < 300, timeoutMs = 30_000 }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const tWarm = h.now();
  const tStart = tWarm + warmupMs;
  const tEnd = tStart + durationMs;
  const byName = {};
  const all = [];
  const statuses = {};
  let errors = 0;
  const one = (r) =>
    new Promise((resolve) => {
      const data = r.body === undefined ? undefined : JSON.stringify(r.body);
      const t = h.now();
      const req = http.request(r.url, {
        method: r.method, agent, timeout: timeoutMs,
        headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...(r.headers ?? {}) },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, ms: h.now() - t, t }));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'CLIENT_TIMEOUT' })));
      req.on('error', (e) => resolve({ status: e.code ?? 'error', ms: h.now() - t, t }));
      if (data) req.write(data);
      req.end();
    });
  const worker = async () => {
    while (h.now() < tEnd) {
      const r = next();
      const res = await one(r);
      if (res.t < tStart || res.t >= tEnd) continue;
      const b = (byName[r.name] ??= { lat: [], errors: 0, statuses: {} });
      b.lat.push(res.ms);
      b.statuses[res.status] = (b.statuses[res.status] ?? 0) + 1;
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      all.push(res.ms);
      if (!ok(res.status, r.name)) {
        b.errors++;
        errors++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  agent.destroy();
  const sum = (lat, errs) => {
    const s = [...lat].sort((a, b) => a - b);
    const p = (q) => (s.length ? h.round(s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))], 2) : null);
    return { requests: s.length, rps: h.round(s.length / (durationMs / 1000), 1), p50: p(50), p95: p(95), p99: p(99), max: s.length ? h.round(s.at(-1), 1) : null, errorRate: s.length ? h.round(errs / s.length, 4) : null };
  };
  return {
    ...sum(all, errors), statuses,
    byName: Object.fromEntries(Object.entries(byName).map(([n, b]) => [n, { ...sum(b.lat, b.errors), statuses: b.statuses }])),
  };
}

/** Median of a numeric field across runs, with the range. */
export const medianOf = (runs, f) => {
  const xs = runs.map(f).filter((x) => typeof x === 'number');
  const s = [...xs].sort((a, b) => a - b);
  return { median: s.length ? s[Math.floor(s.length / 2)] : null, min: s[0] ?? null, max: s.at(-1) ?? null };
};
