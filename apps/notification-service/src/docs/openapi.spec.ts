import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '@nawara/service-kit';
import { SEND_FIELDS } from '../api/send-request.js';
import { AppModule } from '../app.module.js';
import { loadNotificationConfig } from '../config/notification-config.js';

/**
 * OpenAPI (repo rule: every controller method and DTO field documented). The document must build, document the three send-API
 * operations with bearer auth, `Idempotency-Key` on POST, and a request schema whose fields are EXACTLY the enforced ones.
 */
describe('OpenAPI document', () => {
  it('documents send, status and cancel, and the request schema equals the enforced request fields', async () => {
    const config = loadNotificationConfig({
      NODE_ENV: 'test', DATABASE_URL: 'postgres://notification_app:pw@127.0.0.1:1/notification', RABBITMQ_URL: 'amqp://127.0.0.1:1',
      NOTIFICATION_SECRET_KEYS: `k1:${randomBytes(32).toString('base64')}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1', NOTIFICATION_DEFAULT_LOCALE: 'en',
      NOTIFICATION_REQUEST_HASH_KEY: randomBytes(32).toString('base64'),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config, { bus: new InMemoryEventBus() })] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    await app.init();
    try {
      const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('notification-service API').setVersion('0.1.0').addBearerAuth().build());
      const expected: Array<[string, 'get' | 'post']> = [['/notification/notifications', 'post'], ['/notification/notifications/{id}', 'get'], ['/notification/notifications/{id}/cancel', 'post']];
      for (const [path, method] of expected) {
        const op = document.paths[path]?.[method];
        expect(op, `${method} ${path}`).toBeDefined();
        expect(op!.summary).toBeTruthy();
        expect(Object.keys(op!.responses ?? {})).toContain('401');
        expect(JSON.stringify(op!.security ?? [])).toContain('bearer');
      }
      expect(JSON.stringify(document.paths['/notification/notifications'].post!.parameters)).toContain('Idempotency-Key');
      expect(Object.keys(document.paths['/notification/notifications'].post!.responses)).toEqual(expect.arrayContaining(['202', '400', '403', '404', '422', '429']));
      // no list, search, admin or delete operation (SDD §7.2)
      expect(Object.keys(document.paths).filter((p) => p.startsWith('/notification')).sort()).toEqual(expected.map(([p]) => p).sort());
      const schemas = document.components?.schemas as Record<string, any>;
      expect(Object.keys(schemas.SendNotificationDto.properties).sort()).toEqual([...SEND_FIELDS].sort());
      expect(Object.keys(schemas.AcceptedDto.properties).sort()).toEqual(['deliveries', 'id', 'status']);
      expect(Object.keys(schemas.DeliveryViewDto.properties)).not.toContain('destination'); // a 2-character hint only
    } finally {
      await app.close();
    }
  });
});
