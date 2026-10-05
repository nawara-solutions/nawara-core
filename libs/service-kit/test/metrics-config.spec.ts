import { describe, expect, it } from 'vitest';
import { ConfigError, EnvReader, loadBaseConfig, loadMetricsConfig } from '../src/index.js';

const load = (env: NodeJS.ProcessEnv, appPort = 3000, nodeEnv = 'production') => loadMetricsConfig(new EnvReader(env), appPort, nodeEnv);

describe('metrics configuration (V2 A12.2)', () => {
  it('is off, loopback and 9464 by default', () => {
    expect(load({})).toEqual({ enabled: false, host: '127.0.0.1', port: 9464 });
    expect(loadBaseConfig('probe-service', {}).metrics).toEqual({ enabled: false, host: '127.0.0.1', port: 9464 });
  });

  it('accepts an explicit enablement and an explicit IP literal (all interfaces only when written out)', () => {
    expect(load({ METRICS_ENABLED: 'true', METRICS_HOST: '0.0.0.0', METRICS_PORT: '9100' })).toEqual({ enabled: true, host: '0.0.0.0', port: 9100 });
    expect(load({ METRICS_HOST: '::1' }).host).toBe('::1');
  });

  it('refuses a hostname, a malformed flag, a privileged or out-of-range port, and the application port', () => {
    expect(() => load({ METRICS_HOST: 'localhost' })).toThrow(ConfigError);
    expect(() => load({ METRICS_HOST: 'metrics.example.com' })).toThrow(/IP address/);
    expect(() => load({ METRICS_ENABLED: 'yes' })).toThrow(ConfigError);
    expect(() => load({ METRICS_PORT: '80' })).toThrow(/1024/);
    expect(() => load({ METRICS_PORT: '70000' })).toThrow(ConfigError);
    expect(() => load({ METRICS_PORT: '3000' })).toThrow(/differ from PORT/);
    expect(() => loadBaseConfig('probe-service', { PORT: '9464' })).toThrow(/differ from PORT/);
  });

  it('validates the values even while disabled (fails closed at start-up)', () => {
    expect(() => load({ METRICS_ENABLED: 'false', METRICS_HOST: 'not-an-ip' })).toThrow(ConfigError);
  });

  it('an ephemeral port only under NODE_ENV=test', () => {
    expect(load({ METRICS_PORT: '0' }, 3000, 'test').port).toBe(0);
    expect(() => load({ METRICS_PORT: '0' }, 3000, 'production')).toThrow(/NODE_ENV=test/);
    expect(() => load({ METRICS_PORT: '0' }, 3000, 'development')).toThrow(/NODE_ENV=test/);
  });
});
