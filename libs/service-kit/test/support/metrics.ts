import { Controller, Get, Module, Param, Query, Redirect } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MetricsHost } from '../../src/index.js';

/** Routes carrying the kinds of values a metric label must never hold: identifiers, tokens, free path segments. */
@Controller('m')
export class MetricsProbeController {
  @Get('orgs/:organizationId/members/:memberId') member(@Param('organizationId') o: string, @Param('memberId') m: string) {
    return { o, m };
  }
  @Get('t/:token') ticket() {
    return { ok: true };
  }
  @Get('search') search(@Query('q') q: string) {
    return { q };
  }
  @Get('moved/:id') @Redirect('/m/search', 302) moved() {
    return {};
  }
  @Get('slow') async slow() {
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true };
  }
}

@Module({ controllers: [MetricsProbeController] })
export class MetricsProbeModule {}

/** Environment for a test app with metrics on: an ephemeral metrics port (allowed only under NODE_ENV=test), loopback. */
export const METRICS_ON = { NODE_ENV: 'test', METRICS_ENABLED: 'true', METRICS_PORT: '0' } as const;

export async function metricsUrl(app: NestExpressApplication): Promise<string> {
  const addr = await app.get(MetricsHost).address();
  if (!addr) throw new Error('the metrics listener is not running');
  return `http://127.0.0.1:${addr.port}`;
}

export async function scrape(app: NestExpressApplication): Promise<string> {
  const r = await fetch(`${await metricsUrl(app)}/metrics`);
  if (r.status !== 200) throw new Error(`scrape answered ${r.status}`);
  return r.text();
}

/** The label sets of every series of one metric (histogram buckets included when `name` is a `_bucket`). */
export function seriesOf(body: string, name: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const inner = line.startsWith(`${name}{`) ? line.slice(name.length + 1, line.indexOf('}')) : '';
    const labels: Record<string, string> = {};
    for (const m of inner.matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)) labels[m[1]!] = m[2]!;
    out.push(labels);
  }
  return out;
}

/** Every distinct label value anywhere in the exposition. */
export function allLabelValues(body: string): Set<string> {
  const values = new Set<string>();
  for (const m of body.matchAll(/[a-z_]+="((?:[^"\\]|\\.)*)"/g)) values.add(m[1]!);
  return values;
}
