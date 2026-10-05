/**
 * V2 A12.2: the ONE module that imports the metrics client library. `check:repo` refuses an import of it anywhere outside
 * `src/metrics/`, so every metric is created through `BoundedMetrics` and its closed label policy, never with a raw constructor.
 */
export { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
