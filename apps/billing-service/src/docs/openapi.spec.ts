import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { InMemoryEventBus, type AuthClient } from '@nawara/service-kit';
import { AppModule } from '../app.module.js';
import { loadBillingConfig } from '../config/billing-config.js';

const noopAuthClient: AuthClient = { getIdentity: async () => null, hasPlatformAccess: async () => false };

/**
 * OpenAPI validation (repo rule: every controller method and DTO field carries @ApiOperation/@ApiResponse/@ApiProperty):
 * the document must BUILD without throwing (SwaggerModule reflects every controller's decorators), and every
 * implemented operation must be present with a summary and at least one documented response. No real database is
 * touched: document generation is pure reflection over the compiled module graph.
 */
describe('OpenAPI document (Stage 3 + Stage 4)', () => {
  it('builds without throwing, and documents every implemented operation', async () => {
    const config = loadBillingConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://billing_app:pw@localhost:5433/billing',
      AUTH_SERVICE_URL: 'http://auth.invalid',
      BILLING_SUPPORTED_CURRENCIES: 'TND',
      PAYMENT_SERVICE_URL: 'http://payment.invalid',
      PAYMENT_SERVICE_TOKEN: 'test-only-payment-service-token-not-a-real-secret-000',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(config, { authClient: noopAuthClient, bus: new InMemoryEventBus() })],
    }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    await app.init();
    try {
      const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('billing-service API').setVersion('0.1.0').addBearerAuth().build());

      const expectedOperations: [string, 'get' | 'post'][] = [
        ['/billing/products', 'post'],
        ['/billing/products/{id}', 'get'],
        ['/billing/products/{id}/archive', 'post'],
        ['/billing/prices', 'post'],
        ['/billing/prices/{id}', 'get'],
        ['/billing/prices/{id}/retire', 'post'],
        ['/billing/invoices', 'post'],
        ['/billing/invoices', 'get'],
        ['/billing/invoices/{id}', 'get'],
        ['/billing/invoices/{id}/issue', 'post'],
        ['/billing/invoices/{id}/discard', 'post'],
        ['/billing/invoices/{invoiceId}/payment-requests', 'post'],
        ['/billing/payment-requests/{id}', 'get'],
        ['/billing/payment-requests/{id}/cancel', 'post'],
        ['/billing/organizations/{organizationId}/entitlement', 'get'],
      ];
      for (const [path, method] of expectedOperations) {
        const operation = document.paths[path]?.[method];
        expect(operation, `${method.toUpperCase()} ${path} is documented`).toBeDefined();
        expect(operation!.summary, `${method.toUpperCase()} ${path} has an @ApiOperation summary`).toBeTruthy();
        expect(Object.keys(operation!.responses ?? {}).length, `${method.toUpperCase()} ${path} has at least one @ApiResponse`).toBeGreaterThan(0);
      }

      // Endpoints not yet built (void, credit notes, entitlement — all blocked or Stage 8) must not appear.
      for (const notBuilt of ['/billing/invoices/{id}/void', '/billing/credit-notes', '/billing/licenses/{organizationId}/status']) {
        expect(document.paths[notBuilt], `${notBuilt} is not documented (not built)`).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });
});
