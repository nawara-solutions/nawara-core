import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequireServiceOperation, ServiceOperationGuard, ServiceTokenGuard } from '@nawara/service-kit';
import { notFound } from '../errors.js';
import { SIMULATION_RESOLVE_OPERATION } from '../authorization/caller-admission.policy.js';
import { SimulationInitiationDto, SimulationOutcomeDto } from './dto/simulation-command.dto.js';
import { SimulationService, type SimulationCommandResult } from './simulation.service.js';

const COMMAND_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Core V2 S4f (register PAY-14; the Owner's F-S2, F-S3, F-S5): the simulation harness. Mounted ONLY when `PAYMENT_SIMULATION_PROVIDER` is
 * enabled outside production (never in production routing); a service token holding `payment.simulation.resolve` alone, never a user
 * bearer (a payer, an Organization administrator or an Owner cannot reach it).
 */
@ApiTags('simulation')
@Controller('payment/simulation')
@UseGuards(ServiceTokenGuard, ServiceOperationGuard)
@RequireServiceOperation(SIMULATION_RESOLVE_OPERATION)
@ApiBearerAuth()
export class SimulationController {
  constructor(private readonly simulation: SimulationService) {}

  @Post('payments/:paymentId/initiation')
  @ApiOperation({ summary: 'Set how the simulation provider answers the next attempts of this payment (non-production only).' })
  @ApiResponse({ status: 201, description: 'Recorded.' })
  @ApiResponse({ status: 200, description: 'Identical replay of the same commandId (Idempotent-Replayed: true): nothing changed.' })
  @ApiResponse({ status: 400, description: 'validation_error / invalid_simulation_command' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted: the caller does not hold payment.simulation.resolve' })
  @ApiResponse({ status: 404, description: 'not_found: no such (non-live) payment' })
  @ApiResponse({ status: 409, description: 'simulation_command_conflict: the commandId was used with other content' })
  async initiation(@Param('paymentId', new ParseUUIDPipe()) paymentId: string, @Body() dto: SimulationInitiationDto, @Res({ passthrough: true }) res: Response) {
    return represent(await this.simulation.planInitiation(paymentId, dto), res);
  }

  @Post('payments/:paymentId/attempts/:attemptId/outcomes')
  @ApiOperation({ summary: "Set the simulation provider's answer for one of its attempts and, for a notifying outcome, deliver or hold its signed notification." })
  @ApiResponse({ status: 201, description: 'Recorded (and delivered, when `delivered` is present).' })
  @ApiResponse({ status: 200, description: 'Identical replay of the same commandId (Idempotent-Replayed: true): nothing changed, nothing delivered.' })
  @ApiResponse({ status: 400, description: 'validation_error / invalid_simulation_command' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404, description: 'not_found: no simulation-provider attempt of this payment' })
  @ApiResponse({ status: 409, description: 'simulation_command_conflict' })
  async outcome(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Body() dto: SimulationOutcomeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return represent(await this.simulation.recordOutcome(paymentId, attemptId, dto), res);
  }

  @Post('commands/:commandId/deliver')
  @HttpCode(200)
  @ApiOperation({ summary: "Deliver a command's notification (a held one late, or again): delayed, duplicate and out-of-order delivery." })
  @ApiResponse({ status: 200, description: 'Delivered; `delivered.status` is the webhook pipeline answer.' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409, description: 'simulation_nothing_to_deliver: the command produced no notification' })
  async deliver(@Param('commandId') commandId: string, @Res({ passthrough: true }) res: Response) {
    if (!COMMAND_ID.test(commandId)) throw notFound();
    return represent(await this.simulation.deliver(commandId), res, 200);
  }
}

function represent(result: SimulationCommandResult, res: Response, status?: number) {
  res.status(status ?? (result.replayed ? 200 : 201));
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  const c = result.command;
  return {
    commandId: c.commandId,
    kind: c.kind,
    paymentId: c.paymentId,
    attemptId: c.attemptId,
    instruction: c.instruction,
    failureCode: c.failureCode,
    amount: c.amount === null ? null : Number(c.amount),
    currency: c.currency,
    providerTransactionId: c.providerTxnId,
    eventId: c.eventBody ? `sim_${c.commandId}` : null,
    delivery: c.delivery,
    createdAt: c.createdAt,
    delivered: result.delivered,
  };
}
