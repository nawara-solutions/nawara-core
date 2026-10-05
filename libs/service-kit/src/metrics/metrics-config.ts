import { isIP } from 'node:net';
import { ConfigError, type EnvReader } from '../config/config.js';

export interface MetricsConfig {
  /** `METRICS_ENABLED` (default false): with it off, nothing is installed (no listener, middleware, collector or observer). */
  enabled: boolean;
  /** `METRICS_HOST`: an IP literal, loopback by default. Binding every interface (`0.0.0.0`) is only ever an explicit choice. */
  host: string;
  /** `METRICS_PORT`: never the application port. `0` (an ephemeral port) only under `NODE_ENV=test`. */
  port: number;
}

export const DEFAULT_METRICS_HOST = '127.0.0.1';
export const DEFAULT_METRICS_PORT = 9464;

/**
 * V2 A12.2: the metrics listener's configuration. Validated even while disabled, so a malformed value fails closed at start-up
 * instead of surprising the day metrics are switched on. A hostname is refused (an IP literal says exactly where it binds).
 */
export function loadMetricsConfig(reader: EnvReader, appPort: number, nodeEnv: string): MetricsConfig {
  const enabled = reader.bool('METRICS_ENABLED', false);
  const host = reader.get('METRICS_HOST') ?? DEFAULT_METRICS_HOST;
  if (isIP(host) === 0) throw new ConfigError('METRICS_HOST must be an IP address');
  const port = reader.int('METRICS_PORT', { default: DEFAULT_METRICS_PORT, min: 0, max: 65_535 });
  if (port === 0 ? nodeEnv !== 'test' : port < 1024) throw new ConfigError('METRICS_PORT must be between 1024 and 65535 (0 only under NODE_ENV=test)');
  if (port === appPort) throw new ConfigError('METRICS_PORT must differ from PORT');
  return { enabled, host, port };
}
