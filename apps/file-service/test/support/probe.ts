import { Body, Controller, ForbiddenException, Get, HttpException, Inject, Module, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import type { FileConfig } from '../../src/config/file-config.js';
import { FILE_CONFIG } from '../../src/config/file-config.token.js';
import { FileRepository } from '../../src/persistence/file.repository.js';
import { PersistenceModule } from '../../src/persistence/persistence.module.js';

/** A marker the refused row carries (as a filename): it must reach neither the response nor any log line. */
export const REFUSED_ROW_MARKER = 'passport-of-refused-row';

class EchoDto {
  @IsString()
  @MaxLength(20)
  name!: string;
}

/**
 * TEST-ONLY routes (never part of the shipped application). The foundation has no business endpoint, so its service-token guard,
 * caller policy, error filter, validation, identifiers and HTTP drain are exercised through these probes, mounted next to the REAL
 * application module (the Billing Stage 1 / Notification Stage 16.3 pattern).
 */
@Controller('probe')
class ProbeController {
  constructor(@Inject(FILE_CONFIG) private readonly config: FileConfig, private readonly files: FileRepository) {}

  /** A write the schema refuses (a bidi override in the name): the raw PostgreSQL error must surface as the opaque 500 only. */
  @Get('persistence/refused')
  async refused() {
    return this.files.createUploading({
      scope: { ownerService: 'core-probe', organizationId: null },
      originalName: `${REFUSED_ROW_MARKER}\u202Efdp.exe`,
      storage: { provider: 'filesystem', keyPrefix: 'files' },
      uploadLeaseSeconds: 3_600,
      attachment: { deadlineSeconds: 86_400 },
    });
  }

  @Get('service')
  @UseGuards(ServiceTokenGuard)
  service(@CallerService() caller: string) {
    return { caller };
  }

  /** The caller identity from the token, checked against the caller policy (deny by default), as the 17.5+ routes will do. */
  @Get('policy/read')
  @UseGuards(ServiceTokenGuard)
  policyRead(@CallerService() caller: string) {
    if (!this.config.callerPolicy.allows(caller, 'read')) throw new ForbiddenException({ message: 'Operation not allowed for this caller.', code: 'operation_not_allowed' });
    return { caller, allowed: 'read' };
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
    throw new Error('connect ECONNREFUSED postgres://file_app:s3cr3t-password@db.internal:5432 Bearer leaked-bearer-value at /srv/app/dist/x.js:1:1');
  }

  /** Answers after 1.5 s: a request still running when shutdown starts. */
  @Get('slow')
  async slow() {
    await new Promise((r) => setTimeout(r, 1_500));
    return { done: true };
  }
}

@Module({ imports: [PersistenceModule], controllers: [ProbeController] })
export class ProbeModule {}
