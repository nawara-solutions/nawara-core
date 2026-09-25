import { Body, Controller, ForbiddenException, Get, HttpException, Inject, Module, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import type { AuditConfig } from '../../src/config/audit-config.js';
import { AUDIT_CONFIG } from '../../src/config/audit-config.token.js';
import { AUDIT_OPERATIONS } from '../../src/policy/caller-policy.js';

class EchoDto {
  @IsString()
  @MaxLength(20)
  name!: string;
}

/**
 * TEST-ONLY routes (never part of the shipped application). The foundation has no business endpoint, so its service-token guard,
 * caller policy, error filter, validation, identifiers and HTTP drain are exercised through these probes, mounted next to the REAL
 * application module (the Billing Stage 1 / Notification 16.3 / File 17.2 pattern).
 */
@Controller('probe')
class ProbeController {
  constructor(@Inject(AUDIT_CONFIG) private readonly config: AuditConfig) {}

  @Get('service')
  @UseGuards(ServiceTokenGuard)
  service(@CallerService() caller: string) {
    return { caller };
  }

  /** The caller identity from the token, checked against the caller policy (deny by default), as the 18.6 query routes will do. */
  @Get('policy/read-organization')
  @UseGuards(ServiceTokenGuard)
  readOrganization(@CallerService() caller: string) {
    if (!this.config.callerPolicy.allows(caller, 'read_organization')) throw new ForbiddenException({ message: 'Operation not allowed for this caller.', code: 'operation_not_allowed' });
    return { caller, allowed: 'read_organization' };
  }

  /** What the policy grants this caller, derived from the token only (headers, query and body are never read). */
  @Get('policy/grants')
  @UseGuards(ServiceTokenGuard)
  grants(@CallerService() caller: string) {
    const p = this.config.callerPolicy.of(caller);
    return { caller, operations: AUDIT_OPERATIONS.filter((op) => this.config.callerPolicy.allows(caller, op)), categories: [...(p?.categories ?? [])].sort() };
  }

  @Get('public')
  open() {
    return { ok: true };
  }

  @Post('echo')
  echo(@Body() dto: EchoDto) {
    return dto;
  }

  @Get('known-error')
  known() {
    throw new HttpException({ message: 'Not allowed in this state.', code: 'invalid_state_transition' }, 409);
  }

  @Get('boom')
  boom() {
    throw new Error('connect ECONNREFUSED postgres://audit_app:s3cr3t-password@db.internal:5432 Bearer leaked-bearer-value at /srv/app/dist/x.js:1:1');
  }

  /** Answers after 1.5 s: a request still running when shutdown starts. */
  @Get('slow')
  async slow() {
    await new Promise((r) => setTimeout(r, 1_500));
    return { done: true };
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
