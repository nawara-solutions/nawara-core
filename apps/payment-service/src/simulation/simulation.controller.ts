import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequireServiceOperation, ServiceOperationGuard, ServiceTokenGuard } from '@nawara/service-kit';
import { notFound } from '../errors.js';
import { SIMULATION_RESOLVE_OPERATION } from '../authorization/caller-admission.policy.js';
import { SimulationDisputeDto, SimulationInitiationDto, SimulationOutcomeDto, SimulationRefundDispatchPlanDto, SimulationRefundOutcomeDto } from './dto/simulation-command.dto.js';
import { SimulationService, type SimulationCommandResult, type SimulationDisputeCommandResult, type SimulationRefundCommandResult } from './simulation.service.js';

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

  // ───────────────────────────────────────────────────────────── Core V2 S6b (R6B-6): the simulated provider's refunds

  @Post('payments/:paymentId/refund-dispatch-plan')
  @ApiOperation({ summary: 'Set how the simulation provider answers the refund dispatches of this payment (non-production only).' })
  @ApiResponse({ status: 201, description: 'Recorded.' })
  @ApiResponse({ status: 200, description: 'Identical replay of the same commandId (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'validation_error / invalid_simulation_command' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404, description: 'not_found: no such (non-live) payment' })
  @ApiResponse({ status: 409, description: 'simulation_command_conflict' })
  async refundDispatchPlan(@Param('paymentId', new ParseUUIDPipe()) paymentId: string, @Body() dto: SimulationRefundDispatchPlanDto, @Res({ passthrough: true }) res: Response) {
    return representRefund(await this.simulation.planRefundDispatch(paymentId, dto), res);
  }

  @Post('refunds/:refundAttemptId/outcomes')
  @ApiOperation({ summary: "Set the simulation provider's answer for one refund it received and, for a notifying outcome, deliver or hold its signed notification." })
  @ApiResponse({ status: 201, description: 'Recorded (and delivered, when `delivered` is present).' })
  @ApiResponse({ status: 200, description: 'Identical replay of the same commandId (Idempotent-Replayed: true): nothing changed, nothing delivered.' })
  @ApiResponse({ status: 400, description: 'validation_error / invalid_simulation_command' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404, description: 'not_found: no refund of the simulation provider that it received' })
  @ApiResponse({ status: 409, description: 'simulation_command_conflict' })
  async refundOutcome(@Param('refundAttemptId', new ParseUUIDPipe()) refundAttemptId: string, @Body() dto: SimulationRefundOutcomeDto, @Res({ passthrough: true }) res: Response) {
    return representRefund(await this.simulation.recordRefundOutcome(refundAttemptId, dto), res);
  }

  @Post('refund-commands/:commandId/deliver')
  @HttpCode(200)
  @ApiOperation({ summary: "Deliver a refund command's notification (a held one late, or again): delayed, duplicate and out-of-order delivery." })
  @ApiResponse({ status: 200, description: 'Delivered; `delivered.status` is the webhook pipeline answer.' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409, description: 'simulation_nothing_to_deliver' })
  async deliverRefund(@Param('commandId') commandId: string, @Res({ passthrough: true }) res: Response) {
    if (!COMMAND_ID.test(commandId)) throw notFound();
    return representRefund(await this.simulation.deliverRefund(commandId), res, 200);
  }

  @Post('payments/:paymentId/disputes')
  @ApiOperation({ summary: 'Core V2 S6e-D (R6E-2): what the simulation provider reports about a dispute of a captured payment; its signed notification is delivered or held.' })
  @ApiResponse({ status: 201, description: 'Recorded (and delivered, when `delivered` is present).' })
  @ApiResponse({ status: 200, description: 'Identical replay of the same commandId (Idempotent-Replayed: true): nothing changed, nothing delivered.' })
  @ApiResponse({ status: 400, description: 'validation_error / invalid_simulation_command' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404, description: 'not_found' })
  @ApiResponse({ status: 409, description: 'simulation_command_conflict | simulation_nothing_to_dispute' })
  async dispute(@Param('paymentId', new ParseUUIDPipe()) paymentId: string, @Body() dto: SimulationDisputeDto, @Res({ passthrough: true }) res: Response) {
    return representDispute(await this.simulation.recordDispute(paymentId, dto), res);
  }

  @Post('dispute-commands/:commandId/deliver')
  @HttpCode(200)
  @ApiOperation({ summary: "Deliver a dispute command's notification (a held one late, or again): delayed, duplicate and out-of-order delivery." })
  @ApiResponse({ status: 200, description: 'Delivered; `delivered.status` is the webhook pipeline answer.' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404 })
  async deliverDispute(@Param('commandId') commandId: string, @Res({ passthrough: true }) res: Response) {
    if (!COMMAND_ID.test(commandId)) throw notFound();
    return representDispute(await this.simulation.deliverDispute(commandId), res, 200);
  }
}

function representDispute(result: SimulationDisputeCommandResult, res: Response, status?: number) {
  res.status(status ?? (result.replayed ? 200 : 201));
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  const c = result.command;
  return {
    commandId: c.commandId, paymentId: c.paymentId, attemptId: c.attemptId, providerDisputeId: c.providerDisputeId, event: c.instruction, amount: Number(c.amount),
    currency: c.currency, reason: c.reason, chargeback: c.chargebackTxnId ? { providerTxnId: c.chargebackTxnId, amount: Number(c.chargebackAmount), currency: c.chargebackCurrency } : null,
    eventId: `simd_${c.commandId}`, delivery: c.delivery, createdAt: c.createdAt, delivered: result.delivered,
  };
}

function representRefund(result: SimulationRefundCommandResult, res: Response, status?: number) {
  res.status(status ?? (result.replayed ? 200 : 201));
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  const c = result.command;
  return {
    commandId: c.commandId, kind: c.kind, paymentId: c.paymentId, refundAttemptId: c.refundAttemptId, instruction: c.instruction, failureCode: c.failureCode,
    amount: c.amount === null ? null : Number(c.amount), currency: c.currency, providerRefundId: c.providerRefundId, eventId: c.eventBody ? `simr_${c.commandId}` : null,
    delivery: c.delivery, createdAt: c.createdAt, delivered: result.delivered,
  };
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
