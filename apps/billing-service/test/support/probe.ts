import { Body, Controller, Get, HttpException, Inject, Module, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { CallerService, DbService, ServiceOrUserGuard, ServiceTokenGuard, type CallerRequest } from '@nawara/service-kit';
import { AuthModule } from '../../src/auth/auth.module.js';

class EchoDto {
  @IsString()
  @MaxLength(20)
  name!: string;
}

/**
 * TEST-ONLY routes (never part of the shipped application). Stage 1 has no domain endpoint, so the foundation's guards, error
 * filter, validation and identifiers are exercised through these probes, mounted next to the REAL application module.
 */
@Controller('probe')
class ProbeController {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  @Get('service')
  @UseGuards(ServiceTokenGuard)
  service(@CallerService() caller: string) {
    return { caller };
  }

  @Get('either')
  @UseGuards(ServiceOrUserGuard)
  either(@Req() req: CallerRequest) {
    const c = req.caller;
    return c?.kind === 'service' ? { kind: 'service', service: c.service } : { kind: 'user', userId: c?.kind === 'user' ? c.identity.id : null };
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
    throw new Error('connect ECONNREFUSED postgres://billing_app:s3cr3t-password@db.internal:5432/billing at /srv/app/dist/x.js:1:1');
  }

  @Get('db-error')
  async dbError() {
    await this.db.query('SELECT * FROM a_table_that_does_not_exist_anywhere');
  }
}

@Module({ imports: [AuthModule], controllers: [ProbeController] })
export class ProbeModule {}
