import 'reflect-metadata';
import { Module, type INestApplication, type ModuleMetadata } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { EVENT_BUS, HealthModule, JsonLogger, MetricsHost, OutboxRelayService } from '../src/index.js';
import { installMetrics } from '../src/metrics/install.js';

/**
 * V2 A12.3 post-certification correction (found by A12.5.1): `installMetrics` with an OPTIONAL provider absent, on an application
 * built the way every service's `main.ts` builds it: `NestFactory.create` with Nest's default `abortOnError: true`. Nest then wraps
 * the application in a proxy that runs each method in its exception zone, where a failed lookup is logged and `process.exit(1)` is
 * called. The A12.3 tests used `Test.createTestingModule`, which has no such proxy, so they could not see audit-service and
 * notification-service (no kit `EVENT_BUS`, no outbox relay) exit when METRICS_ENABLED is on.
 *
 * `process.exit` is replaced by a recorder that throws, so a regression is an assertion failure here instead of the end of the run.
 */
class ExitCalled extends Error {}

const config = (enabled: boolean) => ({ serviceName: 'probe-service', metrics: { enabled, host: '127.0.0.1', port: 0 } });
const logger = () => new JsonLogger('probe-service', 'error', () => undefined);

function moduleWith(metadata: ModuleMetadata): new () => unknown {
  @Module(metadata)
  class ProbeModule {}
  return ProbeModule;
}

describe('installMetrics on a NestFactory application (abortOnError: true, as in main.ts)', () => {
  let exit: MockInstance<typeof process.exit>;
  let app: INestApplication | undefined;
  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(`process.exit(${String(code)})`);
    });
  });
  afterEach(async () => {
    exit.mockRestore();
    await app?.close().catch(() => undefined);
    app = undefined;
  });
  const create = async (metadata: ModuleMetadata) => {
    app = await NestFactory.create(moduleWith(metadata), { logger: false }); // abortOnError left at Nest's default (true)
    return app;
  };

  it('A. optional providers absent: the application boots, nothing exits, and the metrics listener serves', async () => {
    const a = await create({ imports: [HealthModule.forRoot()] }); // no EVENT_BUS, no OutboxRelayService, no DbService
    installMetrics(a, config(true), logger());
    expect(exit).not.toHaveBeenCalled();
    const host = a.get(MetricsHost);
    expect(host.metrics).toBeDefined();
    const address = await host.address();
    const res = await fetch(`http://127.0.0.1:${address!.port}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^nawara_service_info\{service="probe-service"\} 1$/m);
  });

  it('B. optional providers present: the event bus and the outbox relay are observed, as before', async () => {
    const bus = { setObserver: vi.fn() };
    const relay = { setObserver: vi.fn() };
    const a = await create({
      imports: [HealthModule.forRoot()],
      providers: [{ provide: EVENT_BUS, useValue: bus }, { provide: OutboxRelayService, useValue: { relay } }],
    });
    installMetrics(a, config(true), logger());
    expect(exit).not.toHaveBeenCalled();
    expect(bus.setObserver).toHaveBeenCalledTimes(1);
    expect(relay.setObserver).toHaveBeenCalledTimes(1);
  });

  it('C. a REQUIRED provider missing still fails startup the Nest way (logged, process.exit(1)): nothing is suppressed', async () => {
    const a = await create({}); // no HealthModule: no MetricsHost, which installMetrics requires
    expect(() => installMetrics(a, config(true), logger())).toThrow(ExitCalled);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockClear();
    expect(() => a.get(Symbol('never registered'))).toThrow(ExitCalled); // the application's own lookups keep Nest's semantics
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('D. metrics disabled: nothing is installed or looked up, nothing exits', async () => {
    const a = await create({}); // not even HealthModule: with metrics off installMetrics touches nothing
    installMetrics(a, config(false), logger());
    expect(exit).not.toHaveBeenCalled();
  });
});
