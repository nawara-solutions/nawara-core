import { Body, Controller, Get, HttpException, Module, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';

class EchoDto {
  @IsString()
  @MaxLength(20)
  name!: string;
}

/**
 * TEST-ONLY routes (never part of the shipped application). The foundation has no business endpoint, so its service-token guard,
 * error filter, validation, identifiers and HTTP drain are exercised through these probes, mounted next to the REAL application
 * module (the Billing Stage 1 pattern).
 */
@Controller('probe')
class ProbeController {
  @Get('service')
  @UseGuards(ServiceTokenGuard)
  service(@CallerService() caller: string) {
    return { caller };
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
    throw new Error('connect ECONNREFUSED amqp://notify:s3cr3t-password@broker.internal:5672 Bearer leaked-bearer-value at /srv/app/dist/x.js:1:1');
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
