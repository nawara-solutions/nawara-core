import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { loadOrganizationConfig } from '../config/organization-config.js';

/**
 * OpenAPI validation (repo rule: every controller method and DTO field carries @ApiOperation/@ApiResponse/@ApiProperty). The
 * document must BUILD, and every implemented operation must be present with a summary, at least one response, and its
 * documented request/response schemas. No database is touched: generation is pure reflection over the compiled module graph.
 */
describe('OpenAPI document', () => {
  it('builds, documents every implemented operation, and documents nothing that is deliberately absent', async () => {
    const config = loadOrganizationConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://organization_app:pw@localhost:5433/organization' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config)] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    await app.init();
    try {
      const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('organization-service API').setVersion('0.1.0').addBearerAuth().build());

      const expected: [string, 'get' | 'post' | 'patch'][] = [];
      for (const entity of ['companies', 'platforms', 'organizations']) {
        expected.push([`/organization/${entity}`, 'post'], [`/organization/${entity}`, 'get'], [`/organization/${entity}/{id}`, 'get'], [`/organization/${entity}/{id}`, 'patch']);
      }
      for (const [path, method] of expected) {
        const op = document.paths[path]?.[method];
        expect(op, `${method.toUpperCase()} ${path} is documented`).toBeDefined();
        expect(op!.summary, `${method.toUpperCase()} ${path} has a summary`).toBeTruthy();
        expect(Object.keys(op!.responses ?? {}).length, `${method.toUpperCase()} ${path} has a documented response`).toBeGreaterThan(0);
        expect(JSON.stringify(op!.security ?? []), `${method.toUpperCase()} ${path} declares bearer auth`).toContain('bearer');
        if (method === 'post') {
          expect(JSON.stringify(op!.parameters), `${path} documents Idempotency-Key`).toContain('Idempotency-Key');
          expect(op!.requestBody, `${path} documents its request body`).toBeDefined();
        }
      }
      // Deliberately absent: deletion (lifecycle undecided), membership (auth-service's), import/migration (a later stage).
      for (const [path, item] of Object.entries(document.paths)) {
        expect(Object.keys(item as object), path).not.toContain('delete');
        expect(path, path).not.toMatch(/member|import|migrat|cutover|user|auth/i);
      }
      // Every schema property is described by an @ApiProperty (a field without one would be undocumented).
      const schemas = document.components?.schemas ?? {};
      for (const name of ['CreateCompanyDto', 'CompanyDto', 'CreatePlatformDto', 'PlatformDto', 'CreateOrganizationDto', 'OrganizationDto']) expect(schemas[name], name).toBeDefined();
      expect(Object.keys((schemas.OrganizationDto as any).properties).sort()).toEqual(['address', 'createdAt', 'id', 'name', 'phone', 'platformId', 'taxCode', 'type', 'updatedAt']);
      expect(Object.keys((schemas.PlatformDto as any).properties).sort()).toEqual(['companyId', 'createdAt', 'id', 'key', 'name', 'updatedAt']);
      expect(Object.keys((schemas.CreatePlatformDto as any).properties).sort()).toEqual(['companyId', 'name']); // `key` is returned, never accepted
      expect(Object.keys((schemas.UpdatePlatformDto as any).properties)).toEqual(['name']);
    } finally {
      await app.close();
    }
  });
});
