import { Body, Controller, Get, HttpException, Inject, Post, UseGuards, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import {
  CallerService, HealthModule, JsonLogger, ReadinessRegistry, ServiceAuthModule, ServiceTokenGuard, configureApp, loadBaseConfig,
  type ServiceTokenEntry,
} from '../../src/index.js';

export class EchoDto {
  @IsString()
  name!: string;
}

@Controller('probe')
export class ProbeController {
  @Get('ok') ok() {
    return { ok: true };
  }
  @Get('conflict') conflict() {
    throw new HttpException('already exists', 409);
  }
  @Get('boom') boom() {
    // Looks like a database error: SQL text, a constraint name and a credential-bearing connection string.
    throw new Error('duplicate key value violates unique constraint "payment_idem_uk" for postgres://svc:hunter2@db:5432/payment');
  }
  @Post('echo') echo(@Body() dto: EchoDto) {
    return { name: dto.name };
  }
  @UseGuards(ServiceTokenGuard)
  @Get('service') service(@CallerService() caller: string) {
    return { caller };
  }
  constructor(@Inject(ReadinessRegistry) readonly registry: ReadinessRegistry) {}
}

export interface TestApp {
  app: NestExpressApplication;
  registry: ReadinessRegistry;
  logs: Record<string, any>[];
}

export async function createTestApp(opts: { tokens?: ServiceTokenEntry[]; extraImports?: any[]; env?: NodeJS.ProcessEnv } = {}): Promise<TestApp> {
  const logs: Record<string, any>[] = [];
  const config = loadBaseConfig('probe-service', { NODE_ENV: 'production', BODY_LIMIT_KB: '1', ...opts.env });
  const logger = new JsonLogger(config.serviceName, 'debug', (l) => logs.push(JSON.parse(l)));
  const moduleRef = await Test.createTestingModule({
    imports: [HealthModule.forRoot({ checkTimeoutMs: 200 }), ServiceAuthModule.forRoot(opts.tokens ?? []), ...(opts.extraImports ?? [])],
    controllers: [ProbeController as Type<unknown>],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, config, logger);
  await app.listen(0, '127.0.0.1'); // a real listener: parallel supertest bursts otherwise ECONNRESET
  return { app, registry: app.get(ReadinessRegistry), logs };
}
