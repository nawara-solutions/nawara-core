import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, ServiceAuthModule } from '@nawara/service-kit';
import type { NotificationConfig } from './config/notification-config.js';

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never pass against a
 * differently wired application than the one that ships.
 *
 * Stage 16.3 (the foundation): the kit's health / readiness / bounded HTTP drain and service authentication, nothing else. There is
 * no business route yet. Readiness has no dependency check because the service has no dependency yet: the database arrives with
 * persistence (16.4), the RabbitMQ consumer with event intake (16.5), each registering its own readiness check then.
 */
@Module({})
export class AppModule {
  static register(config: NotificationConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule.forRoot({ httpDrainTimeoutMs: config.httpDrainTimeoutMs }), // Stage 15.5: bounded HTTP drain
        ServiceAuthModule.forRoot(config.serviceTokens),
      ],
    };
  }
}
