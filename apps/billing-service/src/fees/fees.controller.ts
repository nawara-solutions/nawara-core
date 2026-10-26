import { Body, Controller, Header, Headers, HttpCode, Param, Post, Put, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { FeeActorGuard, FeeActorKind, VerifiedFeeActor, type FeeActor } from './fee-actor.guard.js';
import { idempotencyKey, normaliseEmptyInput, normaliseFeeCapInput, normaliseFeeDelegationInput, normaliseFeeProposalInput } from './fee-input.js';
import type { CommandResult } from './fee-idempotency.js';
import { FeeService } from './fee.service.js';

class FeeCapDto {
  @ApiProperty({ description: "The maximum fixed Organization fee, in minor units of the Platform's one currency (S3d); an integer >= 0. Never a percentage." }) amount!: number;
}
class FeeDelegationDto {
  @ApiProperty({ format: 'uuid', description: "An operator of the Owner's Company with an active assignment to this Platform (Auth, live)." }) operatorUserId!: string;
}
class FeeProposalDto {
  @ApiProperty({ format: 'uuid', description: 'An Organization Auth places on this Platform (live).' }) organizationId!: string;
  @ApiProperty({ format: 'uuid', description: "An active personal subscription product of this Platform, created by the Owner (S3g)." }) productId!: string;
  @ApiProperty({ description: "The Organization fee, in minor units of the Platform's currency; an integer from 0 to the Platform's current cap." }) amount!: number;
}

const KEY = { name: 'Idempotency-Key', required: true, description: 'Required: 8-128 of [A-Za-z0-9._:-], bound to you and this exact request. The same key and request replays the first success (Idempotent-Replayed: true); a different request with it is 409 idempotency_key_conflict.' };
const R401 = { status: 401, description: 'no bearer, a bearer Auth refuses, or a SERVICE token (never forwarded to Auth)' };
const R503 = { status: 503, description: 'auth_timeout | auth_unavailable: Auth could not verify the caller; nothing was changed' };

function answer(res: Response, r: CommandResult & { replayed: boolean }) {
  res.status(r.status);
  if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return r.body;
}

/** Core V2 S3f (BIL-04, BIL-05, BIL-07): the Owner's fee administration. Owner bearer only, verified live; no step-up (A5). */
@ApiTags('fee administration')
@ApiBearerAuth()
@Controller('billing/admin')
@UseGuards(FeeActorGuard)
@FeeActorKind('owner')
export class FeeAdminController {
  constructor(private readonly fees: FeeService) {}

  @Put('platforms/:platformId/fee-caps')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Set the Platform's Organization fee cap (a new immutable version). Until a cap is set, the permitted fee is 0." })
  @ApiHeader(KEY)
  @ApiBody({ type: FeeCapDto })
  @ApiResponse({ status: 201, description: '{platformId, version, amount, currency, createdAt}: a new cap version' })
  @ApiResponse({ status: 200, description: 'the current cap already has this amount: nothing written' })
  @ApiResponse({ status: 400, description: 'invalid_fee_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner' })
  @ApiResponse({ status: 404, description: "an unknown Platform, or not in the Owner's Company (one answer)" })
  @ApiResponse({ status: 409, description: 'platform_not_configured | idempotency_key_conflict' })
  @ApiResponse(R503)
  async setCap(@VerifiedFeeActor() owner: FeeActor, @Param('platformId') platformId: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return answer(res, await this.fees.setCap(owner, idempotencyKey(key), platformId.toLowerCase(), normaliseFeeCapInput(body)));
  }

  @Post('platforms/:platformId/fee-delegations')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Delegate proposing Organization fees on this Platform to one operator (no expiry; revoked explicitly).' })
  @ApiHeader(KEY)
  @ApiBody({ type: FeeDelegationDto })
  @ApiResponse({ status: 201, description: '{id, platformId, operatorUserId, createdAt, revokedAt: null}' })
  @ApiResponse({ status: 200, description: 'that operator already holds an active delegation here: answered as it is' })
  @ApiResponse({ status: 400, description: 'invalid_fee_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner' })
  @ApiResponse({ status: 404, description: "the Platform, or the operator (unknown, another Company's, not assigned to this Platform): one answer" })
  @ApiResponse({ status: 409, description: 'platform_not_configured | idempotency_key_conflict' })
  @ApiResponse(R503)
  async grant(@VerifiedFeeActor() owner: FeeActor, @Param('platformId') platformId: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return answer(res, await this.fees.grantDelegation(owner, idempotencyKey(key), platformId.toLowerCase(), normaliseFeeDelegationInput(body)));
  }

  @Post('platforms/:platformId/fee-delegations/:delegationId/revoke')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Revoke a fee delegation (final). Pending proposals stay pending for the Owner to decide; the operator can no longer propose or withdraw.' })
  @ApiHeader(KEY)
  @ApiResponse({ status: 200, description: 'the revoked delegation (also when it was already revoked)' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner' })
  @ApiResponse({ status: 404, description: 'the Platform or the delegation: one answer' })
  @ApiResponse(R503)
  async revoke(@VerifiedFeeActor() owner: FeeActor, @Param('platformId') platformId: string, @Param('delegationId') delegationId: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    normaliseEmptyInput(body);
    return answer(res, await this.fees.revokeDelegation(owner, idempotencyKey(key), platformId.toLowerCase(), delegationId.toLowerCase()));
  }

  @Post('fee-proposals/:id/approve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Approve a pending Organization fee proposal (Owner of its Platform). The fee must be within the Platform's CURRENT cap; it then supersedes earlier approvals for future use." })
  @ApiHeader(KEY)
  @ApiResponse({ status: 200, description: 'the approved proposal (capVersion: the cap it satisfied)' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner' })
  @ApiResponse({ status: 404, description: "an unknown proposal, or another Company's: one answer" })
  @ApiResponse({ status: 409, description: 'fee_proposal_not_pending | idempotency_key_conflict' })
  @ApiResponse({ status: 422, description: "fee_above_cap: the Platform's current cap is now lower" })
  @ApiResponse(R503)
  async approve(@VerifiedFeeActor() owner: FeeActor, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    normaliseEmptyInput(body);
    return answer(res, await this.fees.decide(owner, idempotencyKey(key), id.toLowerCase(), 'approved'));
  }

  @Post('fee-proposals/:id/reject')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Reject a pending Organization fee proposal (Owner of its Platform).' })
  @ApiHeader(KEY)
  @ApiResponse({ status: 200, description: 'the rejected proposal' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner' })
  @ApiResponse({ status: 404, description: "an unknown proposal, or another Company's: one answer" })
  @ApiResponse({ status: 409, description: 'fee_proposal_not_pending | idempotency_key_conflict' })
  @ApiResponse(R503)
  async reject(@VerifiedFeeActor() owner: FeeActor, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    normaliseEmptyInput(body);
    return answer(res, await this.fees.decide(owner, idempotencyKey(key), id.toLowerCase(), 'rejected'));
  }
}

/** Core V2 S3f (BIL-06): a delegated operator proposes and withdraws Organization fees; operators never approve (S0 §1.1). */
@ApiTags('fee proposals')
@ApiBearerAuth()
@Controller('billing/platforms/:platformId/fee-proposals')
@UseGuards(FeeActorGuard)
@FeeActorKind('operator')
export class FeeProposalsController {
  constructor(private readonly fees: FeeService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Propose a Organization fee for one Organization and one personal subscription product of this Platform (delegated operator).' })
  @ApiHeader(KEY)
  @ApiBody({ type: FeeProposalDto })
  @ApiResponse({ status: 201, description: '{id, platformId, organizationId, productId, amount, currency, status: pending, proposedBy, capVersion: null, createdAt, decidedAt: null}' })
  @ApiResponse({ status: 400, description: 'invalid_fee_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an operator, or no active delegation | organization_not_permitted: an Organization not on this Platform for you' })
  @ApiResponse({ status: 404, description: 'a Platform you may not act on now' })
  @ApiResponse({ status: 409, description: 'platform_not_configured | product_not_available | fee_proposal_pending_exists | idempotency_key_conflict' })
  @ApiResponse({ status: 422, description: "fee_above_cap: above the Platform's current cap (no cap: only 0)" })
  @ApiResponse(R503)
  async propose(@VerifiedFeeActor() operator: FeeActor, @Param('platformId') platformId: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return answer(res, await this.fees.propose(operator, idempotencyKey(key), platformId.toLowerCase(), normaliseFeeProposalInput(body)));
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Withdraw your own pending proposal (while still delegated).' })
  @ApiHeader(KEY)
  @ApiResponse({ status: 200, description: 'the withdrawn proposal' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an operator, or no longer delegated' })
  @ApiResponse({ status: 404, description: "not your proposal on this Platform (unknown or another proposer's: one answer)" })
  @ApiResponse({ status: 409, description: 'fee_proposal_not_pending | idempotency_key_conflict' })
  @ApiResponse(R503)
  async withdraw(@VerifiedFeeActor() operator: FeeActor, @Param('platformId') platformId: string, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    normaliseEmptyInput(body);
    return answer(res, await this.fees.withdraw(operator, idempotencyKey(key), platformId.toLowerCase(), id.toLowerCase()));
  }
}
