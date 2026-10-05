import { Registry, collectDefaultMetrics } from './prom.js';

/**
 * V2 A12.2: the Node runtime metrics a Core service exposes, by their standard names (verified against prom-client 15.1.3). The
 * library's default collectors are registered into a private staging registry and only these are moved to the exposed one: per heap
 * space detail, active handles/requests/resources (internal, deprecated APIs), virtual memory and the heap-bytes duplicate are left out.
 */
export const RUNTIME_METRICS = [
  'process_cpu_seconds_total',
  'process_cpu_user_seconds_total',
  'process_cpu_system_seconds_total',
  'process_resident_memory_bytes',
  'process_start_time_seconds',
  'process_open_fds',
  'process_max_fds',
  'nodejs_heap_size_used_bytes',
  'nodejs_heap_size_total_bytes',
  'nodejs_external_memory_bytes',
  'nodejs_eventloop_lag_p50_seconds',
  'nodejs_eventloop_lag_p99_seconds',
  'nodejs_eventloop_lag_max_seconds',
  'nodejs_eventloop_lag_mean_seconds',
  'nodejs_gc_duration_seconds',
  'nodejs_version_info',
] as const;

/** Garbage-collection pause buckets (seconds), the library's defaults made explicit. */
export const GC_DURATION_BUCKETS = [0.001, 0.01, 0.1, 1, 2, 5];

export function registerRuntimeMetrics(target: Registry): void {
  const staging = new Registry();
  collectDefaultMetrics({ register: staging, eventLoopMonitoringPrecision: 10, gcDurationBuckets: GC_DURATION_BUCKETS });
  for (const name of RUNTIME_METRICS) {
    const metric = staging.getSingleMetric(name);
    if (metric) target.registerMetric(metric); // some are platform-specific (the fd metrics are Linux only)
  }
}
