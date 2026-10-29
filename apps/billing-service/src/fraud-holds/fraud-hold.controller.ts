import { Body, Controller, Get, Header, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RefundOwner, RefundOwnerGuard, type VerifiedRefundOwner } from '../refunds/refund-owner.guard.js';
import { FraudHoldService, type FraudHoldRow } from './fraud-hold.service.js';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const represent = (h: FraudHoldRow) => ({
  holdId: h.id, companyId: h.companyId, platformId: h.platformId, productId: h.productId, beneficiaryUserId: h.beneficiaryUserId, reason: h.reason,
  placedBy: { userId: h.placedByUserId }, receiptId: h.receiptId, placedAt: iso(h.placedAt), reviewDeadline: iso(h.expiresAt),
});

/**
 * Core V2 S6e-H (register BIL-27; the Owner's H-1 to H-7, C-1). DEVELOPMENT AND SIMULATION ONLY. The Owner of the seller Company, with their OWN
 * bearer verified live (`RefundOwnerGuard`: `/auth/grants`; the product's Platform per request); a service token is never a human (401).
 */
@ApiTags('fraud-holds')
@Controller('billing/admin/fraud-holds')
@UseGuards(RefundOwnerGuard)
@ApiBearerAuth()
export class FraudHoldController {
  constructor(@Inject(FraudHoldService) private readonly holds: FraudHoldService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "BIL-27: place a fraud hold on one beneficiary's Personal entitlement to one product of the Owner's Company, with File evidence and a fraud_hold_place receipt.",
    description: 'Body {holdId, beneficiaryUserId, productId, reason, evidence: [{grantId, fileId}] (1 to 5), receiptSecret}. Each evidence grant must be a live File '
      + 'fraud_evidence grant to billing-service for exactly this hold (caseRef), Company and beneficiary. The receipt (the dedicated factor-only placement step-up) '
      + 'is consumed once under the hold id. The hold restricts from placement until the earlier of its release and 14 days; the same holdId repeated answers the hold.',
  })
  @ApiResponse({ status: 201, description: 'The hold.' })
  @ApiResponse({ status: 200, description: 'This holdId is already this hold.' })
  @ApiResponse({ status: 400, description: 'invalid_fraud_hold_request' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner' })
  @ApiResponse({ status: 404, description: 'not_found: no personal subscription of that beneficiary to a product of the Owner\'s Company' })
  @ApiResponse({ status: 409, description: 'fraud_hold_active | fraud_hold_conflict | fraud_hold_authorization_refused' })
  @ApiResponse({ status: 422, description: 'fraud_evidence_invalid' })
  @ApiResponse({ status: 503, description: 'fraud_evidence_unavailable | fraud_hold_authorization_unresolved (repeat the same request) | fraud_hold_unavailable (nothing changed)' })
  async place(@RefundOwner() owner: VerifiedRefundOwner, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { hold, created } = await this.holds.place(owner, (body ?? {}) as Record<string, unknown>);
    res.status(created ? 201 : 200);
    return represent(hold);
  }

  @Post(':id/release')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'BIL-27: release a hold before its 14-day deadline, with a fraud_hold_release receipt (once; a repeat answers the release).' })
  @ApiResponse({ status: 201, description: 'Released.' })
  @ApiResponse({ status: 200, description: 'Already released.' })
  @ApiResponse({ status: 400, description: 'invalid_fraud_hold_request' })
  @ApiResponse({ status: 404, description: 'not_found' })
  @ApiResponse({ status: 409, description: 'fraud_hold_not_active (its deadline passed) | fraud_hold_authorization_refused' })
  @ApiResponse({ status: 503, description: 'fraud_hold_authorization_unresolved | fraud_hold_unavailable' })
  async release(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { created } = await this.holds.release(owner, id.toLowerCase(), (body ?? {}) as Record<string, unknown>);
    res.status(created ? 201 : 200);
    return this.read(owner, id);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'BIL-27: a hold of the Owner\'s Company: its state (active, released, expired), evidence references, termination and compensation evidence.' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'not_found' })
  async read(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string) {
    const x = await this.holds.read(owner, id.toLowerCase());
    return {
      ...represent(x.hold), state: x.state, restrictsUntil: iso(x.endsAt),
      evidence: (x.evidence as { grantId: string; fileId: string; verifiedAt: Date }[]).map((e) => ({ grantId: e.grantId, fileId: e.fileId, verifiedAt: iso(e.verifiedAt) })),
      release: x.release ? { releasedAt: iso(x.release.releasedAt), releasedBy: { userId: x.release.releasedByUserId } } : null,
      expiry: x.expiry ? { expiredAt: iso(x.expiry.expiredAt), recordedAt: iso(x.expiry.recordedAt) } : null,
      compensation: x.compensation ? { deniedMs: Number(x.compensation.deniedMs), holdEndedAt: iso(x.compensation.holdEndedAt), computedAt: iso(x.compensation.computedAt) } : null,
    };
  }
}
