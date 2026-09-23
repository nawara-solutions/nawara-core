import { Injectable, Logger, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';

/**
 * Stage 14.7: marks the two ends of a graceful shutdown in the log, so what happens in between (worker and consumer drain timeouts,
 * each reported by its own component) can be read in context. Nest runs EVERY `onModuleDestroy` before any worker drains in
 * `beforeApplicationShutdown`, and runs this global module's `onApplicationShutdown` after the other modules' (the database pool and
 * the broker are closed by then). Two lines per shutdown; nothing per provider.
 */
@Injectable()
export class ShutdownNotice implements OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger('Lifecycle');

  onModuleDestroy(): void {
    this.logger.log('service_shutdown_started — draining workers and consumers, then closing dependencies');
  }

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`service_shutdown_complete signal=${signal ?? 'none'}`);
  }
}
